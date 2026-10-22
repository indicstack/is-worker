"""Paid side calls -- the proposer, the stuck judge, the nudge writer -- on the user's own agent.

The mechanisms call an optimizer as `runner(prompt, model) -> (text, effective_tokens)`
(`runner.AgentRunner.optimizer_call`). In the harness that call went to the agent's model through
the harness's own routing. Here it goes through the host CLI the user is already signed in to,
so no extra API key is needed and the call is billed where the session is:

  * Claude Code: `claude -p --output-format json --tools "" --max-turns 1`, on `paid_model`
    (default `haiku`). This is a deliberate departure from the experiments, which ran every
    optimizer call on the agent's own model so overhead could not look cheaper than the arm it
    was charged to; in a user's session the cheapest capable model is the right default, and the
    ledger records the real cost either way.
  * Codex: `codex exec --json --disable hooks --ephemeral -s read-only`. Each such call carries
    Codex's full base prompt (~25k tokens, mostly cached) on the user's plan quota, which is why
    paid mechanisms default off and the Codex default injection is the free layer.
  * Copilot CLI: `copilot -p` as a pure text completion, as `te_harness.copilot.optimizer_call`
    runs it: a neutral cwd, no custom instructions, no built-in MCP server, every tool denied
    and excluded. Its usage is read from the call's own session log (`result.sessionId` ->
    `session-state/<id>/events.jsonl`), the same `session.shutdown` the ledger prices sessions
    from. The model is `copilot_model`'s choice: under BYOK, Copilot has no router to fall back
    on, and `COPILOT_MODEL=auto` -- a common setting, the subscription's router -- made the call
    answer nothing (1.0.83, an Anthropic provider).
  * Pi: `pi --print --mode json` with nothing loaded but the model -- no tools, extensions,
    skills, prompt templates, context files, MCP servers or saved session. With no `paid_model`
    it runs on the person's own default provider and model, under whatever login Pi holds for
    it (a subscription signed in with `/login`, or an API key).

Every side call runs with `TE_SIDECALL=1`, which the plugin's hook entry point treats as "do
nothing": without it the nested agent would run this plugin's hooks and recurse. A call that
returns no reply -- a CLI that is not signed in, say -- leaves one line in the plugin's
errors.log, which `te doctor` shows. Nothing here runs unless `paid` is enabled.
"""
import json
import os
import subprocess
import tempfile

from .. import trace
from . import accounting

TIMEOUT_S = 180


def _env():
    return dict(os.environ, TE_SIDECALL="1")


def _no_reply(host, out):
    """Note a side call that came back empty: the paid helpers otherwise fail silently -- seen
    with Copilot, which does not pass a BYOK provider's variables to the hooks that start it."""
    import time
    from .paths import state_root
    tail = " ".join((getattr(out, "stderr", "") or "").split())[-300:]
    try:
        root = state_root()
        os.makedirs(root, exist_ok=True)
        with open(os.path.join(root, "errors.log"), "a", encoding="utf-8") as fh:
            fh.write(f"--- {time.strftime('%Y-%m-%dT%H:%M:%S')} sidecall {host}: no reply "
                     f"(exit {getattr(out, 'returncode', '?')}) {tail}\n")
    except OSError:
        pass


_FLAGS = {}


def claude_flags(cli="claude"):
    """`--no-session-persistence` when this Claude Code has it: a side call or a measurement is
    not a session of the person's, and should not appear in their history (`claude --resume`)."""
    if cli not in _FLAGS:
        try:
            help_text = subprocess.run([cli, "--help"], capture_output=True, text=True,
                                       timeout=30, stdin=subprocess.DEVNULL).stdout
        except (OSError, subprocess.SubprocessError):
            help_text = ""
        _FLAGS[cli] = ["--no-session-persistence"] if "--no-session-persistence" in help_text else []
    return list(_FLAGS[cli])


def claude_call(prompt, model="haiku", cli="claude", timeout=TIMEOUT_S):
    cmd = [cli, "-p", "--output-format", "json", "--max-turns", "1", "--tools", "",
           "--model", model or "haiku"] + claude_flags(cli)
    with tempfile.TemporaryDirectory(prefix="te-side-") as cwd:
        out = subprocess.run(cmd, input=prompt, capture_output=True, text=True,
                             timeout=timeout, env=_env(), cwd=cwd)
    try:
        data = json.loads(out.stdout or "{}")
    except ValueError:
        data = {}
    if not data.get("result"):
        _no_reply("claude", out)
    usage = dict(data.get("usage") or {})
    usage["model"] = next(iter(data.get("modelUsage") or {}), None) or (model or "claude")
    eff, _ = accounting.effective(usage)
    return data.get("result") or "", eff


def codex_call(prompt, model="", cli="codex", timeout=TIMEOUT_S):
    cmd = [cli, "exec", "--json", "--disable", "hooks", "--ephemeral", "-s", "read-only",
           "--skip-git-repo-check"]
    if model:
        cmd += ["-m", model]
    cmd.append(prompt)
    with tempfile.TemporaryDirectory(prefix="te-side-") as cwd:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                             env=_env(), cwd=cwd)
    text, usage = "", None
    for line in (out.stdout or "").splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        item = ev.get("item") or {}
        if ev.get("type") == "item.completed" and item.get("type") == "agent_message":
            text = ev["item"].get("text") or text
        elif ev.get("type") == "turn.completed":
            usage = ev.get("usage") or usage
    if not text:
        _no_reply("codex", out)
    eff = None
    if usage:
        inp = int(usage.get("input_tokens") or 0)
        cached = int(usage.get("cached_input_tokens") or 0)
        cw = int(usage.get("cache_write_input_tokens") or 0)
        eff, _ = accounting.effective({
            "input_tokens": max(0, inp - cached - cw), "cache_read_input_tokens": cached,
            "cache_creation_input_tokens": cw,
            "output_tokens": int(usage.get("output_tokens") or 0)
            + int(usage.get("reasoning_output_tokens") or 0),
            "model": model or "codex"})
    return text, eff


