// End-to-end check: boots the built server over stdio and exercises it as a client.
// Requires `npm run build` first.
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
