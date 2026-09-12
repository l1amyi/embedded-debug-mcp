import fs from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config, JLinkError } from "./config.js";
import {
  formatRegions,
  hexAddress,
  loadDeviceDatabase,
  regionContaining,
  searchDevices,
  validateDeviceName,
  type DeviceInfo,
} from "./devices.js";
import {
  buildExceptionFrame,
  decodeCfsr,
  decodeExcReturn,
  decodeHfsr,
  decodeShcsr,
  exceptionName,
  looksLikeExceptionFrame,
  type ExceptionFrame,
} from "./faults.js";
import { runJLink, type RunOptions, type RunResult } from "./jlink.js";
import {
  hex,
  normalizeRegisterName,
  parseAddress,
  parseIsHalted,
  parseMemoryDump,
  parseModeOfEntry,
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

/**
 * Reject a device name that J-Link does not have, before paying for a connect.
 * J-Link's own behaviour here is unhelpful: an unknown name either retries
 * until the timeout, or is silently swapped for a different device. The check
 * is best-effort - if the device list cannot be built at all, we proceed.
 */
async function assertDeviceName(device: string): Promise<void> {
  if (config.skipDeviceValidation) return;
  const { info, suggestions, unavailable } = await validateDeviceName(device);
  if (info) return;
  if (unavailable) {
    console.error(`[jlink-mcp] device name check skipped: ${unavailable}`);
    return;
  }
  const hint =
    suggestions.length > 0
      ? `J-Link knows similarly named devices: ${suggestions.join(", ")}.`
      : "Call jlink_devices to search J-Link's device list.";
  throw new JLinkError(
    `J-Link has no device called "${device}", so the target could not be connected.`,
    `${hint} Set JLINK_SKIP_DEVICE_VALIDATION=1 to bypass this check.`,
  );
}

/** Run a script and turn a detected failure into a tool error. */
async function execute(
  commands: string[],
  options: RunOptions,
  benign?: RegExp,
): Promise<{ result: RunResult } | ToolResult> {
  if (options.connect && options.device) await assertDeviceName(options.device);
  const result = await runJLink(commands, benign ? { ...options, benignPatterns: [benign] } : options);
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

/**
 * Firmware formats this J-Link release can load, taken from the `loadfile` entry
 * in its own `?` output. The online SEGGER knowledge base lists more (.elf,
 * .s19, .s37, .s) but documents a newer J-Link, so validating against that list
 * would accept files this install cannot actually load.
 */
const SUPPORTED_IMAGE_EXTENSIONS = [".bin", ".mot", ".hex", ".srec"];

/**
 * J-Link names memory *write* commands by width in bytes (w1/w2/w4), while the
 * *read* commands are mem8/mem16/mem32. Mixing the two conventions produces
 * "Unknown command", so keep the mapping in one place.
 */
const WRITE_COMMANDS: Record<number, string> = { 8: "w1", 16: "w2", 32: "w4" };

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

/** Multi-line device summary used by jlink_devices. */
function describeDevice(info: DeviceInfo): string {
  const lines = [
    `  ${info.name} (${info.vendor})`,
    `  Core:  ${info.core}`,
    `  Flash: ${formatRegions(info.flash)}`,
    `  RAM:   ${formatRegions(info.ram)}`,
  ];
  if (info.source === "xml") lines.push("  Listed only in JLinkDevices.xml, not in the DLL's built-in list");
  return lines.join("\n");
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
    "jlink_devices",
    {
      title: "Search J-Link's device list",
      description:
        "Look up MCU device names in J-Link's own device database, with core type, flash banks and RAM range. Use this to find the exact `device` string another tool needs. Needs no probe connection, so it works even with nothing attached. Answers come from the DLL's built-in list plus the supplementary JLinkDevices.xml; the parsed result is cached on disk until the J-Link software changes.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Full or partial device name, e.g. "STM32F411" or "nRF52840". Omit for a summary of the database.'),
        vendor: z.string().optional().describe('Restrict results to one vendor, e.g. "ST".'),
        limit: z.number().int().positive().max(200).optional().describe("Maximum results. Default 20."),
        exact: z.boolean().optional().describe("Only report an exact name match, and skip the fuzzy suggestions."),
        refresh: z
          .boolean()
          .optional()
          .describe("Re-export the list from J-Link instead of using the cached copy. Takes a few seconds."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const db = await loadDeviceDatabase({ refresh: args.refresh });
        const age = `J-Link device list: ${db.devices.length} devices, ${db.supplementaryCount} listed only in JLinkDevices.xml`;

        if (!args.query) {
          const vendors = new Map<string, number>();
          for (const device of db.devices) vendors.set(device.vendor, (vendors.get(device.vendor) ?? 0) + 1);
          const top = [...vendors.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 15)
            .map(([name, count]) => `${name} (${count})`)
            .join(", ");
          return text(
            `${age}\nSource: ${db.cached ? "cached copy, exported" : "exported now from J-Link,"} ${db.exportedAt}\n\nVendors by device count: ${top}\n\nPass \`query\` to search, for example "STM32F411".`,
          );
        }

        let matches = searchDevices(db, args.query, args.limit ?? 20);
        if (args.vendor) {
          const vendor = args.vendor.toLowerCase();
          matches = matches.filter((m) => m.device.vendor.toLowerCase() === vendor);
        }
        if (args.exact) matches = matches.filter((m) => m.device.name.toLowerCase() === args.query!.trim().toLowerCase());

        if (matches.length === 0) {
          const vendorNote = args.vendor ? ` for vendor "${args.vendor}"` : "";
          return text(`No device matching "${args.query}"${vendorNote}.\n\n${age}.`);
        }

        const exact = matches.find((m) => m.device.name.toLowerCase() === args.query!.trim().toLowerCase());
        const header = exact
          ? `Exact match:\n${describeDevice(exact.device)}`
          : `${matches.length} match(es) for "${args.query}", closest first:`;
        const shown = exact ? matches.filter((m) => m !== exact) : matches;
        const rows = shown.map((m) => `  ${m.device.name}  [${m.device.core}]  flash ${formatRegions(m.device.flash)}`);

        return text([header, ...rows, "", `(${age})`].join("\n"));
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
        "Halt the target CPU and confirm that it stopped, reporting why. By default J-Link resumes the target when the session ends, so the next tool call normally finds it running again; set JLINK_PERSIST_HALT=1 to stop that, in which case the halt survives calls that halt within their own session (jlink_read_registers, jlink_read_memory with halt=true, jlink_run_to). A bare memory read still resumes it, because mem32 performs a halt/restore cycle.",
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
      description:
        "Resume (go) the target CPU so it continues executing from where it was halted. Calling this on a CPU that is already running is reported as such rather than treated as an error.",
      inputSchema: { ...targetShape },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const options = resolveTarget(args);
        // J-Link answers `go` on a running CPU with "Error: CPU is not halted",
        // which is a state report, not a failure.
        const outcome = await execute(["g"], { ...options, connect: true }, /CPU is not halted/i);
        if (isToolResult(outcome)) return outcome;
        const alreadyRunning = /CPU is not halted/i.test(outcome.result.stdout + outcome.result.stderr);
        return text(
          alreadyRunning
            ? `CPU was already running on ${where(options)}; nothing to do.`
            : `CPU running on ${where(options)}.`,
        );
      }),
  );

  server.registerTool(
    "jlink_reset",
    {
      title: "Reset the target",
      description:
        "Reset the target MCU. On Cortex-M, J-Link halts the CPU after a reset by design (it sets VC_CORERESET in DEMCR), so this tool follows the reset with an explicit go unless haltAfterMs is set. Set haltAfterMs to halt a given time after the reset instead, which is what devices with a ROM bootloader need so the bootloader can run first. resetType overrides J-Link's reset strategy; type 0 is the documented recommendation because it lets J-Link choose the best strategy for the selected device.",
      inputSchema: {
        ...targetShape,
        haltAfterMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Halt this many milliseconds after the reset (the `rx` command) instead of running. Needed when a ROM bootloader has to run before the CPU is stopped."),
        resetType: z
          .number()
          .int()
          .min(0)
          .max(12)
          .optional()
          .describe(
            "Reset strategy for this session (RSetType). 0 normal (recommended), 1 core only, 2 reset pin, 3 connect under reset, 4 halt after bootloader, 5 halt before bootloader, 6 Kinetis, 7 ADI halt after kernel, 8 core and peripherals via SYSRESETREQ, 9 LPC1200, 10 S3FN60D, 11 LPC11A, 12 halt after bootloader via watchpoint. Verified against the installed J-Link 7.52a.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const options = resolveTarget(args);
        const commands: string[] = [];
        // RSetType is a per-session setting, so it must be sent in the same
        // script as the reset it is meant to affect.
        if (args.resetType !== undefined) commands.push(`RSetType ${args.resetType}`);
        // Every Cortex-M reset strategy halts after the reset (UM08001 "J-Link
        // Reset Strategies"), so follow a plain reset with `go` to get the
        // documented reset-and-run behaviour. `g` on an already-running CPU is a
        // benign state report rather than a failure.
        if (args.haltAfterMs !== undefined) commands.push(`rx ${args.haltAfterMs}`);
        else commands.push("r", "g");
        commands.push("IsHalted", "moe");

        const outcome = await execute(commands, { ...options, connect: true }, /CPU is not halted/i);
        if (isToolResult(outcome)) return outcome;
        const halted = parseIsHalted(outcome.result.stdout);
        const mode = parseModeOfEntry(outcome.result.stdout);
        const state = halted === undefined ? "in an unknown state" : halted ? "halted" : "running";
        const requested = [
          args.resetType !== undefined ? `RSetType ${args.resetType}` : undefined,
          args.haltAfterMs !== undefined ? `rx ${args.haltAfterMs}` : undefined,
        ].filter((part): part is string => part !== undefined);
        const suffix = requested.length > 0 ? ` (${requested.join(", ")})` : "";
        const reason = halted && mode ? ` Stopped because: ${mode}.` : "";
        return text(`Reset ${where(options)}${suffix}. The CPU is ${state}.${reason}`);
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
        const outcome = await execute(["h", count > 1 ? `s ${count}` : "s", "Regs"], {
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
        "Read memory or a peripheral register block from the target. Works while the CPU runs on most Cortex-M parts. For peripheral registers, or any block whose values must be mutually consistent, set halt=true so the CPU is stopped for the read. A bare read issues a halt/restore cycle, so it resumes a halted CPU as a side effect; halt=true leaves the CPU halted instead.",
      inputSchema: {
        ...targetShape,
        address: addressSchema.describe('Start address, e.g. "0xE000ED00" for the Cortex-M SCB.'),
        count: z.number().int().positive().describe("Number of items to read (not bytes: mem32 reads 4 bytes per item)."),
        width: widthSchema.optional().describe("Access width in bits. Default 32."),
        halt: z
          .boolean()
          .optional()
          .describe("Halt the CPU for the duration of the read, so every value comes from one instant. Default false."),
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
        const read = `mem${width} ${hex(address)}, ${args.count}`;
        const outcome = await execute(args.halt ? ["h", read] : [read], {
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
        const note = args.halt ? " The CPU was halted for the read." : "";
        return text(
          `Read ${values.length} item(s) / ${bytes} byte(s) at ${hex(address)} (mem${width}).${note}\n\n\`\`\`\n${dump}\n\`\`\`\n\n${json(
            { address: hex(address), width, count: values.length, haltedForRead: Boolean(args.halt), values },
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

        const commands = parsed.map(
          (value, index) =>
            // J-Link names its write commands by width in bytes: w1 / w2 / w4.
            `${WRITE_COMMANDS[width]} ${hex(address + index * step)}, ${hex(value, step * 2)}`,
        );
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

        const header = `Wrote ${parsed.length} value(s) at ${hex(address)} using ${WRITE_COMMANDS[width]} on ${where(options)}.`;
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
        "Halt the CPU and read the core registers (R0-R12, R14, SP, PC, XPSR and the floating point registers) plus the current program counter.",
      inputSchema: { ...targetShape },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const options = resolveTarget(args);
        const outcome = await execute(["h", "Regs"], { ...options, connect: true });
        if (isToolResult(outcome)) return outcome;

        const registers = parseRegisters(outcome.result.stdout);
        if (Object.keys(registers).length === 0) {
          return failure("Could not parse any register values from the J-Link output.", outcome.result);
        }
        const pc = registers.PC ?? registers.R15;
        const sp = registers.SP ?? registers.R13 ?? registers.MSP;
        const lr = registers.LR ?? registers.R14;
        const lines = [`Registers on ${where(options)}:`];
        if (pc) lines.push(`PC = 0x${pc}`);
        if (sp) lines.push(`SP = 0x${sp}`);
        if (lr) lines.push(`LR = 0x${lr}`);
        return text(`${lines.join("\n")}\n\n${json(registers)}`);
      }),
  );

  server.registerTool(
    "jlink_cpu_state",
    {
      title: "CPU run state",
      description:
        "Report whether the CPU is halted or running, and if it is halted, why it stopped. The mode of entry distinguishes a debugger halt from a breakpoint, a vector catch, or an exception. Cheap enough to call before and after any other operation.",
      inputSchema: { ...targetShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const options = resolveTarget(args);
        const outcome = await execute(["IsHalted", "moe"], { ...options, connect: true });
        if (isToolResult(outcome)) return outcome;

        const stdout = outcome.result.stdout;
        const halted = parseIsHalted(stdout);
        const mode = parseModeOfEntry(stdout);
        const pc = /CPU is halted \(PC = (0x[0-9A-Fa-f]+)\)/i.exec(stdout)?.[1];

        const lines: string[] = [];
        if (halted === undefined) lines.push("Could not determine the CPU state from the J-Link output.");
        else lines.push(halted ? "CPU is halted." : "CPU is running.");
        if (pc) lines.push(`PC = ${pc}`);
        if (mode) lines.push(`Stopped because: ${mode}`);

        return text(`${lines.join("\n")}\n\n${json({ halted, pc, modeOfEntry: mode })}`);
      }),
  );

  server.registerTool(
    "jlink_write_registers",
    {
      title: "Write CPU registers",
      description:
        'Write core registers on a halted CPU, then read them back and report any value that did not take. Use the names J-Link accepts: R0-R12, R14 (or LR), MSP, PSP, XPSR, CONTROL, PRIMASK and so on. "PC" is routed to the SetPC command automatically. R13, R15 and SP are rejected because J-Link refuses them - write MSP or PSP instead.',
      inputSchema: {
        ...targetShape,
        registers: z
          .record(z.string(), z.union([z.number(), z.string()]))
          .describe('Register name to value, e.g. { "R0": "0x1234", "PC": "0x08000100" }. Values are decimal or 0x-prefixed hex.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const options = resolveTarget(args);
        const entries = Object.entries(args.registers);
        if (entries.length === 0) {
          throw new JLinkError("No registers to write.", 'Pass a `registers` object, for example { "R0": "0x1" }.');
        }

        // PC has its own command; everything else goes through `wreg`.
        const setPcNames = new Set(["pc", "r15"]);
        const writes: Array<{ key: string; requested: string; value: number }> = [];
        const commands: string[] = ["h"];

        for (const [rawName, rawValue] of entries) {
          const value = parseValue(rawValue, `registers.${rawName}`);
          if (value > 0xffffffff) throw new JLinkError(`registers.${rawName} = ${value} does not fit in 32 bits.`);
          if (setPcNames.has(rawName.trim().toLowerCase())) {
            commands.push(`SetPC ${hex(value)}`);
            writes.push({ key: "PC", requested: rawName, value });
          } else {
            const name = normalizeRegisterName(rawName);
            commands.push(`wreg ${name}, ${hex(value)}`);
            writes.push({ key: name, requested: rawName, value });
          }
        }

        // Read back in the same process, so the comparison reflects the write.
        commands.push("Regs");
        const outcome = await execute(commands, { ...options, connect: true });
        if (isToolResult(outcome)) return outcome;

        const readBack = parseRegisters(outcome.result.stdout);
        const confirmed: string[] = [];
        const mismatches: Array<{ register: string; wrote: string; read: string }> = [];
        const unreported: string[] = [];

        for (const write of writes) {
          const actual = readBack[write.key];
          if (actual === undefined) {
            unreported.push(`${write.requested}=${hex(write.value)}`);
          } else if (Number.parseInt(actual, 16) === write.value) {
            confirmed.push(`${write.key}=${hex(write.value)}`);
          } else {
            mismatches.push({ register: write.requested, wrote: hex(write.value), read: `0x${actual}` });
          }
        }

        if (mismatches.length > 0) {
          return failure(
            `Read-back mismatch on ${mismatches.map((m) => m.register).join(", ")}: ${json(mismatches)}. The register may be read-only, or the CPU may constrain it (XPSR, IPSR and CONTROL are partly read-only).`,
            outcome.result,
          );
        }
        const notes = [`Wrote ${writes.length} register(s) on ${where(options)}.`];
        if (confirmed.length > 0) notes.push(`Confirmed by read-back: ${confirmed.join(", ")}`);
        if (unreported.length > 0) {
          notes.push(`Not shown in the register dump, so unverified: ${unreported.join(", ")}`);
        }
        return text(notes.join("\n"));
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
        "Program a firmware image into the target. .bin files are written at the given address (required); .hex, .mot and .srec files carry their own addresses. The device name is required because J-Link needs the matching flash algorithm. This J-Link release's loadfile supports only .bin, .mot, .hex and .srec, so an ELF has to be converted to .bin first.",
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
        if (!SUPPORTED_IMAGE_EXTENSIONS.includes(extension)) {
          throw new JLinkError(
            `Unsupported firmware extension "${extension}" for this J-Link release.`,
            `J-Link 7.52a's loadfile supports ${SUPPORTED_IMAGE_EXTENSIONS.join(", ")} only. Convert an ELF with "arm-none-eabi-objcopy -O binary in.elf out.bin" and flash the .bin at its load address.`,
          );
        }
        const isBinary = extension === ".bin";
        const address = args.address !== undefined ? parseAddress(args.address, "address") : undefined;
        if (isBinary && address === undefined) {
          throw new JLinkError(
            "A .bin image has no embedded load address, so `address` is required.",
            'Pass address, for example "0x08000000" for STM32 flash.',
          );
        }

        const commands: string[] = [];
        const eraseMode = args.eraseMode ?? "none";        if (eraseMode === "chip") commands.push("erase");
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
        if (args.reset ?? true) commands.push("r", "g");

        const outcome = await execute(commands, { ...options, connect: true }, /CPU is not halted/i);
        if (isToolResult(outcome)) return outcome;

        // Cross-check the load address against the layout J-Link reports for
        // this device. Advisory only: loading to RAM or to an external bank
        // J-Link does not model is legitimate, so this must not block.
        const info = (await validateDeviceName(options.device as string)).info;
        let addressCheck: string | undefined;
        if (info && address !== undefined) {
          if (regionContaining(info.flash, address)) {
            addressCheck = `Address check: ${hexAddress(address)} is inside a flash bank (${formatRegions(info.flash)}).`;
          } else if (regionContaining(info.ram, address)) {
            addressCheck = `Address check: ${hexAddress(address)} is in RAM, not flash. The image will live in volatile memory only (RAM: ${formatRegions(info.ram)}).`;
          } else {
            addressCheck = `Address check: ${hexAddress(address)} is outside the flash (${formatRegions(info.flash)}) and RAM (${formatRegions(info.ram)}) ranges J-Link lists for ${info.name}. Verify the address before relying on this image.`;
          }
        }

        const notes = [
          `Programmed ${file} on ${where(options)}.`,
          isBinary ? `Load address: ${hex(address as number)}` : "Load address: from the image file",
          `Erase: ${eraseMode}`,
          isBinary ? `Verify: ${verify ? "yes" : "no"}` : "Verify: not applicable to this file format",
          `Reset after flash: ${(args.reset ?? true) ? "yes" : "no"}`,
        ];
        if (info) notes.push(`Device layout: flash ${formatRegions(info.flash)}, RAM ${formatRegions(info.ram)}`);
        if (addressCheck) notes.push(addressCheck);
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
    "jlink_run_to",
    {
      title: "Run to breakpoint",
      description:
        "Set breakpoints, resume the CPU, wait until one is hit, then report where it stopped. The whole sequence runs in one J-Link session, because breakpoints are session-scoped: one set by an earlier call would not survive into this call, so setting and waiting have to happen together. If no breakpoint is reached the CPU is halted anyway (unless haltOnTimeout is false) so you can see where it got stuck.",
      inputSchema: {
        ...targetShape,
        addresses: z
          .array(addressSchema)
          .min(1)
          .max(4)
          .describe('Breakpoint addresses, e.g. ["0x08000100"]. Up to 4, all set within the same session.'),
        timeoutMs: z.number().int().positive().optional().describe("How long to wait for a breakpoint. Default 5000."),
        breakpointType: z
          .enum(["hard", "soft"])
          .optional()
          .describe(
            "hard (default) forces a hardware breakpoint, which uses a CPU comparator and never touches flash. soft forces a software breakpoint, which J-Link implements by reprogramming the containing flash sector, so it is much slower and consumes flash endurance. Only use soft when hardware comparators are unavailable.",
          ),
        haltOnTimeout: z.boolean().optional().describe("Halt the CPU when no breakpoint is reached, so PC can be read. Default true."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const options = resolveTarget(args);
        const addresses = args.addresses.map((entry, index) => parseAddress(entry, `addresses[${index}]`));
        const waitMs = args.timeoutMs ?? 5000;
        if (waitMs > 120000) throw new JLinkError(`timeoutMs ${waitMs} is too large.`, "Use at most 120000 ms.");
        const haltOnTimeout = args.haltOnTimeout ?? true;
        // SetBP takes S/H, which the SEGGER manual defines as "S: Force software
        // BP" and "H: Force hardware BP". Hardware is the default here: a
        // software breakpoint in flash makes J-Link reprogram the whole sector,
        // measured at 6538 ms versus 1764 ms for the same unreached address.
        const type = args.breakpointType === "soft" ? "S" : "H";

        const commands: string[] = ["h"];
        for (const address of addresses) commands.push(`SetBP ${hex(address)} ${type}`);
        commands.push("g", `WaitHalt ${waitMs}`, "IsHalted", "moe");
        if (haltOnTimeout) commands.push("h");
        commands.push("Regs");

        // The J-Link process has to outlive the WaitHalt window.
        const outcome = await execute(commands, { ...options, connect: true, timeoutMs: waitMs + 20000 });
        if (isToolResult(outcome)) return outcome;

        const stdout = outcome.result.stdout;
        const halted = parseIsHalted(stdout);
        const mode = parseModeOfEntry(stdout);
        const registers = parseRegisters(stdout);
        const pcHex = registers.PC ?? registers.R15;
        const pc = pcHex === undefined ? undefined : Number.parseInt(pcHex, 16);
        const hit = pc === undefined ? undefined : addresses.find((address) => address === pc);

        const lines: string[] = [];
        if (halted === true && hit !== undefined) {
          lines.push(`Breakpoint hit at ${hex(hit)} on ${where(options)}.`, `PC = ${hex(hit)}`);
        } else if (halted === true) {
          lines.push("The CPU is halted, but not at any requested breakpoint.");
          if (pc !== undefined) lines.push(`PC = ${hex(pc)}`);
          lines.push(`Requested breakpoints: ${addresses.map((address) => hex(address)).join(", ")}`);
        } else {
          lines.push(`No breakpoint was reached within ${waitMs} ms.`);
          if (pc !== undefined) {
            lines.push(
              haltOnTimeout
                ? `The CPU was halted manually, so PC = ${hex(pc)} is an arbitrary point and not a breakpoint.`
                : `The CPU is still running; PC = ${hex(pc)} was read while it ran.`,
            );
          }
        }
        if (mode) lines.push(`Stopped because: ${mode}`);
        lines.push(
          "",
          json({
            halted,
            pc: pc === undefined ? undefined : hex(pc),
            breakpoint: hit === undefined ? undefined : hex(hit),
            modeOfEntry: mode,
            registers,
          }),
        );
        return text(lines.join("\n"));
      }),
  );

  server.registerTool(
    "jlink_fault_info",
    {
      title: "Diagnose a Cortex-M fault",
      description:
        "Decode why a Cortex-M CPU faulted. Reads the System Control Block fault registers (CFSR, HFSR, MMFAR, BFAR, SHCSR) and, when the CPU sits inside a fault handler, walks the stacked exception frame to report the address of the instruction that faulted. Use this when the CPU looks stuck or PC sits in a HardFault loop.",
      inputSchema: { ...targetShape },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const options = resolveTarget(args);
        // Read registers with `Regs`, not `rreg`: `rreg` prints 0x-prefixed
        // values, which the register parser deliberately does not accept.
        const status = await execute(["h", "Regs", "mem32 0xE000ED24, 1", "mem32 0xE000ED28, 6"], {
          ...options,
          connect: true,
        });
        if (isToolResult(status)) return status;

        const words = parseMemoryDump(status.result.stdout)
          .flatMap((chunk) => chunk.values)
          .map((value) => Number.parseInt(value, 16));
        // SHCSR, then CFSR HFSR DFSR MMFAR BFAR AFSR.
        const [shcsr, cfsr, hfsr, , mmfar, bfar] = words;
        if (cfsr === undefined || hfsr === undefined) {
          return failure("Could not read the Cortex-M fault registers at 0xE000ED24.", status.result);
        }

        const registers = parseRegisters(status.result.stdout);
        const toNumber = (key: string): number | undefined =>
          registers[key] === undefined ? undefined : Number.parseInt(registers[key], 16);
        const ipsr = toNumber("IPSR") ?? 0;
        const excReturn = toNumber("R14") ?? 0;
        const psp = toNumber("PSP") ?? 0;
        const msp = toNumber("MSP") ?? 0;

        const decoded = decodeCfsr(cfsr);
        const hardfault = decodeHfsr(hfsr);
        const active = decodeShcsr(shcsr ?? 0);
        const returnInfo = decodeExcReturn(excReturn);
        const inHandler = ipsr !== 0;
        const latched = cfsr !== 0 || hfsr !== 0;

        const lines: string[] = [];
        if (!latched && !inHandler) {
          lines.push("No fault is latched and the CPU is not in an exception handler.");
        } else {
          lines.push(
            latched
              ? "A fault is latched in the System Control Block."
              : "No fault is latched, but the CPU is in an exception handler.",
          );
          if (inHandler) lines.push(`Current exception: ${exceptionName(ipsr)} (IPSR = ${ipsr})`);
          for (const entry of decoded.usage) lines.push(`UsageFault: ${entry}`);
          for (const entry of decoded.bus) lines.push(`BusFault: ${entry}`);
          for (const entry of decoded.memManage) lines.push(`MemManage: ${entry}`);
          for (const entry of hardfault) lines.push(`HardFault: ${entry}`);
          if (active.length > 0) lines.push(`SHCSR: ${active.join("; ")}`);
          if ((cfsr & (1 << 7)) !== 0) lines.push(`MemManage fault address (MMFAR) = ${hex(mmfar ?? 0)}`);
          if ((cfsr & (1 << 15)) !== 0) lines.push(`Bus fault address (BFAR) = ${hex(bfar ?? 0)}`);
          if (decoded.usage.some((entry) => entry.startsWith("UNALIGNED"))) {
            lines.push(
              "",
              "An unaligned access usually means a multi-word load or store (LDM/STM, LDRD/STRD, or a 64-bit access) against an address that is not 4-byte aligned, often via a pointer read out of a packed structure. Cortex-M0/M0+ have no hardware unaligned support at all, so any unaligned access faults there.",
            );
          }
        }

        // Recovering the exception frame only works when LR still holds the
        // EXC_RETURN value, which tells us which stack the frame was pushed onto.
        let frame: ExceptionFrame | undefined;
        let frameAddress: number | undefined;
        let frameNote: string | undefined;
        if (inHandler && !returnInfo.valid) {
          frameNote =
            "LR does not hold an EXC_RETURN value, so the handler has called a function and the exception frame cannot be located automatically. Break at the handler entry with jlink_run_to to catch the fault fresh.";
        } else if (inHandler && returnInfo.valid) {
          frameAddress = returnInfo.stack === "PSP" ? psp : msp;
          if (frameAddress === 0) {
            frameNote = `${returnInfo.stack} is zero, so the exception frame could not be located.`;
            frameAddress = undefined;
          } else {
            const frameRead = await execute(["h", `mem32 ${hex(frameAddress)}, ${returnInfo.frameWords}`], {
              ...options,
              connect: true,
            });
            if (isToolResult(frameRead)) return frameRead;
            const frameWords = parseMemoryDump(frameRead.result.stdout)
              .flatMap((chunk) => chunk.values)
              .map((value) => Number.parseInt(value, 16));
            const candidate = buildExceptionFrame(frameWords);
            if (candidate && looksLikeExceptionFrame(candidate)) {
              frame = candidate;
            } else {
              frameNote = `${returnInfo.stack} does not point at a plausible exception frame. That happens when the fault was taken in Handler mode, because the handler has since pushed onto the same stack.`;
            }
          }
        }

        if (frame) {
          lines.push(
            "",
            `Stacked exception frame at ${hex(frameAddress as number)} (${returnInfo.description}):`,
            `Faulting instruction PC = ${hex(frame.pc)}`,
            `LR at the fault = ${hex(frame.lr)}, xPSR = ${hex(frame.xpsr)}`,
            `R0-R3 = ${[frame.r0, frame.r1, frame.r2, frame.r3].map((value) => hex(value)).join(", ")}, R12 = ${hex(frame.r12)}`,
            "",
            `Read the code at ${hex(frame.pc)} to identify the faulting instruction: jlink_read_memory with width 16 at that address.`,
          );
        } else if (frameNote) {
          lines.push("", frameNote);
        }

        lines.push(
          "",
          json({
            inExceptionHandler: inHandler,
            currentException: inHandler ? exceptionName(ipsr) : null,
            latchedFault: latched,
            cfsr: hex(cfsr),
            hfsr: hex(hfsr),
            shcsr: hex(shcsr ?? 0),
            excReturn: hex(excReturn),
            activeStack: returnInfo.valid ? returnInfo.stack : "unknown",
            frame: frame ?? null,
          }),
        );
        return text(lines.join("\n"));
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
          "J-Link Commander commands accepted by jlink_exec, as reported by this",
          "J-Link release (7.52a). Commands are case-insensitive in practice.",
          "",
          "Execution and state",
          "  connect                 Connect using the configured device/interface.",
          "  h / g                   Halt / go. `g` on a running CPU answers 'Error: CPU is not halted'.",
          "  s [<n>]                 Single step n instructions (decimal).",
          "  r                       Reset. On Cortex-M J-Link halts the CPU after the reset",
          "                          (it sets VC_CORERESET in DEMCR), so `r` alone leaves the",
          "                          core stopped; follow with `g` to run. All Cortex-M reset",
          "                          strategies halt after reset by design.",
          "  rx <ms>                 Reset, then halt <ms> after the reset. For devices with a",
          "                          ROM bootloader that must run before the CPU is stopped.",
          "  IsHalted                'CPU is halted (PC = 0x...)' or 'CPU is not halted.'",
          "  WaitHalt [<ms>]         Wait for a halt. Default 1000 ms. Prints",
          "                          'CPU not halted. Timeout of <ms> ms exceeded' on expiry.",
          "  moe                     Mode of entry: why the CPU stopped.",
          "  Sleep <ms>              Pause the script, letting the target run.",
          "  RSetType <type>         Select the reset strategy. Types on this release:",
          "                            0 normal (recommended, lets J-Link pick per device)",
          "                            1 core only      2 reset pin      3 connect under reset",
          "                            4 halt after BTL 5 halt before BTL 6 Kinetis",
          "                            7 ADI halt after kernel          8 core+peripherals",
          "                            9 LPC1200       10 S3FN60D       11 LPC11A",
          "                            12 halt after BTL using WP",
          "",
          "Registers",
          "  Regs                    Dump core registers (requires a halt).",
          "  rreg <Name>             Read one register, printed as 0x-prefixed.",
          "  wreg <Name>, <Value>    Write one register.",
          "  SetPC <addr>            Set the program counter.",
          "",
          "  rreg/wreg accept R0-R12, R14, XPSR, MSP, PSP, RAZ, CFBP, APSR, EPSR,",
          "  IPSR, PRIMASK, BASEPRI, BASEPRI_MAX, FAULTMASK, CONTROL, IAPSR, EAPSR,",
          "  IEPSR, FPSCR, FPS0-FPS31 and CycleCnt. R13, R15, SP, PC and LR are",
          "  rejected ('Illegal register name'); use MSP or PSP for the stack and",
          "  SetPC for the program counter. Reading an illegal name prints the full",
          "  accepted list, which is how this list was established.",
          "",
          "Memory",
          "  mem8|mem16|mem32 [<Zone>:]<addr>, <count>   Read items. Example: mem32 0x20000000, 4",
          "  w1|w2|w4 [<Zone>:]<addr>, <data>            Write by width in BYTES. Example: w4 0x20000000, 0xDEADBEEF",
          "                          Note: reads are mem8/mem16/mem32, writes are w1/w2/w4/w8.",
          "                          A bare mem32 issues a halt/restore cycle, so it resumes a",
          "                          halted CPU as a side effect.",
          "                          <Zone> selects a memory zone / MEM-AP, e.g.",
          "                          mem32 AHB-AP (AP1):0x20000000, 4",
          "  savebin \"<file>\", <addr>, <bytes>  Dump target memory to a file on the host.",
          "  wm <words>              Write test words.",
          "",
          "Breakpoints (session-scoped: lost when the J-Link process exits)",
          "  SetBP <addr> [A/T] [S/H]   Set a breakpoint. Prints '(Handle = n)'.",
          "                             S/H means 'S: Force software BP' / 'H: Force hardware BP'.",
          "                             A software breakpoint in flash makes J-Link reprogram the",
          "                             containing flash sector, which is slow and wears the flash.",
          "                             Prefer H. J-Link uses hardware comparators first by design.",
          "                             To guarantee J-Link never reprograms flash for a breakpoint,",
          "                             run `exec DisableFlashBPs` (see below). Measured on an",
          "                             STM32F411CE: flash + S with FlashBP enabled 6517 ms, with it",
          "                             disabled 1771 ms.",
          "  ClrBP <handle>             Clear a breakpoint by handle.",
          "  SetWP / ClrWP              Watchpoints, same handle scheme.",
          "  VCatch <value>             Write the vector catch register.",
          "",
          "J-Link Command Strings (DLL settings, not Commander commands)",
          "  exec <CommandString>    Run a J-Link Command String. Examples:",
          "                            exec SetRestartOnClose = 0   stop J-Link resuming the",
          "                                                         target when the session ends.",
          "                            exec DisableFlashBPs         never use flash breakpoints;",
          "                                                         hardware comparators only.",
          "                            exec EnableFlashBPs",
          "                            exec SupplyPower = 1",
          "                            exec map exclude 0x10000000-0x3FFFFFFF",
          "                          UM08001 notes that in J-Link Commander these can only run",
          "                          AFTER a connection is established, so connection-time settings",
          "                          (e.g. SetRTTTelnetPort) have no effect here. They also apply per",
          "                          session only: a session that omits one reverts to the default.",
          "                          JLINK_PERSIST_HALT=1 and JLINK_DISABLE_FLASH_BP=1 make this",
          "                          server add the first two to every script it generates.",
          "",
          "Flash",
          "  erase [<start>, <end>]  Erase chip or an address range. Resets the device first.",
          '  loadbin "<file>", <addr>           Program a raw binary.',
          '  loadfile "<file>", [<addr>]        Program bin/mot/hex/srec. <addr> for .bin only.',
          "                          Supported extensions on this release: .bin .mot .hex .srec",
          "                          (NOT .elf or .s19, which the online KB lists for newer",
          "                          releases; conversion to .bin is required).",
          '  verifybin "<file>", <addr>         Verify a binary against flash.',
          "  unlock [<device>]       Unlock a device; needs nRESET wired.",
          "",
          "Probe and configuration",
          "  st / hwinfo             Probe, pin and hardware status.",
          "  f                       Firmware information.",
          "  Device <name>           Reselect the device and reconnect.",
          "  ExpDevList \"<file>\"      Export the built-in device list (used by jlink_devices).",
          "  speed <kHz|auto|adaptive>   Change the interface speed at runtime.",
          "  si <SWD|JTAG|...>       Switch interface at runtime.",
          "  power <On|Off> [perm]   Switch the probe's target power supply.",
          "  conf / rconf / wconf    Show or write probe configuration.",
          "  ip / usb                Connect over TCP/IP or USB.",
          "",
          "Trace, not covered by a dedicated tool",
          "  SWOStart / SWOStop / SWOStat / SWORead / SWOShow / SWOFlush / SWOSpeed",
          "  TStart / TStop / TSR / TClear / TSetSize / TSetFormat",
          "  Note: this J-Link release exposes no RTT commands to Commander; RTT needs",
          "  JLinkRTTLogger.exe or the JLinkARM DLL.",
          "",
          "Addresses and data are hexadecimal by default; the `0x` prefix is optional.",
          "Never pass exit/q/qc/quit/close: the server appends its own terminator so",
          "J-Link cannot reach EOF on stdin, which would make it spin forever.",
        ].join("\n"),
      ),
  );
}
