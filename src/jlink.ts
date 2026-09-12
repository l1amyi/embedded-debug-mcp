import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, JLinkError, resolveJLinkPath } from "./config.js";

export interface RunOptions {
  /** MCU device name. Omit for probe-only commands such as `st`. */
  device?: string;
  /** SWD / JTAG / FINE / ICSP. */
  iface?: string;
  /** Interface speed in kHz. */
  speed?: number;
  /** Emulator serial number, for setups with several probes. */
  serial?: string;
  /** Prepend a `connect` command to establish a target connection. */
  connect?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /**
   * Output lines matching these patterns are excluded from failure detection.
   * Used for J-Link messages that report a state rather than an error, such as
   * "Error: CPU is not halted" in answer to `go` on a running CPU.
   */
  benignPatterns?: RegExp[];
}

export interface RunResult {
  commands: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  errors: string[];
  warnings: string[];
  ok: boolean;
}

/**
 * JLink.exe is driven through a CommanderScript file rather than an interactive
 * stdin session, for two reasons discovered while probing J-Link 7.52 on Windows:
 *
 *  1. When stdout is a pipe (not a console) the process block-buffers its
 *     output, so prompt-based synchronisation never sees the "J-Link>" prompt
 *     in time.
 *  2. If the script ends and JLink then reads stdin at EOF, it spins forever
 *     printing "Unknown command" - millions of lines, exhausting memory/disk.
 *
 * Hence: one process per call, a CRLF-terminated script file, and an `exit`
 * terminator so EOF is never reached. Timeout and output caps are belt-and-braces.
 */
const TERMINATORS = /^(exit|qc|q|quit|close)$/i;

/** Patterns that mean the invocation did not do what the caller asked. */
const HARD_FAILURE_PATTERNS: RegExp[] = [
  /Cannot connect to target/i,
  /Could not connect to target/i,
  /No J-Link found/i,
  /Unknown command/i,
  /Failed to (?:connect|open|load|program|verify|read|write|erase)/i,
  /Cannot be opened/i,
  /Could not open/i,
  /is not a valid/i,
  /ERROR:/i,
  /Script processing aborted/i,
  /emulator does not support/i,
  /not supported by the connected emulator/i,
];

/** Noise that looks like an error but is informational. */
const SOFT_PATTERNS: RegExp[] = [
  /not established yet but required for command/i,
  /J-Link connection not established/i,
];

/**
 * If J-Link asks a question, it is waiting on stdin, which means it will never
 * reach the `exit` terminator - it reads EOF from NUL and spins printing
 * "Unknown command" forever. This usually means the device name is not in
 * J-Link's device database. Detect it and kill the process immediately.
 */
const INTERACTIVE_PROMPTS: RegExp[] = [
  /Please specify device \/ core/i,
  /Please specify target interface/i,
  /Please select a device/i,
  /Please specify a device/i,
  /Please specify the target interface/i,
  /is not a valid device/i,
  /Unknown device selected/i,
];

/**
 * Flatten caller input into individual J-Link commands.
 * Blank lines and comments are dropped, and `exit`-family commands are stripped
 * so our own terminator always stays last in the generated script.
 */
export function normalizeCommands(input: string | string[]): string[] {
  const chunks = Array.isArray(input) ? input : [input];
  const out: string[] = [];
  for (const chunk of chunks) {
    for (const line of String(chunk).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("//") || trimmed.startsWith("#")) continue;
      if (TERMINATORS.test(trimmed)) continue;
      out.push(trimmed);
    }
  }
  return out;
}

function killTree(pid: number | undefined, child: { kill(signal?: NodeJS.Signals): boolean }): void {
  try {
    if (process.platform === "win32" && pid) {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    /* best effort */
  }
  const fallback = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* best effort */
    }
  }, 2000);
  fallback.unref();
}

