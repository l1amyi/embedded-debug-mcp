import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JLinkError, resolveJLinkPath } from "./config.js";
import { runJLink } from "./jlink.js";

/** A contiguous address range from J-Link's device database. */
export interface MemoryRegion {
  address: number;
  /** Size in bytes. J-Link writes 0 for devices where it is unspecified. */
  size: number;
}

export interface DeviceInfo {
  vendor: string;
  name: string;
  core: string;
  flash: MemoryRegion[];
  ram: MemoryRegion[];
  /** The DLL's built-in list, or a supplementary entry from JLinkDevices.xml. */
  source: "dll" | "xml";
}

/**
 * One line of `ExpDevList` output looks like:
 *
 *   "ST", "STM32F411RE", "Cortex-M4", {0x08000000, 0x00080000}, {0x20000000, 0x00020000}
 *
 * Flash (and occasionally RAM) may instead be a list of banks:
 *
 *   "Analog", "ADSP-CM411CBCZ-AF_M4", "Cortex-M4", { {0x11000000, 0x00020000}, {0x11080000, 0x00020000} }, {...}
 */
const LINE_PATTERN = /^\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*(.*)$/;
const REGION_PATTERN = /\{\s*0x([0-9A-Fa-f]+)\s*,\s*0x([0-9A-Fa-f]+)\s*\}/g;

/**
 * Split `{...}, {...}` into its two top-level groups. Commas nested inside
 * braces (a bank list) must not split, so brace depth is tracked.
 */
export function splitTopLevel(rest: string): [string, string] | undefined {
  let depth = 0;
  for (let i = 0; i < rest.length; i += 1) {
    const char = rest[i];
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === "," && depth === 0) return [rest.slice(0, i), rest.slice(i + 1)];
  }
  return undefined;
}

/** Pull every `{0xADDR, 0xSIZE}` pair out of a group, including nested bank lists. */
export function parseRegions(group: string): MemoryRegion[] {
  const regions: MemoryRegion[] = [];
  REGION_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REGION_PATTERN.exec(group)) !== null) {
    const address = Number.parseInt(match[1], 16);
    const size = Number.parseInt(match[2], 16);
    // A zero size means "J-Link has no information", not "an empty region".
    if (size > 0) regions.push({ address, size });
  }
  return regions;
}

/** Parse the whole `ExpDevList` text file. Malformed lines are skipped. */
export function parseDeviceList(text: string): DeviceInfo[] {
  const devices: DeviceInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = LINE_PATTERN.exec(line);
    if (!match) continue;
    const groups = splitTopLevel(match[4]);
    if (!groups) continue;
    devices.push({
      vendor: match[1],
      name: match[2],
      core: match[3],
      flash: parseRegions(groups[0]),
      ram: parseRegions(groups[1]),
      source: "dll",
    });
  }
  return devices;
}

/**
 * JLinkDevices.xml holds ~241 devices that are *not* in the DLL's built-in
 * list. They must be accepted too, or validation would reject valid names.
 */
export function xmlDeviceNames(): Map<string, DeviceInfo> {
  const found = new Map<string, DeviceInfo>();
  const xmlPath = path.join(path.dirname(resolveJLinkPath()), "JLinkDevices.xml");

  let text: string;
  try {
    text = fs.readFileSync(xmlPath, "utf8");
  } catch {
    return found;
  }

  for (const entry of text.matchAll(/<ChipInfo\b[^>]*>/g)) {
    const tag = entry[0];
    const name = /\bName="([^"]*)"/.exec(tag)?.[1];
    if (!name) continue;
    const vendor = /\bVendor="([^"]*)"/.exec(tag)?.[1] ?? "Unknown";
    const core = (/\bCore="([^"]*)"/.exec(tag)?.[1] ?? "Unknown").replace(/^JLINK_CORE_/, "").replace(/_/g, "-");
    const ramAddr = Number.parseInt(/\bWorkRAMAddr="(0x[0-9A-Fa-f]+)"/.exec(tag)?.[1] ?? "", 16);
    const ramSize = Number.parseInt(/\bWorkRAMSize="(0x[0-9A-Fa-f]+)"/.exec(tag)?.[1] ?? "", 16);
    found.set(name.toLowerCase(), {
      vendor,
      name,
      core,
      flash: [],
      ram: Number.isNaN(ramAddr) || Number.isNaN(ramSize) ? [] : [{ address: ramAddr, size: ramSize }],
      source: "xml",
    });
  }
  return found;
}

