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
 * Parse `regs` output. Requires 8-digit values so probe status lines such as
 * "VTref=3.285V" are not mistaken for registers.
 */
export function parseRegisters(text: string): Record<string, string> {
  const regs: Record<string, string> = {};
  const pattern = /(?:^|[\s,;])([A-Za-z][A-Za-z0-9_]{0,7})\s*=\s*\b([0-9A-Fa-f]{8})\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    regs[match[1]] = match[2].toUpperCase();
  }
  return regs;
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
