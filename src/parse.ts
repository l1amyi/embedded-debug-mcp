import { JLinkError } from "./config.js";

export interface MemoryChunk {
  address: string;
  values: string[];
}

/**
 * Parse `mem8` / `mem16` / `mem32` output, e.g.
 *   E000ED00 = 410FC241 00000000
 */
export function parseMemoryDump(text: string): MemoryChunk[] {
  const chunks: MemoryChunk[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*([0-9A-Fa-f]{4,16})\s*=\s*([0-9A-Fa-f][0-9A-Fa-f\s]*)$/.exec(line);
    if (!match) continue;
    const values = match[2].trim().split(/\s+/).map((v) => v.toUpperCase());
    if (values.length === 0) continue;
    chunks.push({ address: match[1].toUpperCase(), values });
  }
  return chunks;
}

/**
 * Parse `Regs` / `h` output. Real output mixes several shapes:
 *
 *   PC = 08004336, CycleCnt = 00038B41
 *   SP(R13)= 200003E0, MSP= 20007DC8, PSP= 200003E0, R14(LR) = 08004495
 *   XPSR = 61000000: APSR = nZCvq, EPSR = 01000000, IPSR = 000 (NoException)
 *
 * A trailing `\b` keeps probe lines such as `ITarget=64mA` and `VTref=3.3V`
 * from being mistaken for registers, since neither is followed by a boundary.
 * Where a register is printed with an alias, both names are recorded.
 */
export function parseRegisters(text: string): Record<string, string> {
  const regs: Record<string, string> = {};
  const pattern =
    /(?:^|[\s,;])([A-Za-z][A-Za-z0-9_]{0,7})\s*(?:\(([A-Za-z][A-Za-z0-9_]{0,7})\))?\s*=\s*([0-9A-Fa-f]{2,8})\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const value = match[3].toUpperCase();
    regs[match[1]] = value;
    if (match[2]) regs[match[2]] = value;
  }
  return regs;
}

/** `IsHalted` reports one of two sentences; undefined means it said neither. */
export function parseIsHalted(text: string): boolean | undefined {
  if (/CPU is not halted/i.test(text)) return false;
  if (/CPU is halted/i.test(text)) return true;
  return undefined;
}

/** `moe` prints "CPU halted because <reason>" / "CPU halted due to <reason>". */
export function parseModeOfEntry(text: string): string | undefined {
  const match = /CPU halted (?:because|due to)\s+([^.\n]+)/i.exec(text);
  return match ? match[1].trim() : undefined;
}

/**
 * Register names `rreg`/`wreg` accept, as printed by J-Link itself when given
 * an illegal name. Verified against J-Link 7.52 on a Cortex-M4.
 */
const REGISTERS: string[] = [
  ...Array.from({ length: 13 }, (_, i) => `R${i}`), // R0-R12
  "R14", // R13 and R15 are deliberately absent: J-Link rejects them.
  "XPSR",
  "MSP",
  "PSP",
  "RAZ",
  "CFBP",
  "APSR",
  "EPSR",
  "IPSR",
  "PRIMASK",
  "BASEPRI",
  "FAULTMASK",
  "CONTROL",
  "BASEPRI_MAX",
  "IAPSR",
  "EAPSR",
  "IEPSR",
  "FPSCR",
  ...Array.from({ length: 32 }, (_, i) => `FPS${i}`),
  "CycleCnt",
  "MSP_NS",
  "PSP_NS",
  "MSP_S",
  "PSP_S",
  "MSPLIM_S",
  "PSPLIM_S",
  "MSPLIM_NS",
  "PSPLIM_NS",
  "CFBP_S",
  "CFBP_NS",
  "PRIMASK_NS",
  "BASEPRI_NS",
  "FAULTMASK_NS",
  "CONTROL_NS",
  "BASEPRI_MAX_NS",
  "PRIMASK_S",
  "BASEPRI_S",
  "FAULTMASK_S",
  "CONTROL_S",
  "BASEPRI_MAX_S",
  "MSPLIM",
  "PSPLIM",
];

const REGISTER_BY_KEY = new Map(REGISTERS.map((name) => [name.toLowerCase(), name]));

