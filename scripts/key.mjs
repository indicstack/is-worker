// Stores the IndicStack API key in ~/.is-worker/keys.env (mode 600) from a hidden prompt. Never echoes it.
import { createInterface } from "node:readline";
import { writeKey, keyStatus } from "../lib/keys.mjs";
const arm = process.argv[2] || "A";
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
process.stdout.write(`Paste your ${arm === "A" ? "IndicStack" : "arm " + arm} API key (typing is hidden), then Enter: `);
const mute = process.stdout.write.bind(process.stdout);
rl._writeToOutput = () => {};
rl.question("", (v) => {
  rl.close(); mute("\n");
  const key = v.trim();
  if (!key) { console.log("nothing entered; key unchanged"); process.exit(1); }
  writeKey(arm, key);
  const st = keyStatus();
  console.log(`saved to ${st.path} (mode ${st.mode}); length ${key.length}`);
});
