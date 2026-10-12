import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const work = process.env.IS_WORKER_WORK;
if (!work) throw new Error("IS_WORKER_WORK env var must point at the run's work dir");
export const WORK = resolve(work);
export const load = (rel) => import(pathToFileURL(resolve(WORK, rel)).href);
export const C = await load("game/constants.mjs");

// A recording 2d context for render tests.
export function fakeCtx() {
  const calls = [];
  const ctx = {
    calls,
    fillStyle: "#000", font: "", textAlign: "left", textBaseline: "alphabetic",
    fillRect: (...a) => calls.push({ op: "fillRect", args: a, style: ctx.fillStyle }),
    fillText: (...a) => calls.push({ op: "fillText", args: a }),
    strokeRect: (...a) => calls.push({ op: "strokeRect", args: a }),
    save: () => {}, restore: () => {}, beginPath: () => {}, clearRect: () => {},
  };
  return ctx;
}
export function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}
