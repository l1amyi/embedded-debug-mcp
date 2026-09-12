import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { JLinkError } from "./config.js";

/**
 * Turning a raw PC into something a human can act on ("main.c:83 in main").
 *
 * Two layers, deliberately:
 *
 *  1. A built-in ELF symbol-table reader. No external tool needed, so it works
 *     on any machine, and it also covers the case where the firmware was built
 *     by a toolchain whose binutils are not on PATH (Keil, for instance).
 *  2. `addr2line`, when it can be found, for real DWARF file/line information.
 *     This is the canonical tool and handles DWARF 5, inlining and compressed
 *     sections correctly, which a hand-rolled .debug_line parser would not.
 *
 * Symbols alone give the function; only addr2line gives the source line, so the
 * tool descriptions say so rather than promising more than is delivered.
 */

export interface FunctionSymbol {
  address: number;
  size: number;
  name: string;
  /** End of the section the symbol lives in; a hard upper bound on its extent. */
  sectionEnd: number;
}

export interface SourceLocation {
  address: number;
  function?: string;
  /** Absolute path as reported by the tool. */
  file?: string;
  line?: number;
  /** True when the file/line could not be determined. */
  unknown?: boolean;
}

interface CachedSymbols {
  mtimeMs: number;
  functions: FunctionSymbol[];
}

const symbolCache = new Map<string, CachedSymbols>();

export interface AddressRange {
  start: number;
  end: number;
}

interface ElfSection {
  type: number;
  flags: number;
  address: number;
  offset: number;
  size: number;
  link: number;
  entrySize: number;
}

/** Read the section headers of a 32-bit little-endian ELF, validating the header. */
function parseElfSections(elfPath: string): { buffer: Buffer; sections: ElfSection[] } {
  const buffer = fs.readFileSync(elfPath);

  if (buffer.length < 52 || buffer.readUInt32BE(0) !== 0x7f454c46) {
    throw new JLinkError(`${elfPath} is not an ELF file.`, "Pass the .elf produced by the build, not a .bin or .hex.");
  }
  const elfClass = buffer.readUInt8(4);
  const dataEncoding = buffer.readUInt8(5);
  if (elfClass !== 1) {
    throw new JLinkError(`${elfPath} is ELF${elfClass === 2 ? "64" : "?"}, not ELF32.`, "Cortex-M images are 32-bit ELF.");
  }
  if (dataEncoding !== 1) {
    throw new JLinkError(`${elfPath} is big-endian, which no Cortex-M target uses.`);
  }

  const sectionOffset = buffer.readUInt32LE(32);
  const sectionEntrySize = buffer.readUInt16LE(46);
  const sectionCount = buffer.readUInt16LE(48);
  if (sectionOffset === 0 || sectionEntrySize < 40 || sectionCount === 0) {
    throw new JLinkError(`${elfPath} has no section headers; it carries no symbols.`);
  }

  const sections = Array.from({ length: sectionCount }, (_, index) => {
    const at = sectionOffset + index * sectionEntrySize;
    return {
      type: buffer.readUInt32LE(at + 4),
      flags: buffer.readUInt32LE(at + 8),
      address: buffer.readUInt32LE(at + 12),
      offset: buffer.readUInt32LE(at + 16),
      size: buffer.readUInt32LE(at + 20),
      link: buffer.readUInt32LE(at + 24),
      entrySize: buffer.readUInt32LE(at + 36),
    };
  });
  return { buffer, sections };
}

/**
 * Address ranges of the executable sections. Used to sanity-check a recovered
 * exception frame: a real stacked PC has to land inside one of these.
 */
