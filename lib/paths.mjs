// Where things live. Bench mode (no IS_WORKER_PROJECT): everything in this repo. Project mode (IS_WORKER_PROJECT=<dir>):
// the brief, tickets, tests, runs and state live under <dir>/.is-worker/, and the worker writes code into <dir> itself.
import { resolve, dirname } from "node:path";
import { existsSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const HOME = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PROJECT = process.env.IS_WORKER_PROJECT ? resolve(process.env.IS_WORKER_PROJECT) : null;
export const IS_WORKER_DIR = PROJECT ? resolve(PROJECT, ".is-worker") : HOME;
// One-time migration: a project folder created before 12 Oct 2026 used <project>/.pwr
if (PROJECT && !existsSync(IS_WORKER_DIR) && existsSync(resolve(PROJECT, ".pwr"))) renameSync(resolve(PROJECT, ".pwr"), IS_WORKER_DIR);
export const BRIEF_PATH = resolve(IS_WORKER_DIR, "BRIEF.md");
export const TICKETS_PATH = resolve(IS_WORKER_DIR, "tickets.jsonl");
export const TESTS_BASE = IS_WORKER_DIR; // ticket.test is relative to this
export const RUNS_DIR = resolve(IS_WORKER_DIR, "runs");
export const STATE_DIR = process.env.IS_WORKER_STATE_DIR || resolve(IS_WORKER_DIR, "state");
export const WORK_ROOT = PROJECT; // null in bench mode: each run gets its own work dir
