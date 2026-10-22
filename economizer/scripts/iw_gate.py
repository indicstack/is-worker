"""is-worker's gate in front of the token economizer's hooks.

The economizer stays silent (every hook answers "no change") until the repository has history:
IW_TE_MIN_SESSIONS finished sessions folded (default 5). History does not need the economizer to
have been on: it is Claude Code's own session transcripts, which exist either way. So at every
SessionStart the gate folds, in a detached process with no model call, any of this repository's
transcripts not folded yet (SessionEnd often never fires in the desktop app, where a session stays
open). SessionEnd always passes through, so a session that does end is folded at once. Once the
repository has enough history, every hook passes through to the economizer unchanged.

Fails open: any error answers "no change" and never breaks a session.
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "lib"))
BOOT = os.path.join(HERE, "te_bootstrap.py")
MIN_SESSIONS = int(os.environ.get("IW_TE_MIN_SESSIONS", "5"))
BACKFILL_MAX = 20


def folded(cwd):
    from tokeneconomizer.plugin.paths import repo_identity, repo_state_dir
    repo = repo_identity(cwd)
    path = os.path.join(repo_state_dir(repo, "claude"), "folded.json")
    try:
        with open(path, encoding="utf-8") as fh:
            return repo, set(json.load(fh))
    except (OSError, ValueError):
        return repo, set()


def transcripts(root):
    d = os.path.join(os.path.expanduser("~"), ".claude", "projects", re.sub(r"[^A-Za-z0-9]", "-", root))
    try:
        return sorted((os.path.join(d, n) for n in os.listdir(d) if n.endswith(".jsonl")), key=os.path.getmtime)
    except OSError:
        return []


def backfill(repo, done, current):
    todo = [p for p in transcripts(repo.root) if os.path.basename(p)[:-6] not in done and os.path.basename(p)[:-6] != current][-BACKFILL_MAX:]
    if not todo:
        return
    script = "; ".join('"{0}" "{1}" cli fold --cwd "{2}" --session "{3}" >/dev/null 2>&1'.format(
        sys.executable, BOOT, repo.root, os.path.basename(p)[:-6]) for p in todo)
    subprocess.Popen(["/bin/sh", "-c", script], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True)


def passthrough(raw):
    r = subprocess.run([sys.executable, BOOT, "hook"] + sys.argv[1:], input=raw, capture_output=True)
    sys.stdout.buffer.write(r.stdout or b"{}")


def main():
    raw = sys.stdin.buffer.read()
    try:
        ev = json.loads(raw or b"{}")
        name = ev.get("hook_event_name", "")
        if name == "SessionEnd":
            return passthrough(raw)
        repo, done = folded(ev.get("cwd") or os.getcwd())
        if name == "SessionStart":
            backfill(repo, done, ev.get("session_id", ""))
        if len(done) >= MIN_SESSIONS:
            return passthrough(raw)
    except Exception:  # fail open
        pass
    sys.stdout.write("{}")


if __name__ == "__main__":
    main()