# Pi before 1.0 has no `--no-mcp` (and no built-in MCP to switch off); it rejects the flag.
PI_FLAGS = ("--print", "--mode", "json", "--no-session", "--no-tools", "--no-extensions",
            "--no-skills", "--no-prompt-templates", "--no-context-files", "--offline")


def pi_call(prompt, model="", cli="pi", timeout=TIMEOUT_S):
    model_args = ["--model", model] if model else []
    with tempfile.TemporaryDirectory(prefix="te-side-") as cwd:
        for extra in (["--no-mcp"], []):
            cmd = [cli, *PI_FLAGS, *extra, *model_args, "--", prompt]
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                                 env=_env(), cwd=cwd, stdin=subprocess.DEVNULL)
            if "Unknown option: --no-mcp" not in (out.stderr or ""):
                break
    text, usage = trace.pi_json_reply(out.stdout)
    if not text:
        _no_reply("pi", out)
    eff = None
    if usage:
        usage.pop("cost_usd", None)
        usage["model"] = usage.get("model") or model or "pi"
        eff, _ = accounting.effective(usage)
    return text, eff


# Everything the Copilot CLI offers (1.0.83 names), so the completion is offered nothing; a name
# the installed CLI does not know is ignored.
COPILOT_TOOLS = ("bash", "read_bash", "write_bash", "stop_bash", "list_bash", "view", "grep",
                 "rg", "glob", "edit", "create", "str_replace", "apply_patch", "web_fetch",
                 "web_search", "ask_user", "session_store_sql", "sql", "task", "skill",
                 "list_agents", "read_agent", "write_agent", "fetch_copilot_cli_documentation")


# The cheapest capable model by BYOK provider type, in the ids that provider expects.
BYOK_DEFAULT_MODEL = {"anthropic": "claude-haiku-4-5"}


def copilot_model(paid_model="", env=None):
    """The model a Copilot side call names: `paid_model`; else a concrete model the person's
    environment names; else, under BYOK, the provider's cheap default; else "" (Copilot's own
    default, which on the subscription is its router)."""
    env = os.environ if env is None else env
    if paid_model:
        return paid_model
    for k in ("COPILOT_PROVIDER_MODEL_ID", "COPILOT_MODEL"):
        v = (env.get(k) or "").strip()
        if v and v.lower() != "auto":
            return v
    base = env.get("COPILOT_PROVIDER_BASE_URL") or ""
    if "openrouter.ai" in base:            # OpenRouter's own ids, on either wire
        return "anthropic/claude-haiku-4.5"
    if base:
        return BYOK_DEFAULT_MODEL.get((env.get("COPILOT_PROVIDER_TYPE") or "openai").lower(), "")
    return ""


def copilot_call(prompt, model="", cli="copilot", timeout=TIMEOUT_S):
    from .. import trace
    from . import hosts
    model = copilot_model(model)
    cmd = [cli, "-p", prompt, "--output-format", "json", "--no-color", "--no-auto-update",
           "--no-custom-instructions", "--disable-builtin-mcps"]
    # The person's own MCP servers too: a completion needs none of them to connect.
    for server in sorted(trace.copilot_mcp_servers() - {"github-mcp-server"}):
        cmd += ["--disable-mcp-server", server]
    for t in COPILOT_TOOLS:
        cmd += ["--deny-tool", t, "--excluded-tools", t]
    if model:
        cmd += ["--model", model]
    with tempfile.TemporaryDirectory(prefix="te-side-") as cwd:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                             env=_env(), cwd=cwd, stdin=subprocess.DEVNULL)
    text, sid = "", None
    for line in (out.stdout or "").splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("type") == "assistant.message":
            text = (ev.get("data") or {}).get("content") or text
        elif ev.get("type") == "result":
            sid = ev.get("sessionId") or sid
    if not text:
        _no_reply("copilot", out)
    eff = None
    if sid:
        log = os.path.join(hosts.copilot_home(), "session-state", sid, "events.jsonl")
        hosts.Copilot().settle(log, wait_s=5.0)
        usage = trace.copilot_session_usage(log)
        usage["model"] = usage.get("model") or model or "copilot"
        eff, _ = accounting.effective(usage)
    return text, eff


def runner_for(host_name, config):
    """The optimizer callable for this host, or None when paid calls are not allowed. Each host's
    calls go through that host's own CLI, never another agent's."""
    if not config.paid:
        return None
    model = config.paid_model
    if host_name == "pi":
        return lambda prompt, _m="agent": pi_call(prompt, model=model)
    if host_name == "codex":
        return lambda prompt, _m="agent": codex_call(prompt, model=model)
    if host_name == "copilot":
        return lambda prompt, _m="agent": copilot_call(prompt, model=model)
    return lambda prompt, _m="agent": claude_call(prompt, model=model or "haiku")
