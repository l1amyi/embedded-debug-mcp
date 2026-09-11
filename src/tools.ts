import fs from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config, JLinkError } from "./config.js";
import { runJLink, type RunOptions, type RunResult } from "./jlink.js";
import {
  hex,
  parseAddress,
  parseMemoryDump,
  parseProbeStatus,
  parseRegisters,
  parseValue,
} from "./parse.js";

type TextContent = { type: "text"; text: string };
export type ToolResult = { content: TextContent[]; isError?: boolean };

const RAW_OUTPUT_LIMIT = 3000;

function text(body: string): ToolResult {
  return { content: [{ type: "text", text: body }] };
}

function trimRaw(raw: string): string {
  const cleaned = raw.trim();
  if (cleaned.length <= RAW_OUTPUT_LIMIT) return cleaned;
  return `${cleaned.slice(0, RAW_OUTPUT_LIMIT)}\n... [output truncated]`;
}

function json(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function failure(message: string, result?: RunResult): ToolResult {
  let body = `Error: ${message}`;
  if (result) {
    body += `\n\nCommands: ${result.commands.join(" | ")}`;
    if (result.warnings.length > 0) body += `\nWarnings: ${result.warnings.join("; ")}`;
    if (result.stdout.trim()) body += `\n\nJ-Link output:\n\`\`\`\n${trimRaw(result.stdout)}\n\`\`\``;
    if (result.stderr.trim()) body += `\n\nJ-Link stderr:\n\`\`\`\n${trimRaw(result.stderr)}\n\`\`\``;
  }
  return { content: [{ type: "text", text: body }], isError: true };
}

async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof JLinkError) {
      const hint = err.hint ? `\n\nHint: ${err.hint}` : "";
      return { content: [{ type: "text", text: `Error: ${err.message}${hint}` }], isError: true };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Unexpected error: ${message}` }], isError: true };
  }
}

/** Run a script and turn a detected failure into a tool error. */
async function execute(commands: string[], options: RunOptions): Promise<{ result: RunResult } | ToolResult> {
  const result = await runJLink(commands, options);
  if (!result.ok) {
    const reason =
      result.errors.length > 0 ? result.errors.join("; ") : `J-Link exited with code ${result.exitCode}`;
    return failure(reason, result);
  }
  return { result };
}

function isToolResult(value: { result: RunResult } | ToolResult): value is ToolResult {
  return (value as ToolResult).isError !== undefined || !("result" in value);
}

const interfaceSchema = z.enum(["SWD", "JTAG", "FINE", "ICSP"]);

const targetShape = {
  device: z
    .string()
    .min(1)
    .optional()
    .describe(
      'MCU device name exactly as known to J-Link, e.g. "STM32F407VG", "STM32F103C8", "nRF52840_xxAA". Falls back to the JLINK_DEVICE environment variable.',
    ),
  interface: interfaceSchema
    .optional()
    .describe("Debug interface. Falls back to JLINK_INTERFACE, then SWD."),
  speed: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Interface speed in kHz. Falls back to JLINK_SPEED, then 4000."),
  serial: z
    .string()
    .optional()
    .describe("J-Link probe serial number when several probes are attached. Falls back to JLINK_SERIAL."),
};

const widthSchema = z
  .union([z.literal(8), z.literal(16), z.literal(32)])
  .describe("Access width in bits: 8, 16 or 32. Must match the register width when touching peripherals.");

const addressSchema = z
  .union([z.number(), z.string()])
  .describe('Target address. "0x20000000" and "20000000" are both hexadecimal; decimal must be a JSON number.');

interface TargetArgs {
  device?: string;
  interface?: string;
  speed?: number;
  serial?: string;
}

/** Merge per-call arguments with environment defaults into run options. */
function resolveTarget(args: TargetArgs, requireDevice = true): RunOptions {
  const device = args.device ?? config.device;
  if (requireDevice && !device) {
    throw new JLinkError(
      "No target device specified, so J-Link cannot select the correct core and flash algorithm.",
      'Pass `device` (for example "STM32F407VG") or set the JLINK_DEVICE environment variable.',
    );
  }
  return {
    device,
    iface: args.interface ?? config.iface,
    speed: args.speed ?? config.speed,
    serial: args.serial ?? config.serial,
  };
}

function where(options: RunOptions): string {
  const parts = [options.device ?? "unknown device", options.iface ?? "SWD", `${options.speed ?? 0} kHz`];
  if (options.serial) parts.push(`probe ${options.serial}`);
  return parts.join(", ");
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "jlink_status",
    {
      title: "J-Link probe status",
      description:
        "Report the attached J-Link probe: serial number, firmware and hardware version, target reference voltage (VTref), current draw and pin states. Works without a connected MCU and without specifying a device - use it first to confirm the probe is present and wired up.",
      inputSchema: {
        serial: targetShape.serial,
        interface: targetShape.interface,
        speed: targetShape.speed,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const outcome = await execute(["st"], {
          iface: args.interface ?? config.iface,
          speed: args.speed ?? config.speed,
          serial: args.serial ?? config.serial,
          connect: false,
        });
        if (isToolResult(outcome)) return outcome;

        const status = parseProbeStatus(outcome.result.stdout);
        const lines = ["J-Link probe is reachable."];
        if (status.serial) lines.push(`Serial number: ${status.serial}`);
        if (status.firmware) lines.push(`Firmware: ${status.firmware}`);
        if (status.hardware) lines.push(`Hardware: ${status.hardware}`);
        if (status.vTref) lines.push(`VTref: ${status.vTref} V`);
        if (status.iTarget) lines.push(`Target current: ${status.iTarget}`);
        if (status.pins) lines.push(`Pins: ${status.pins}`);
        if (status.vTref && Number.parseFloat(status.vTref) < 1.0) {
          lines.push(
            "",
            "Note: VTref is below 1 V, which usually means the target board is powered off or not connected.",
          );
        }
        return text(`${lines.join("\n")}\n\n${json(status)}`);
      }),
  );

  server.registerTool(
    "jlink_connect",
    {
      title: "Connect to the target MCU",
      description:
        "Establish a debug connection to the target and report whether the CPU is halted or running. Run this before other operations when you are unsure of the current state.",
      inputSchema: { ...targetShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const options = resolveTarget(args);
        const outcome = await execute(["st"], { ...options, connect: true });
        if (isToolResult(outcome)) return outcome;
        const status = parseProbeStatus(outcome.result.stdout);
        return text(
          `Connected to ${where(options)}.\n\nVTref: ${status.vTref ?? "unknown"} V\n\nJ-Link output:\n\`\`\`\n${trimRaw(outcome.result.stdout)}\n\`\`\``,
        );
      }),
  );

  server.registerTool(
    "jlink_halt",
    {
      title: "Halt the CPU",
      description:
        "Halt the target CPU so memory and registers can be inspected. The CPU stays halted after this call returns.",
      inputSchema: { ...targetShape },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const options = resolveTarget(args);
        const outcome = await execute(["h"], { ...options, connect: true });
        if (isToolResult(outcome)) return outcome;
        return text(`CPU halted on ${where(options)}.\n\nJ-Link output:\n\`\`\`\n${trimRaw(outcome.result.stdout)}\n\`\`\``);
      }),
  );

  server.registerTool(
    "jlink_resume",
    {
      title: "Resume the CPU",
      description: "Resume (go) the target CPU so it continues executing from where it was halted.",
      inputSchema: { ...targetShape },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const options = resolveTarget(args);
        const outcome = await execute(["g"], { ...options, connect: true });
        if (isToolResult(outcome)) return outcome;
        return text(`CPU running on ${where(options)}.`);
      }),
  );

  server.registerTool(
    "jlink_reset",
    {
      title: "Reset the target",
      description:
        "Reset the target MCU. By default the CPU runs after reset; set haltAfterMs to use a reset-and-halt sequence so you can inspect the reset vector.",
      inputSchema: {
        ...targetShape,
        haltAfterMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("If set, reset and halt after this many milliseconds (J-Link `rx` command) instead of running."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const options = resolveTarget(args);
        const command = args.haltAfterMs ? `rx ${args.haltAfterMs}` : "r";
        const outcome = await execute([command], { ...options, connect: true });
        if (isToolResult(outcome)) return outcome;
        const mode = args.haltAfterMs ? `halted ${args.haltAfterMs} ms after reset` : "running";
        return text(`Reset ${where(options)}; CPU ${mode}.`);
      }),
  );

  server.registerTool(
    "jlink_step",
    {
      title: "Single step",
      description:
        "Halt the CPU and single step it one or more instructions, then report the new program counter.",
      inputSchema: {
        ...targetShape,
        count: z.number().int().positive().optional().describe("Number of instructions to step. Default 1."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const options = resolveTarget(args);
        const count = args.count ?? 1;
        const outcome = await execute(["h", count > 1 ? `s ${count}` : "s", "regs"], {
          ...options,
          connect: true,
        });
        if (isToolResult(outcome)) return outcome;
        const registers = parseRegisters(outcome.result.stdout);
        const pc = registers.PC ?? registers.R15;
        const ip = registers.XPSR;
        const lines = [`Stepped ${count} instruction(s) on ${where(options)}.`];
        if (pc) lines.push(`PC = 0x${pc}`);
        if (ip) lines.push(`XPSR = 0x${ip}`);
        return text(`${lines.join("\n")}\n\n${json(registers)}`);
      }),
  );

  server.registerTool(
    "jlink_read_memory",
    {
      title: "Read target memory",
      description:
        "Read memory or a peripheral register block from the target. Works while the CPU runs on most Cortex-M parts, but for peripheral registers halt the CPU first with jlink_halt to avoid reading a changing value.",
      inputSchema: {
        ...targetShape,
        address: addressSchema.describe('Start address, e.g. "0xE000ED00" for the Cortex-M SCB.'),
        count: z.number().int().positive().describe("Number of items to read (not bytes: mem32 reads 4 bytes per item)."),
        width: widthSchema.optional().describe("Access width in bits. Default 32."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const options = resolveTarget(args);
        const address = parseAddress(args.address, "address");
        const width = args.width ?? 32;
        if (args.count > 4096) {
          throw new JLinkError(`count ${args.count} is too large for a single read.`, "Read at most 4096 items per call.");
        }
        const outcome = await execute([`mem${width} ${hex(address)}, ${args.count}`], {
          ...options,
          connect: true,
        });
        if (isToolResult(outcome)) return outcome;

        const chunks = parseMemoryDump(outcome.result.stdout);
        const values = chunks.flatMap((chunk) => chunk.values);
        if (values.length === 0) {
          return failure(
            "J-Link returned no memory values. The address may be unmapped or the target may have rejected the access.",
            outcome.result,
          );
        }
        const dump = chunks.map((chunk) => `${chunk.address}  ${chunk.values.join(" ")}`).join("\n");
        const bytes = (width / 8) * values.length;
        return text(
          `Read ${values.length} item(s) / ${bytes} byte(s) at ${hex(address)} (mem${width}).\n\n\`\`\`\n${dump}\n\`\`\`\n\n${json(
            { address: hex(address), width, count: values.length, values },
          )}`,
        );
      }),
  );

  server.registerTool(
    "jlink_write_memory",
    {
      title: "Write target memory",
      description:
        "Write one or more values to memory or peripheral registers, then read back to confirm. Each value is written at address + index * (width / 8).",
      inputSchema: {
        ...targetShape,
        address: addressSchema.describe("Start address to write."),
        values: z.array(z.union([z.number(), z.string()])).min(1).describe("Values to write, decimal numbers or hex strings."),
        width: widthSchema.optional().describe("Access width in bits. Default 32."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const options = resolveTarget(args);
        const address = parseAddress(args.address, "address");
        const width = args.width ?? 32;
        const step = width / 8;
        const parsed = args.values.map((value, index) => parseValue(value, `values[${index}]`));

        for (const [index, value] of parsed.entries()) {
          const limit = 2 ** width;
          if (value >= limit) {
            throw new JLinkError(`values[${index}] = ${value} does not fit in ${width} bits.`);
          }
        }

        const commands = parsed.map((value, index) => `w${width} ${hex(address + index * step)}, ${hex(value, step * 2)}`);
        // Read back in the same process so the verification reflects the write.
        commands.push(`mem${width} ${hex(address)}, ${parsed.length}`);

        const outcome = await execute(commands, { ...options, connect: true });
        if (isToolResult(outcome)) return outcome;

        const readBack = parseMemoryDump(outcome.result.stdout).flatMap((chunk) => chunk.values);
        const mismatches: Array<{ index: number; address: string; wrote: string; read: string }> = [];
        parsed.forEach((value, index) => {
          const actual = readBack[index];
          const expected = value.toString(16).toUpperCase().padStart(step * 2, "0");
          if (actual !== undefined && actual !== expected) {
            mismatches.push({ index, address: hex(address + index * step), wrote: expected, read: actual });
          }
        });

        const header = `Wrote ${parsed.length} value(s) at ${hex(address)} (w${width}) on ${where(options)}.`;
        if (readBack.length === 0) {
          return text(`${header}\n\nVerification: no read-back data returned; the write may still have succeeded.`);
        }
        if (mismatches.length > 0) {
          return failure(
            `Read-back verification failed for ${mismatches.length} value(s). The region may be read-only, write-protected, or not real memory.`,
            outcome.result,
          );
        }
        return text(`${header}\n\nVerification: read-back matches all ${parsed.length} value(s).`);
      }),
  );

  server.registerTool(
    "jlink_read_registers",
    {
      title: "Read CPU registers",
      description:
        "Halt the CPU and read the core registers (R0-R15, SP, LR, PC, XPSR and any floating point registers) plus the current program counter.",
      inputSchema: { ...targetShape },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const options = resolveTarget(args);
        const outcome = await execute(["h", "regs"], { ...options, connect: true });
        if (isToolResult(outcome)) return outcome;

        const registers = parseRegisters(outcome.result.stdout);
        if (Object.keys(registers).length === 0) {
          return failure("Could not parse any register values from the J-Link output.", outcome.result);
        }
        const pc = registers.PC ?? registers.R15;
        const sp = registers.SP ?? registers.R13 ?? registers.MSP;
        const lines = [`Registers on ${where(options)}:`];
        if (pc) lines.push(`PC = 0x${pc}`);
        if (sp) lines.push(`SP = 0x${sp}`);
        return text(`${lines.join("\n")}\n\n${json(registers)}`);
      }),
  );

  server.registerTool(
    "jlink_erase",
    {
      title: "Erase flash",
      description:
        "Erase the target flash. Without a range this performs a full chip erase; with start and end addresses only the overlapping sectors are erased.",
      inputSchema: {
        ...targetShape,
        start: addressSchema.optional().describe("Start address of the range to erase."),
        end: addressSchema.optional().describe("End address of the range to erase."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const options = resolveTarget(args);
        if ((args.start === undefined) !== (args.end === undefined)) {
          throw new JLinkError("Provide both start and end, or neither for a full chip erase.");
        }
        const command =
          args.start !== undefined && args.end !== undefined
            ? `erase ${hex(parseAddress(args.start, "start"))}, ${hex(parseAddress(args.end, "end"))}`
            : "erase";
        const outcome = await execute([command], { ...options, connect: true });
        if (isToolResult(outcome)) return outcome;
        const scope = args.start !== undefined ? "selected range" : "entire chip";
        return text(`Erased ${scope} on ${where(options)}.\n\nJ-Link output:\n\`\`\`\n${trimRaw(outcome.result.stdout)}\n\`\`\``);
      }),
  );

  server.registerTool(
    "jlink_flash",
    {
      title: "Flash firmware",
      description:
        "Program a firmware image into the target. .bin files are written at the given address (required); .hex, .elf, .s19 and .srec files carry their own addresses. The device name is required because J-Link needs the matching flash algorithm.",
      inputSchema: {
        ...targetShape,
        file: z.string().min(1).describe("Absolute path to the firmware image."),
        address: addressSchema
          .optional()
          .describe("Load address. Required for .bin files, ignored for formats that carry addresses."),
        eraseMode: z
          .enum(["none", "chip", "range"])
          .optional()
          .describe("Erase before programming. Default none: J-Link erases the touched sectors automatically."),
        eraseStart: addressSchema.optional().describe("Range erase start address (eraseMode=range)."),
        eraseEnd: addressSchema.optional().describe("Range erase end address (eraseMode=range)."),
        verify: z.boolean().optional().describe("Verify after programming. Default true; only supported for .bin."),
        reset: z.boolean().optional().describe("Reset and run after programming. Default true."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const options = resolveTarget(args);
        const file = args.file;
        if (!fs.existsSync(file)) {
          throw new JLinkError(
            `Firmware file not found: ${file}`,
            "Pass an absolute path that exists on the machine running this MCP server.",
          );
        }

        const extension = file.slice(file.lastIndexOf(".")).toLowerCase();
        const isBinary = extension === ".bin";
        const address = args.address !== undefined ? parseAddress(args.address, "address") : undefined;
        if (isBinary && address === undefined) {
          throw new JLinkError(
            "A .bin image has no embedded load address, so `address` is required.",
            'Pass address, for example "0x08000000" for STM32 flash.',
          );
        }

        const commands: string[] = [];
        const eraseMode = args.eraseMode ?? "none";
        if (eraseMode === "chip") commands.push("erase");
        if (eraseMode === "range") {
          if (args.eraseStart === undefined || args.eraseEnd === undefined) {
            throw new JLinkError("eraseMode=range requires both eraseStart and eraseEnd.");
          }
          commands.push(
            `erase ${hex(parseAddress(args.eraseStart, "eraseStart"))}, ${hex(parseAddress(args.eraseEnd, "eraseEnd"))}`,
          );
        }
        commands.push(isBinary ? `loadbin "${file}", ${hex(address as number)}` : `loadfile "${file}"`);
        const verify = args.verify ?? true;
        if (verify && isBinary) commands.push(`verifybin "${file}", ${hex(address as number)}`);
        if (args.reset ?? true) commands.push("r");

        const outcome = await execute(commands, { ...options, connect: true });
        if (isToolResult(outcome)) return outcome;

        const notes = [
          `Programmed ${file} on ${where(options)}.`,
          isBinary ? `Load address: ${hex(address as number)}` : "Load address: from the image file",
          `Erase: ${eraseMode}`,
          isBinary ? `Verify: ${verify ? "yes" : "no"}` : "Verify: not applicable to this file format",
          `Reset after flash: ${args.reset ?? true ? "yes" : "no"}`,
        ];
        return text(notes.join("\n"));
      }),
  );

  server.registerTool(
    "jlink_exec",
    {
      title: "Run raw J-Link commands",
      description:
        "Escape hatch: run arbitrary J-Link Commander commands in one session, in order. Use it for anything not covered by the dedicated tools (register writes, `SaveBin`, `SetRTTAddr`, `loadbin` variants, and so on). Call jlink_command_reference for the supported command list.",
      inputSchema: {
        ...targetShape,
        commands: z
          .array(z.string())
          .min(1)
          .describe('J-Link Commander commands, e.g. ["h", "w4 0x20000000, 0xDEADBEEF", "mem32 0x20000000, 1"].'),
        connect: z.boolean().optional().describe("Prepend `connect` to establish a target connection. Default true."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const options = resolveTarget(args, args.connect ?? true);
        const outcome = await execute(args.commands, { ...options, connect: args.connect ?? true });
        if (isToolResult(outcome)) return outcome;
        return text(
          `Ran ${outcome.result.commands.length} command(s) in ${outcome.result.durationMs} ms.\n\n\`\`\`\n${trimRaw(
            outcome.result.stdout,
          )}\n\`\`\``,
        );
      }),
  );

  server.registerTool(
    "jlink_command_reference",
    {
      title: "J-Link command reference",
      description:
        "Return the J-Link Commander commands this setup supports, for use with jlink_exec. Static reference text; does not touch the probe.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      text(
        [
          "Frequently used J-Link Commander commands (pass these to jlink_exec):",
          "",
          "  connect                 Connect to the target using the configured device/interface.",
          "  h / g                   Halt / go (resume).",
          "  s [n]                   Single step n instructions.",
          "  r / rx <ms>             Reset (run) / reset and halt after ms.",
          "  IsHalted                Report whether the CPU is halted.",
          "  WaitHalt [ms]           Wait until the CPU is halted.",
          "  regs                    Dump core registers (requires halt).",
          "  mem8|mem16|mem32 <addr>, <count>   Read memory. Example: mem32 0x20000000, 4",
          "  w1|w2|w4 <addr>, <data>            Write memory. Example: w4 0x20000000, 0xDEADBEEF",
          "  erase [<start>, <end>]  Erase chip or address range.",
          '  loadbin "<file>", <addr>           Program a raw binary.',
          '  loadfile "<file>"                  Program hex/elf/srec.',
          '  verifybin "<file>", <addr>         Verify a raw binary against flash.',
          '  savebin "<file>", <addr>, <len>    Dump target memory to a file.',
          "  st                      Show probe and pin status.",
          "  f                       Show firmware/probe information.",
          "  speed <kHz>             Change interface speed at runtime.",
          "  si <SWD|JTAG>           Switch interface at runtime.",
          "",
          "Addresses and data are hexadecimal by default; the `0x` prefix is optional.",
        ].join("\n"),
      ),
  );
}
