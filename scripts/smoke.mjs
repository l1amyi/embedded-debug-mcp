// End-to-end check: boots the built server over stdio and exercises it as a client.
// Requires `npm run build` first.
// Connect to the J-Link driver and Node's temp helpers used by the checks below.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  stderr: "inherit",
});

const client = new Client({ name: "jlink-mcp-smoke", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`);
for (const tool of tools) {
  console.log(`  - ${tool.name}`);
}

// jlink_status talks to the probe only, so it works with no MCU attached.
const status = await client.callTool({ name: "jlink_status", arguments: {} });
console.log("\njlink_status:");
console.log(status.content.map((c) => c.text).join("\n").slice(0, 1500));
console.log(`isError=${status.isError ?? false}`);

// The device database comes from J-Link's own ExpDevList, so it also needs no MCU.
const search = await client.callTool({ name: "jlink_devices", arguments: { query: "STM32F411" } });
console.log("\njlink_devices query=STM32F411:");
console.log(search.content.map((c) => c.text).join("\n").slice(0, 1200));
console.log(`isError=${search.isError ?? false}`);

// A misspelled device name must be caught before J-Link burns the timeout on it.
const typo = await client.callTool({ name: "jlink_connect", arguments: { device: "STM32F411ZZ" } });
console.log("\njlink_connect with a misspelled device:");
console.log(typo.content.map((c) => c.text).join("\n").slice(0, 600));
console.log(`isError=${typo.isError ?? false}`);

// Image formats are version-specific: this J-Link release's loadfile supports
// only .bin/.mot/.hex/.srec, so an .elf has to be refused before any flash
// operation is attempted. The file must exist, or the existence check fires
// first and the guard goes untested.
const extensionDir = fs.mkdtempSync(path.join(os.tmpdir(), "jlink-mcp-ext-"));
const elfPath = path.join(extensionDir, "fw.elf");
fs.writeFileSync(elfPath, "not really an elf");
const badExtension = await client.callTool({
  name: "jlink_flash",
  arguments: { device: "STM32F411CE", file: elfPath, address: "0x08000000" },
});
const badExtensionBody = badExtension.content.map((c) => c.text).join("\n");
console.log("\njlink_flash with a .elf image:");
console.log(badExtensionBody.slice(0, 500));
console.log(`isError=${badExtension.isError ?? false}`);
if (!(badExtension.isError && badExtensionBody.includes("Unsupported firmware extension"))) {
  console.error("FAIL: the .elf extension guard did not fire");
  process.exitCode = 1;
}
fs.rmSync(extensionDir, { recursive: true, force: true });

// Confirm failures surface as clean, actionable tool errors. An unknown command
// makes J-Link fail fast, so this needs no attached MCU and no long connect retry.
const badCommand = await client.callTool({
  name: "jlink_exec",
  arguments: { device: "STM32F407VG", commands: ["this_is_not_a_jlink_command"] },
});
console.log("\njlink_exec with an invalid command:");
console.log(badCommand.content.map((c) => c.text).join("\n").slice(0, 800));
console.log(`isError=${badCommand.isError ?? false}`);

await client.close();
