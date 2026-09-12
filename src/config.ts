import fs from "node:fs";
import path from "node:path";

/** Error with an optional actionable hint, surfaced to the MCP client. */
export class JLinkError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "JLinkError";
    this.hint = hint;
  }
}

const EXE_NAME = process.platform === "win32" ? "JLink.exe" : "JLinkExe";

const SEGGER_BASES = [
  "C:\\Program Files\\SEGGER",
  "C:\\Program Files (x86)\\SEGGER",
  "/opt/SEGGER",
  "/usr/local/SEGGER",
];

let cachedPath: string | undefined;

/** Collect candidate JLink executables from a SEGGER install root. */
function scanSeggerBase(base: string): string[] {
  const found: string[] = [];
  const direct = path.join(base, "JLink", EXE_NAME);
  if (fs.existsSync(direct)) found.push(direct);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return found;
  }
  // Versioned installs live in e.g. "JLink_V794"; sort so newer wins.
  const versioned = entries
    .filter((e) => e.isDirectory() && /^JLink/i.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
  for (const name of versioned) {
    const exe = path.join(base, name, EXE_NAME);
    if (fs.existsSync(exe)) found.push(exe);
  }
  return found;
}

/** Locate the J-Link Commander executable, honouring JLINK_PATH. */
export function resolveJLinkPath(): string {
  if (cachedPath) return cachedPath;

  const override = process.env.JLINK_PATH?.trim();
  if (override) {
    if (!fs.existsSync(override)) {
      throw new JLinkError(
        `JLINK_PATH points to "${override}", but that file does not exist.`,
        "Fix or unset JLINK_PATH.",
      );
    }
    cachedPath = override;
    return override;
  }

  const candidates = SEGGER_BASES.flatMap(scanSeggerBase);
  if (candidates.length === 0) {
    throw new JLinkError(
      `Could not find ${EXE_NAME}. Searched: ${SEGGER_BASES.join(", ")}`,
      "Install the SEGGER J-Link software, or set JLINK_PATH to the full path of JLink.exe.",
    );
  }
  cachedPath = candidates[0];
  return candidates[0];
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Server-wide defaults, overridable per tool call. */
export const config = {
  /** Default MCU device name, e.g. "STM32F407VG". */
  get device(): string | undefined {
    return process.env.JLINK_DEVICE?.trim() || undefined;
  },
  /** Default debug interface. */
  get iface(): string {
    return process.env.JLINK_INTERFACE?.trim() || "SWD";
  },
  /** Default interface speed in kHz. */
  get speed(): number {
    return envNumber("JLINK_SPEED", 4000);
  },
  /** Default probe serial number, for multi-probe setups. */
  get serial(): string | undefined {
    return process.env.JLINK_SERIAL?.trim() || undefined;
  },
  /**
   * Per-invocation timeout in milliseconds. Kept below the 60 s default request
   * timeout most MCP clients use, so the caller gets a diagnosable error rather
   * than a client-side "request timed out".
   */
  get timeoutMs(): number {
    return envNumber("JLINK_TIMEOUT_MS", 30_000);
  },
  /** Hard cap on captured J-Link output per invocation. */
  get maxOutputBytes(): number {
    return envNumber("JLINK_MAX_OUTPUT", 4 * 1024 * 1024);
  },
  /**
   * Keep the target halted after a session ends. J-Link's documented default
   * (UM08001 7.14.1.70) is to restart target execution when the connection
   * closes, which silently undoes jlink_halt and makes halt-then-inspect across
   * calls impossible. Setting this to 1 adds `exec SetRestartOnClose = 0` to
   * every generated script.
   *
   * It must be applied per session: the setting does not carry over between
   * processes, so a session that omits it resumes the target on close. Off by
   * default, because leaving a target stopped can be worse than leaving it
   * running for a device that is expected to keep working.
   */
  get persistHalt(): boolean {
    const raw = process.env.JLINK_PERSIST_HALT?.trim().toLowerCase();
    return raw === "1" || raw === "true" || raw === "yes";
  },
  /**
   * Disable the FlashBP feature, so a breakpoint in flash is always served by a
   * hardware comparator and J-Link never reprograms a flash sector.
   *
   * Measured on an STM32F411CE, an unreached breakpoint forced to software at a
   * flash address took 6517 ms with FlashBP enabled and 1771 ms with it
   * disabled. Disabling it also avoids two documented hazards of the flash path:
   * it borrows the first 2-4 KiB of RAM as a flash loader buffer, and DMA engines
   * keep running while the CPU is halted, so a DMA touching that RAM corrupts
   * the programming operation.
   */
  get disableFlashBreakpoints(): boolean {
    const raw = process.env.JLINK_DISABLE_FLASH_BP?.trim().toLowerCase();
    return raw === "1" || raw === "true" || raw === "yes";
  },
  /**
   * Skip checking device names against J-Link's own device list. Useful when
   * the list export misbehaves, or for a device only J-Link's own config knows.
   */
  get skipDeviceValidation(): boolean {
    const raw = process.env.JLINK_SKIP_DEVICE_VALIDATION?.trim().toLowerCase();
    return raw === "1" || raw === "true" || raw === "yes";
  },
};