interface DeviceCacheFile {
  /** J-Link executable the list was exported from. */
  source: string;
  /** mtime of that executable, so an upgrade invalidates the cache. */
  sourceMtimeMs: number;
  generatedAt: string;
  devices: DeviceInfo[];
}

function cacheFilePath(): string {
  return path.join(os.tmpdir(), "jlink-mcp", "device-list.json");
}

function readCache(source: string): DeviceCacheFile | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFilePath(), "utf8")) as DeviceCacheFile;
    if (parsed.source !== source) return undefined;
    if (parsed.sourceMtimeMs !== fs.statSync(source).mtimeMs) return undefined;
    if (!Array.isArray(parsed.devices) || parsed.devices.length === 0) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeCache(cache: DeviceCacheFile): void {
  try {
    fs.mkdirSync(path.dirname(cacheFilePath()), { recursive: true });
    fs.writeFileSync(cacheFilePath(), JSON.stringify(cache), "utf8");
  } catch {
    /* a failed cache write only costs time on the next call */
  }
}

/** Ask J-Link itself for its device list. Needs no target and no connection. */
async function exportDeviceList(exe: string): Promise<DeviceInfo[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlink-mcp-dev-"));
  const outPath = path.join(dir, "devices.txt");
  try {
    const result = await runJLink([`ExpDevList "${outPath}"`], { timeoutMs: 60_000 });
    if (!fs.existsSync(outPath)) {
      const detail = result.errors.length > 0 ? ` (${result.errors.join("; ")})` : "";
      throw new JLinkError(
        `J-Link did not export its device list${detail}.`,
        "Run `JLink.exe -CommanderScript` manually with `ExpDevList out.txt` to check.",
      );
    }
    return parseDeviceList(fs.readFileSync(outPath, "utf8"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export interface DeviceDatabase {
  /** DLL list plus genuinely supplementary XML-only names, deduplicated. */
  devices: DeviceInfo[];
  /** Case-insensitive lookup over `devices`. */
  byName: Map<string, DeviceInfo>;
  /** How many names came only from JLinkDevices.xml. */
  supplementaryCount: number;
  /** True when the list was served from the on-disk cache. */
  cached: boolean;
  exportedAt: string;
}

let memory: DeviceDatabase | undefined;

/**
 * Merge the XML names into the DLL list. The XML repeats many DLL devices
 * (with less information, e.g. no flash banks), so a DLL entry always wins and
 * only XML-only names are appended.
 */
function buildDatabase(
  devices: DeviceInfo[],
  xml: Map<string, DeviceInfo>,
  cached: boolean,
  exportedAt: string,
): DeviceDatabase {
  const byName = new Map<string, DeviceInfo>();
  for (const device of devices) byName.set(device.name.toLowerCase(), device);

  const merged = [...devices];
  let supplementaryCount = 0;
  for (const [key, info] of xml) {
    if (byName.has(key)) continue;
    byName.set(key, info);
    merged.push(info);
    supplementaryCount += 1;
  }

  return { devices: merged, byName, supplementaryCount, cached, exportedAt };
}

/**
 * The authoritative device list: the DLL's built-in list plus the
 * supplementary XML names. Exporting takes a few seconds, so the parsed
 * result is cached on disk and keyed to the J-Link executable's mtime.
 */
export async function loadDeviceDatabase(options: { refresh?: boolean } = {}): Promise<DeviceDatabase> {
  if (memory && !options.refresh) return memory;

  const exe = resolveJLinkPath();
  const xml = xmlDeviceNames();

  if (!options.refresh) {
    const cached = readCache(exe);
    if (cached) {
      memory = buildDatabase(cached.devices, xml, true, cached.generatedAt);
      return memory;
    }
  }

  const devices = await exportDeviceList(exe);
  if (devices.length === 0) {
    throw new JLinkError(
      "J-Link exported an empty device list.",
      "The installed J-Link software may be incomplete; reinstall it or set JLINK_PATH.",
    );
  }
  const generatedAt = new Date().toISOString();
  writeCache({ source: exe, sourceMtimeMs: fs.statSync(exe).mtimeMs, generatedAt, devices });
  memory = buildDatabase(devices, xml, false, generatedAt);
  return memory;
}

/** Exact, case-insensitive lookup across the DLL list and the XML. */
export function findDevice(db: DeviceDatabase, name: string): DeviceInfo | undefined {
  return db.byName.get(name.trim().toLowerCase());
}

/** Bigram Dice coefficient, for catching typos that are not prefix errors. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i += 1) {
    const gram = a.slice(i, i + 2);
    bigrams.set(gram, (bigrams.get(gram) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const gram = b.slice(i, i + 2);
    const remaining = bigrams.get(gram) ?? 0;
    if (remaining > 0) {
      hits += 1;
      bigrams.set(gram, remaining - 1);
    }
  }
  return (2 * hits) / (a.length - 1 + b.length - 1);
}

/**
 * Rank a candidate device name against a query. Exact matches win, then
 * prefix matches (shorter = closer), then substring matches, and finally
 * approximate matches so that typos in the middle of a name still resolve.
 * Returns 0 when the candidate is not a plausible match.
 */
export function scoreDeviceName(needle: string, candidate: string): number {
  const lower = candidate.toLowerCase();
  if (lower === needle) return 1000;
  if (lower.startsWith(needle)) return 900 - (lower.length - needle.length);
  if (lower.includes(needle)) return 700 - (lower.length - needle.length);
  const dice = similarity(needle, lower);
  return dice < 0.55 ? 0 : dice * 500;
}

/** Best-effort "did you mean" list, ordered by closeness. */
export function suggestDevices(db: DeviceDatabase, name: string, limit = 8): string[] {
  const needle = name.trim().toLowerCase();
  if (!needle) return [];
  const scored: Array<{ name: string; score: number }> = [];

  for (const device of db.devices) {
    const score = scoreDeviceName(needle, device.name);
    if (score > 0) scored.push({ name: device.name, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((entry) => entry.name);
}

export interface DeviceMatch {
  device: DeviceInfo;
  score: number;
}

/** Ranked device search across the DLL list and the supplementary XML. */
export function searchDevices(db: DeviceDatabase, query: string, limit = 20): DeviceMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: DeviceMatch[] = [];

  for (const device of db.devices) {
    const score = scoreDeviceName(needle, device.name);
    if (score > 0) matches.push({ device, score });
  }

  return matches.sort((a, b) => b.score - a.score || a.device.name.localeCompare(b.device.name)).slice(0, limit);
}

export interface DeviceValidation {
  info?: DeviceInfo;
  suggestions: string[];
  /** Set when the database could not be consulted at all. */
  unavailable?: string;
}

/**
 * Check a device name against J-Link's own list. Validation is best-effort:
 * a failure to build the database yields `unavailable` rather than an error,
 * so the probe still works if the export misbehaves.
 */
export async function validateDeviceName(name: string): Promise<DeviceValidation> {
  try {
    const db = await loadDeviceDatabase();
    const info = findDevice(db, name);
    if (info) return { info, suggestions: [] };
    return { suggestions: suggestDevices(db, name) };
  } catch (err) {
    return { suggestions: [], unavailable: err instanceof Error ? err.message : String(err) };
  }
}

/** Human-readable form of a region list, e.g. `0x08000000 (512 KiB)`. */
export function formatRegions(regions: MemoryRegion[]): string {
  if (regions.length === 0) return "unknown";
  return regions.map((r) => `${hexAddress(r.address)} (${formatSize(r.size)})`).join(", ");
}

export function hexAddress(address: number): string {
  return `0x${address.toString(16).toUpperCase().padStart(8, "0")}`;
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

/** Which region, if any, contains `address`. */
export function regionContaining(regions: MemoryRegion[], address: number): MemoryRegion | undefined {
  return regions.find((r) => address >= r.address && address < r.address + r.size);
}