export function loadExecutableRanges(elfPath: string): AddressRange[] {
  const stat = fs.statSync(elfPath);
  const cached = execCache.get(elfPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.ranges;

  const { sections } = parseElfSections(elfPath);
  const ranges = sections
    // SHF_EXECINSTR
    .filter((section) => (section.flags & 0x4) !== 0 && section.size > 0)
    .map((section) => ({ start: section.address, end: section.address + section.size }))
    .sort((a, b) => a.start - b.start);

  execCache.set(elfPath, { mtimeMs: stat.mtimeMs, ranges });
  return ranges;
}

const execCache = new Map<string, { mtimeMs: number; ranges: AddressRange[] }>();

export function isExecutableAddress(ranges: AddressRange[], address: number): boolean {
  return ranges.some((range) => address >= range.start && address < range.end);
}

/**
 * Parse `.symtab` out of a 32-bit little-endian ELF and return its functions.
 * ARM Cortex-M images are always ELF32; a 64-bit file is rejected explicitly
 * rather than misparsed.
 */
export function parseElfFunctions(elfPath: string): FunctionSymbol[] {
  const { buffer, sections } = parseElfSections(elfPath);

  // SHT_SYMTAB. `.dynsym` (SHT_DYNSYM) is not what we want: firmware is statically linked.
  const symtabIndex = sections.findIndex((section) => section.type === 2);
  if (symtabIndex < 0) {
    throw new JLinkError(
      `${elfPath} has no .symtab section, so addresses cannot be named.`,
      "Build with symbols (GCC: do not strip and keep -g; Keil: enable Debug information).",
    );
  }

  const symtab = sections[symtabIndex];
  const strtab = sections[symtab.link];
  const entrySize = symtab.entrySize || 16;
  const count = Math.floor(symtab.size / entrySize);
  const functions: FunctionSymbol[] = [];

  for (let index = 0; index < count; index += 1) {
    const at = symtab.offset + index * entrySize;
    const nameOffset = buffer.readUInt32LE(at);
    const value = buffer.readUInt32LE(at + 4);
    const size = buffer.readUInt32LE(at + 8);
    const info = buffer.readUInt8(at + 12);
    const sectionIndex = buffer.readUInt16LE(at + 14);

    // STT_FUNC, and bound to a real section (st_shndx 0 means undefined).
    if ((info & 0x0f) !== 2 || sectionIndex === 0) continue;

    const end = buffer.indexOf(0, strtab.offset + nameOffset);
    const name = buffer.toString("utf8", strtab.offset + nameOffset, end < 0 ? undefined : end);
    if (!name) continue;

    // On ARM the low bit of st_value marks Thumb code. Addresses coming from
    // the CPU never have it set, so clear it before the two are compared.
    const section = sections[sectionIndex];
    functions.push({
      address: value & ~1,
      size,
      name,
      sectionEnd: section ? section.address + section.size : 0,
    });
  }

  functions.sort((a, b) => a.address - b.address);
  return functions;
}

/** Cached by mtime so repeated tool calls do not re-read a large ELF. */
export function loadElfFunctions(elfPath: string): FunctionSymbol[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(elfPath);
  } catch {
    throw new JLinkError(
      `ELF file not found: ${elfPath}`,
      "Pass the path to the .elf the linker produced, for example test_project/build/Debug/test_project.elf.",
    );
  }
  const cached = symbolCache.get(elfPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.functions;

  const functions = parseElfFunctions(elfPath);
  symbolCache.set(elfPath, { mtimeMs: stat.mtimeMs, functions });
  return functions;
}

export interface FunctionLookup {
  name: string;
  /** How far into the function the address is, in bytes. */
  offset: number;
}

/**
 * Find the function containing an address.
 *
 * The extent of a symbol is the smallest of: its own size (when non-zero), the
 * next symbol's start, and the end of its section. The section bound matters:
 * GCC emits zero-sized markers such as `_fini` as the last symbol in `.text`,
 * and treating "size 0" as unbounded made any address above them -- including
 * addresses past the end of the image entirely -- resolve to `_fini`.
 */
export function lookupFunction(functions: FunctionSymbol[], address: number): FunctionLookup | undefined {
  let low = 0;
  let high = functions.length - 1;
  let index = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (functions[mid].address <= address) {
      index = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (index < 0) return undefined;

  const best = functions[index];
  const limits: number[] = [];
  if (best.size > 0) limits.push(best.address + best.size);
  const next = functions[index + 1];
  if (next) limits.push(next.address);
  if (best.sectionEnd > best.address) limits.push(best.sectionEnd);

  const end = limits.length > 0 ? Math.min(...limits) : Number.POSITIVE_INFINITY;
  if (address >= end) return undefined;
  return { name: best.name, offset: address - best.address };
}

/**
 * Locate an addr2line. The bare name is tried too, so this works with a plain
 * binutils install as well as with a cross toolchain on PATH.
 */
export function findAddr2Line(): string | undefined {
  const override = process.env.JLINK_MCP_ADDR2LINE?.trim();
  if (override) return fs.existsSync(override) ? override : undefined;

  const candidates = ["arm-none-eabi-addr2line", "arm-none-eabi-addr2line.exe", "addr2line", "addr2line.exe", "llvm-addr2line"];
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const name of candidates) {
    for (const dir of dirs) {
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* keep looking */
      }
    }
  }
  return undefined;
}

function run(file: string, args: string[], timeoutMs = 15_000): Promise<{ stdout: string; ok: boolean }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve({ stdout: stdout ?? "", ok: !error || Boolean(stdout) });
    });
  });
}