/** Friendly aliases that map onto a name J-Link actually accepts. */
const REGISTER_ALIASES: Record<string, string> = { lr: "R14" };

/** Names callers reach for that J-Link rejects, with the reason why. */
const REGISTER_REDIRECTS: Record<string, string> = {
  pc: "PC cannot be written with wreg; use the SetPC command instead (jlink_write_registers does this automatically), and read it from Regs or R15 in a register dump.",
  r15:
    "R15 cannot be written with wreg; use the SetPC command instead (jlink_write_registers does this automatically), and read it from Regs.",
  sp: "SP has no writable alias; use MSP or PSP. Which one is active is chosen by CONTROL.SPSEL.",
  r13: "R13 has no writable alias; use MSP or PSP. Which one is active is chosen by CONTROL.SPSEL.",
};

/**
 * Resolve a caller-supplied register name to the exact spelling J-Link wants,
 * or throw an error explaining the right command to use instead.
 */
export function normalizeRegisterName(name: string): string {
  const key = name.trim().toLowerCase();
  if (!key) throw new JLinkError("Register name is empty.");
  const redirect = REGISTER_REDIRECTS[key];
  if (redirect) throw new JLinkError(`Cannot use "${name}" as a register.`, redirect);
  const alias = REGISTER_ALIASES[key];
  const resolved = alias ?? REGISTER_BY_KEY.get(key);
  if (!resolved) {
    throw new JLinkError(
      `"${name}" is not a core register J-Link accepts.`,
      "Valid names include R0-R12, R14 (or LR), MSP, PSP, XPSR, APSR, IPSR, CONTROL, PRIMASK, FAULTMASK, BASEPRI and FPS0-FPS31.",
    );
  }
  return resolved;
}

export interface ProbeStatus {
  serial?: string;
  firmware?: string;
  hardware?: string;
  vTref?: string;
  iTarget?: string;
  pins?: string;
  speeds?: string;
}

/** Extract probe details from `st` output. */
export function parseProbeStatus(text: string): ProbeStatus {
  const status: ProbeStatus = {};
  const grab = (pattern: RegExp): string | undefined => {
    const match = pattern.exec(text);
    return match ? match[1].trim() : undefined;
  };
  status.serial = grab(/S\/N:\s*(\d+)/i);
  status.firmware = grab(/Firmware:\s*(.+)/i);
  status.hardware = grab(/Hardware version:\s*(.+)/i);
  status.vTref = grab(/VTref=([\d.]+)\s*V/i);
  status.iTarget = grab(/ITarget=(\S+)/i);
  status.pins = grab(/(TCK=\S.*)/);
  status.speeds = grab(/Supported target interface speeds:\s*([\s\S]*?)(?:\n\s*\n|$)/);
  return status;
}

/**
 * Address parsing for embedded conventions: `0x20000000` and bare `20000000`
 * are both hexadecimal; decimal requires passing a JSON number.
 */
export function parseAddress(value: number | string, field: string): number {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw new JLinkError(`${field} must be a non-negative integer, got ${value}.`);
    }
    return value;
  }
  const raw = value.trim();
  const hex = /^0x([0-9A-Fa-f]+)$/.exec(raw)?.[1] ?? (/^[0-9A-Fa-f]+$/.test(raw) ? raw : undefined);
  if (hex === undefined) {
    throw new JLinkError(`Could not parse ${field} "${value}".`, "Use 0x20000000 or 20000000 (both hexadecimal).");
  }
  return Number.parseInt(hex, 16);
}

/** Data values accept decimal numbers or `0x`-prefixed hex strings. */
export function parseValue(value: number | string, field: string): number {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw new JLinkError(`${field} must be a non-negative integer, got ${value}.`);
    }
    return value;
  }
  const raw = value.trim();
  const parsed = /^0x[0-9A-Fa-f]+$/i.test(raw) ? Number.parseInt(raw.slice(2), 16) : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new JLinkError(`Could not parse ${field} "${value}".`, "Use decimal (255) or hex (0xFF).");
  }
  return parsed;
}

export function hex(value: number, width = 8): string {
  return `0x${value.toString(16).toUpperCase().padStart(width, "0")}`;
}
