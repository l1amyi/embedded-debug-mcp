// Flash the test_project LED blink and verify it from the debugger.
//
//   HEX=<path to test_project.hex> node scripts/verify-blink.mjs
//
// The LED itself cannot be observed from here, but PC13 can: sample GPIOC->ODR
// inside a single J-Link session (so the sampling rate is not limited by the
// one-process-per-call design) and check that bit 13 toggles.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const device = "STM32F411CE";
const GPIOC_ODR = 0x40020814; // GPIOC base 0x40020800 + ODR offset 0x14
const LED_BIT = 1 << 13;
const HEX = process.env.HEX;

const client = new Client({ name: "blink-verify", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "inherit" }),
);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: { device, ...args } });
  return { isError: r.isError ?? false, body: r.content.map((c) => c.text).join("\n") };
};

console.log(`=== flashing ${HEX}`);
const flash = await call("jlink_flash", { file: HEX, eraseMode: "chip" });
console.log(flash.body.split("\n").slice(0, 6).join("\n"));
if (flash.isError) {
  console.log("flash failed");
  await client.close();
  process.exit(1);
}

// Sample the output register inside one session. `Sleep` lets the target run
// between reads, so this is a real timeline rather than 20 fresh connections.
const SAMPLE_MS = 100;
const SAMPLES = 24;
const commands = [];
for (let i = 0; i < SAMPLES; i += 1) {
  commands.push(`mem32 0x${GPIOC_ODR.toString(16)}, 1`);
  if (i < SAMPLES - 1) commands.push(`Sleep ${SAMPLE_MS}`);
}
console.log(`\n=== sampling GPIOC->ODR every ${SAMPLE_MS} ms for ${(SAMPLES * SAMPLE_MS) / 1000}s`);
const sampled = await call("jlink_exec", { commands });
if (sampled.isError) {
  console.log(sampled.body.slice(0, 800));
  await client.close();
  process.exit(1);
}

const values = [...sampled.body.matchAll(/^40020814 = ([0-9A-F]{8})/gim)].map((m) => Number.parseInt(m[1], 16));
console.log(`parsed ${values.length} samples`);
if (values.length < 8) {
  console.log(sampled.body.slice(0, 1200));
  await client.close();
  process.exit(1);
}

const ledOn = values.map((v) => ((v & LED_BIT) === 0 ? "*" : ".")); // active low
console.log(`ODR    : ${values.map((v) => (v & LED_BIT ? "1" : "0")).join(" ")}`);
console.log(`LED    : ${ledOn.join(" ")}   (* = lit, active low)`);

// Walk the timeline and record how long each state lasted.
const runs = [];
let current = (values[0] & LED_BIT) === 0;
let length = 1;
for (let i = 1; i < values.length; i += 1) {
  const on = (values[i] & LED_BIT) === 0;
  if (on === current) length += 1;
  else {
    runs.push({ on: current, ms: length * SAMPLE_MS });
    current = on;
    length = 1;
  }
}
runs.push({ on: current, ms: length * SAMPLE_MS });

const transitions = runs.length - 1;
console.log(`\ntransitions: ${transitions}`);
for (const run of runs) console.log(`  LED ${run.on ? "on " : "off"} for ~${run.ms} ms`);

// Ignore the first and last run: they are cut off by the sampling window.
const middle = runs.slice(1, -1).map((r) => r.ms);
const toggles = values.some((v) => (v & LED_BIT) !== 0) && values.some((v) => (v & LED_BIT) === 0);
const plausible = middle.length > 0 && middle.every((ms) => ms >= 150 && ms <= 400);

console.log("\n=== verdict");
console.log(`  PC13 toggles at all            : ${toggles ? "yes" : "NO"}`);
console.log(`  half period near 250 ms        : ${plausible ? "yes" : "NO"} (${middle.join(", ")} ms)`);
console.log(`  ${toggles && plausible ? "PASS" : "FAIL"}`);

await client.close();
process.exit(toggles && plausible ? 0 : 1);