/**
 * Resolve addresses to file/line with addr2line, batching every address into a
 * single invocation. Falls back to the built-in symbol table for names.
 */
export async function resolveAddresses(elfPath: string, addresses: number[]): Promise<Map<number, SourceLocation>> {
  const unique = [...new Set(addresses)];
  const result = new Map<number, SourceLocation>();
  for (const address of unique) result.set(address, { address });

  let functions: FunctionSymbol[] = [];
  try {
    functions = loadElfFunctions(elfPath);
  } catch {
    // Without symbols we can still try addr2line, which does its own parsing.
  }
  for (const address of unique) {
    const found = lookupFunction(functions, address);
    if (found) result.get(address)!.function = found.name;
  }

  const addr2line = findAddr2Line();
  if (!addr2line || unique.length === 0) return result;

  // -f prints the function, -C demangles, -i would expand inlining but then
  // produces a variable number of lines per address, which is harder to map
  // back. Keep one record per address.
  const { stdout } = await run(addr2line, ["-e", elfPath, "-f", "-C", ...unique.map((a) => `0x${a.toString(16)}`)]);
  const lines = stdout.split(/\r?\n/);
  unique.forEach((address, index) => {
    const fn = lines[index * 2];
    const where = lines[index * 2 + 1];
    if (fn && fn !== "??" && fn.trim()) result.get(address)!.function = fn.trim();
    if (!where) return;
    // addr2line appends " (discriminator N)" when one address maps to several
    // source positions; it has to be tolerated or the whole parse fails.
    const match = /^(.*):(\d+)(?::\d+)?(?:\s*\(discriminator\s+\d+\))?$/.exec(where.trim());
    if (!match || match[1] === "??") {
      result.get(address)!.unknown = true;
      return;
    }
    result.get(address)!.file = match[1];
    result.get(address)!.line = Number.parseInt(match[2], 10);
  });
  return result;
}

/**
 * Strip a shared prefix so output reads "Core/Src/main.c:83" instead of an
 * absolute path that depends on where the project lives on this machine.
 *
 * The primary anchor is derived from the ELF path: both CMake (build/Debug/x.elf)
 * and Keil (MDK-ARM/<target>/x.axf) put the artefact two directories below the
 * project root, so going up two levels lands on the root either way. Deriving it
 * from the ELF rather than from the set of resolved files matters when only one
 * file is resolved -- a longest-common-prefix rule would then strip the whole
 * path and leave a bare "main.c".
 */
export function shortenPaths(locations: Iterable<SourceLocation>, elfPath?: string): Map<string, string> {
  const normalize = (value: string) => value.replace(/\\/g, "/");
  const files = [...new Set([...locations].map((l) => l.file).filter((f): f is string => Boolean(f)))].map(normalize);
  const short = new Map<string, string>();
  if (files.length === 0) return short;

  const roots: string[] = [];
  if (elfPath) {
    const elfDir = path.dirname(normalize(elfPath));
    roots.push(path.dirname(path.dirname(elfDir)));
  }

  // Fallback: the longest directory prefix every file shares.
  const split = files.map((f) => f.split("/"));
  const first = split[0];
  let common = 0;
  while (common < first.length - 1 && split.every((parts) => parts[common] === first[common])) common += 1;
  roots.push(first.slice(0, common).join("/"));

  for (const file of files) {
    let best = file;
    for (const root of roots) {
      if (!root || !file.startsWith(`${root}/`)) continue;
      const relative = file.slice(root.length + 1);
      if (relative && relative.length < best.length) {
        best = relative;
        break;
      }
    }
    short.set(file, best);
  }
  return short;
}

/** One-line human description: "Core/Src/main.c:83 in main". */
export function describeLocation(location: SourceLocation | undefined, shortPaths: Map<string, string>): string | undefined {
  if (!location) return undefined;
  const where = location.file
    ? `${shortPaths.get(location.file.replace(/\\/g, "/")) ?? path.basename(location.file)}:${location.line ?? "?"}`
    : undefined;
  if (where && location.function) return `${where} in ${location.function}`;
  if (where) return where;
  if (location.function) return location.function;
  return undefined;
}

/** First paragraph of the source line, so a report can show the actual code. */
export function readSourceLine(location: SourceLocation | undefined): string | undefined {
  if (!location?.file || location.line === undefined) return undefined;
  try {
    const line = fs.readFileSync(location.file, "utf8").split(/\r?\n/)[location.line - 1];
    return line === undefined ? undefined : line.trim();
  } catch {
    return undefined;
  }
}