/** Run one or more J-Link Commander commands in a single fresh process. */
export function runJLink(commands: string[], options: RunOptions = {}): Promise<RunResult> {
  const exe = resolveJLinkPath();
  const normalized = normalizeCommands(commands);
  if (normalized.length === 0) {
    throw new JLinkError("No J-Link commands to run.");
  }

  const scriptLines: string[] = [];
  if (options.connect) scriptLines.push("connect");
  scriptLines.push(...normalized);
  // J-Link Command Strings are reachable only through `exec`, and UM08001 notes
  // that in Commander they can only run *after* a connection is established.
  // Both of these are per-session settings, so they are re-sent every time.
  if (config.disableFlashBreakpoints) scriptLines.push("exec DisableFlashBPs");
  // `SetRestartOnClose` (UM08001 7.14.1.70): the default is to restart target
  // execution on close, which has to be disabled in every session because the
  // setting does not carry over between J-Link processes.
  if (config.persistHalt) scriptLines.push("exec SetRestartOnClose = 0");
  // Terminator: guarantees the process quits before it can read stdin at EOF.
  scriptLines.push("exit");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlink-mcp-"));
  const scriptPath = path.join(dir, "commands.jlink");
  // CRLF is required; a LF-only script is mis-parsed by J-Link Commander.
  fs.writeFileSync(scriptPath, `${scriptLines.join("\r\n")}\r\n`, "utf8");

  const args: string[] = [];
  if (options.device) args.push("-device", options.device);
  if (options.iface) args.push("-if", options.iface);
  if (options.speed) args.push("-speed", String(options.speed));
  if (options.serial) args.push("-SelectEmuBySN", options.serial);
  args.push("-CommanderScript", scriptPath);

  const timeoutMs = options.timeoutMs ?? config.timeoutMs;
  const maxBytes = options.maxOutputBytes ?? config.maxOutputBytes;

  return new Promise<RunResult>((resolve) => {
    const startedAt = Date.now();
    // stdin "ignore" -> NUL; the `exit` terminator means we never read it.
    const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

    let stdout = "";
    let stderr = "";
    let received = 0;
    let truncated = false;
    let timedOut = false;
    let promptDetected: string | undefined;
    let settled = false;

    const cleanup = () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, child);
    }, timeoutMs);

    const collect = (which: "out" | "err") => (chunk: Buffer) => {
      if (settled) return;
      received += chunk.length;
      if (received > maxBytes) {
        truncated = true;
        killTree(child.pid, child);
        return;
      }
      const text = chunk.toString("utf8");
      if (which === "out") stdout += text;
      else stderr += text;

      // Scan early and cheaply: a prompt means the process is blocked on stdin.
      if (promptDetected === undefined && received < 64 * 1024) {
        const combined = stdout + stderr;
        for (const pattern of INTERACTIVE_PROMPTS) {
          const match = pattern.exec(combined);
          if (match) {
            promptDetected = match[0];
            killTree(child.pid, child);
            break;
          }
        }
      }
    };

    child.stdout?.on("data", collect("out"));
    child.stderr?.on("data", collect("err"));

    const finish = (exitCode: number | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();

      stdout = stdout.replace(/\r/g, "");
      stderr = stderr.replace(/\r/g, "");
      const combined = `${stdout}\n${stderr}`;

      // Scan line by line so a benign line can be excluded wholesale. Matching
      // against the whole text would only yield the matched substring (for
      // example "Error:"), which is not enough to tell states from failures.
      const benign = options.benignPatterns ?? [];
      const errors: string[] = [];
      for (const line of combined.split("\n")) {
        if (benign.some((pattern) => pattern.test(line))) continue;
        for (const pattern of HARD_FAILURE_PATTERNS) {
          const match = pattern.exec(line);
          if (match) errors.push(match[0]);
        }
      }
      if (spawnError) errors.push(spawnError.message);
      if (timedOut) {
        errors.push(
          `Timed out after ${timeoutMs} ms: J-Link produced no completion signal. It retries a failing target connection many times before giving up, so check the device name, that the target is powered (VTref > 1 V) and that SWD/JTAG is wired. Raise JLINK_TIMEOUT_MS for large flash operations.`,
        );
      }
      if (truncated) errors.push(`Output exceeded ${maxBytes} bytes; process killed`);
      if (promptDetected) {
        errors.push(
          `J-Link requested interactive input ("${promptDetected.trim()}") which a script cannot answer - the device name is most likely not in J-Link's device database`,
        );
      }

      const warnings: string[] = [];
      for (const pattern of SOFT_PATTERNS) {
        const match = pattern.exec(combined);
        if (match) warnings.push(match[0]);
      }

      resolve({
        commands: normalized,
        stdout,
        stderr,
        exitCode,
        timedOut,
        truncated,
        durationMs: Date.now() - startedAt,
        errors: [...new Set(errors)],
        warnings: [...new Set(warnings)],
        ok: errors.length === 0 && exitCode === 0,
      });
    };

    child.on("error", (err: Error) => finish(null, err));
    child.on("close", (code: number | null) => finish(code));
  });
}
