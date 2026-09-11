#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const server = new McpServer(
    { name: "jlink-mcp", version: VERSION },
    {
      instructions:
        "Controls a SEGGER J-Link probe to debug microcontrollers. Start with jlink_status to confirm the probe is attached, then jlink_connect with the MCU device name. Flash programming and register access need the device name so J-Link can pick the right core and flash algorithm.",
    },
  );

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is reserved for JSON-RPC, so diagnostics go to stderr only.
  console.error(`[jlink-mcp] v${VERSION} ready on stdio`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[jlink-mcp] fatal: ${message}`);
  process.exit(1);
});
