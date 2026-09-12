// A full debug session driven entirely through the MCP, with every reported
// address resolved back to the source line it came from.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const device = "STM32F411CE";
const elf = "D:/project/embedded-debug-mcp/test_project/build/Debug/test_project.elf";
const LOOP = "0x0800112e"; // main.c:126  led_set(1);
// HAL_RCC_OscConfig(RCC_OscInitTypeDef *): reads the struct through R0, so a bad
// pointer produces a *precise* bus fault with a recoverable exception frame. A
// write would be buffered and reported as IMPRECISERR, which loses the PC.
const HAL_RCC_OSC_CONFIG = "0x08000278";

const client = new Client({ name: "debug-session", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "inherit" }));

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: { device, elf, ...args } });
  const body = r.content.map((c) => c.text).join("\n");
  return { isError: r.isError ?? false, head: body.split("```json")[0].trim() };
}
const step = async (title, name, args) => {
  console.log(`\n${"─".repeat(72)}\n▸ ${title}\n${"─".repeat(72)}`);
  const { isError, head } = await call(name, args);
  console.log(head || "(no text)");
  if (isError) console.log("!! tool error");
};

console.log("Debug session over MCP — every address resolved to a source line");
console.log(`ELF: ${elf}`);

await step("1. Break in the main loop and see where it lands", "jlink_run_to", {
  addresses: [LOOP],
  timeoutMs: 3000,
});

await step("2. Read registers in a fresh session", "jlink_read_registers", {});
console.log("\n(note: every tool call is a new J-Link session, and J-Link resumes the\n" +
  " target when a session closes, so this is wherever the CPU got to. The\n" +
  " registers *at* the breakpoint came back with the breakpoint itself -- see\n" +
  " the JSON of step 1.)");

await step("3. Single step three instructions and watch the line move", "jlink_step", { count: 3 });

await step("4. Restore the target before the next experiment", "jlink_reset", {});

// ---------------------------------------------------------------------------
// A genuine fault. Without an ELF the report is only an address; with one it
// names the line in the HAL driver that dereferenced the bad pointer, which is
// the whole point of carrying debug information into a debug session.
await step("5. Aim HAL_RCC_OscConfig at a bogus struct pointer", "jlink_write_registers", {
  registers: { PC: HAL_RCC_OSC_CONFIG, R0: "0xDEADBEE0" },
});
await step("6. Let it run", "jlink_resume", {});
await step("7. Diagnose the fault", "jlink_fault_info", {});

await step("8. Restore the target", "jlink_reset", {});

await client.close();
