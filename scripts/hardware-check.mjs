// Hardware-in-the-loop check for the tools that need a real MCU.
// Requires a powered target and a built server: `npm run build` first.
//
//   node scripts/hardware-check.mjs [device]
//
// Defaults to JLINK_DEVICE, then STM32F411CE. The script is destructive in the
// sense that it halts and resets the target, so do not point it at something
// that must keep running.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const device = process.argv[2] ?? process.env.JLINK_DEVICE ?? "STM32F411CE";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  stderr: "inherit",
});

const client = new Client({ name: "jlink-mcp-hardware-check", version: "0.0.0" });
await client.connect(transport);

let failures = 0;

async function call(label, name, args, check) {
  const started = Date.now();
  const result = await client.callTool({ name, arguments: args });
  const body = result.content.map((c) => c.text).join("\n");
  const ms = Date.now() - started;
  const isError = result.isError ?? false;

  let verdict = "ok";
  if (isError) verdict = "TOOL ERROR";
  else if (check) {
    const problem = check(body);
    if (problem) verdict = `UNEXPECTED: ${problem}`;
  }
  if (verdict !== "ok") failures += 1;

  console.log(`\n=== ${label} [${name}] ${ms} ms -> ${verdict}`);
  console.log(body.split("\n").slice(0, 22).join("\n"));
  return body;
}

// 1. Probe only. Confirms the J-Link is visible before anything touches the MCU.
await call("probe status", "jlink_status", {}, (b) =>
  /VTref: ([0-9.]+) V/.exec(b)?.[1] && Number.parseFloat(/VTref: ([0-9.]+) V/.exec(b)[1]) < 1
    ? "VTref below 1 V means the target is unpowered"
    : undefined,
);

// 2. Device database, no probe needed.
await call("device lookup", "jlink_devices", { query: device, exact: true }, (b) =>
  b.includes(device) ? undefined : `expected ${device} in the exact-match output`,
);

// 3. Connection.
await call("connect", "jlink_connect", { device });

// 4. Run state.
await call("cpu state", "jlink_cpu_state", { device });

// 4b. Halt, then single step a few instructions.
await call("halt", "jlink_halt", { device });
await call("single step", "jlink_step", { device, count: 4 }, (b) =>
  /Stepped 4 instruction/.test(b) ? undefined : "unexpected step report",
);

// 4c. Reset strategies. SEGGER documents that every Cortex-M reset strategy
//     halts after the reset, so the tool adds an explicit go; type 0 lets J-Link
//     choose the best strategy for the selected device.
await call("reset with RSetType 0", "jlink_reset", { device, resetType: 0 }, (b) =>
  /RSetType 0/.test(b) ? undefined : "the requested reset type was not reported",
);
await call("reset with RSetType 2", "jlink_reset", { device, resetType: 2 }, (b) =>
  /RSetType 2/.test(b) ? undefined : "the requested reset type was not reported",
);
await call("reset and halt after 300 ms", "jlink_reset", { device, haltAfterMs: 300 }, (b) =>
  /rx 300/.test(b) ? undefined : "the delayed halt was not reported",
);
await call("reset back to type 0", "jlink_reset", { device, resetType: 0 });

// 4c. Raw command escape hatch.
await call("raw exec", "jlink_exec", { device, commands: ["st"] }, (b) =>
  /Ran 1 command/.test(b) ? undefined : "unexpected exec report",
);

// 5. Registers.
await call("read registers", "jlink_read_registers", { device }, (b) =>
  /PC = 0x[0-9A-F]{8}/.test(b) ? undefined : "no PC in the output",
);

// 6. Register write plus read-back verification.
await call(
  "write registers",
  "jlink_write_registers",
  { device, registers: { R0: "0x12345678", R1: "0x0BADF00D", LR: "0x08000339" } },
  (b) => (/Confirmed by read-back/.test(b) ? undefined : "no confirmed read-back"),
);

// 7. Memory read of the reset handler.
await call(
  "read memory",
  "jlink_read_memory",
  { device, address: "0x08000000", count: 4, width: 32 },
  (b) => (/Read 4 item/.test(b) ? undefined : "unexpected item count"),
);

// 8. Memory write plus read-back verification, into a scratch RAM word.
await call(
  "write memory",
  "jlink_write_memory",
  { device, address: "0x20007F00", values: ["0xC0FFEE00", "0x12345678"], width: 32 },
  (b) => (/read-back matches all 2/.test(b) ? undefined : "read-back did not match"),
);

// 9. Breakpoints are session-scoped, so run_to sets and waits within one
//    session. Aim at the address the CPU is looping on right now: a bare-metal
//    main loop revisits it within microseconds. Note that breaking at
//    Reset_Handler itself is not reachable this way, because the connect phase
//    of each fresh J-Link process already lets the target boot.
const registerDump = await call("locate the current loop", "jlink_read_registers", { device });
const pcInLoop = /PC = 0x([0-9A-F]{8})/.exec(registerDump)?.[1];
if (pcInLoop) {
  await call(
    `run to the current PC ${pcInLoop}`,
    "jlink_run_to",
    { device, addresses: [`0x${pcInLoop}`], timeoutMs: 4000 },
    (b) => (/Breakpoint hit at/.test(b) ? undefined : "breakpoint was not hit"),
  );
} else {
  console.log("\n=== skipped run_to: no PC in the register dump");
  failures += 1;
}

// 9b. The timeout path. An address near the top of flash is never executed by a
//     small image, so this must report a miss instead of hanging or erroring.
await call(
  "run to an address that is never executed",
  "jlink_run_to",
  { device, addresses: ["0x0807FFF0"], timeoutMs: 1500 },
  (b) => (/No breakpoint was reached/.test(b) ? undefined : "expected a timeout report"),
);

// 10. Fault decode. After a clean reset this should report a clean state.
await call("fault info", "jlink_fault_info", { device }, (b) =>
  /No fault is latched/.test(b) || /fault is latched/.test(b) ? undefined : "no verdict in the output",
);

// 11. Register-name validation should reject names J-Link refuses.
const rejected = await client.callTool({
  name: "jlink_write_registers",
  arguments: { device, registers: { SP: "0x20008000" } },
});
const rejectedBody = rejected.content.map((c) => c.text).join("\n");
const rejectedOk = (rejected.isError ?? false) && /MSP or PSP/.test(rejectedBody);
if (!rejectedOk) failures += 1;
console.log(`\n=== write SP rejected -> ${rejectedOk ? "ok" : "UNEXPECTED"}`);
console.log(rejectedBody.split("\n").slice(0, 6).join("\n"));

// 12. Leave the target running rather than halted in a debug state.
await call("resume", "jlink_resume", { device });

await client.close();
console.log(`\n${failures === 0 ? "All hardware checks passed." : `${failures} check(s) need attention.`}`);
process.exit(failures === 0 ? 0 : 1);
