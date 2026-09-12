#!/usr/bin/env node
// Collect the J-Link documentation and CLI facts this project depends on into
// docs/, so an agent has one predictable place to look instead of hunting
// through Program Files.
//
// Two destinations, deliberately separated:
//
//   docs/vendor/     Copies of SEGGER's own documents (PDFs, release notes,
//                    JLinkDevices.xml, the licence text) plus pdftotext output.
//                    SEGGER-copyrighted, git-ignored, never committed. This
//                    script only copies them on the machine that already has
//                    the J-Link software installed; see docs/README.md.
//
//   docs/reference/  Short factual outputs produced by the installed J-Link
//                    itself (its version banner, its `?` command list, its
//                    RSetType list) plus a manifest of what was copied. These
//                    are facts about a command-line tool rather than SEGGER's
//                    documentation prose, so they are committed and can be
//                    grepped without a probe attached.
//
// Usage: npm run docs:sync
//
// Set JLINK_DEVICE to let the reset-type capture connect without asking; that
// one capture needs a target, the rest need only the J-Link software.
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = path.join(root, "docs", "vendor");
const referenceDir = path.join(root, "docs", "reference");

function log(message) {
  console.log(`[docs:sync] ${message}`);
}

/** Ask src/config.ts where J-Link lives, so the search logic stays in one place. */
async function resolveJLink() {
  const configPath = path.join(root, "dist", "config.js");
  if (!fs.existsSync(configPath)) {
    throw new Error("dist/config.js is missing. Run `npm run build` first.");
  }
  const { resolveJLinkPath } = await import(`file://${configPath}`);
  return resolveJLinkPath();
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16);
}

function human(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${Math.round(bytes / 1024)} KiB`;
}

/** Copy the vendor documents that are relevant to this project. */
function copyVendorDocs(installDir) {
  const wanted = [
    ["Doc/Manuals/UM08001_JLink.pdf", "UM08001_JLink.pdf", "J-Link / J-Trace user guide: command strings, RTT, flash breakpoints"],
    ["Doc/Manuals/UM08003_JFlash.pdf", "UM08003_JFlash.pdf", "J-Flash user guide"],
    ["Doc/ReleaseNotes/ReleaseNotes_JLink.html", "ReleaseNotes_JLink.html", "Release notes, useful for version-specific behaviour"],
    ["JLinkDevices.xml", "JLinkDevices.xml", "Supplementary device definitions the DLL list lacks"],
    ["Doc/LicenseIncGUI.txt", "LicenseIncGUI.txt", "The licence that forbids redistributing these files"],
  ];

  const copied = [];
  for (const [relative, target, note] of wanted) {
    const source = path.join(installDir, ...relative.split("/"));
    if (!fs.existsSync(source)) {
      log(`missing, skipped: ${relative}`);
      continue;
    }
    const destination = path.join(vendorDir, target);
    fs.copyFileSync(source, destination);
    const bytes = fs.statSync(destination).size;
    copied.push({ target, source, bytes, note, sha256: sha256(destination) });
    log(`copied ${target} (${human(bytes)})`);
  }
  return copied;
}

/**
 * Extract text from the PDFs so an agent can grep them. pdftotext comes from
 * poppler (part of Git for Windows' MinGW toolchain here). Without it the PDFs
 * are still copied, just not searchable.
 */
function extractPdfText(copied) {
  const probe = spawnSync("pdftotext", ["-v"], { stdio: "ignore" });
  if (probe.error) {
    log("pdftotext not found: PDFs copied but not converted to text.");
    return new Map();
  }

  const extracted = new Map();
  for (const entry of copied) {
    if (!entry.target.endsWith(".pdf")) continue;
    const pdf = path.join(vendorDir, entry.target);
    const text = path.join(vendorDir, entry.target.replace(/\.pdf$/, ".txt"));
    try {
      // -layout keeps the two-column tables in a readable order.
      execFileSync("pdftotext", ["-layout", pdf, text], { stdio: "ignore" });
      const lines = fs.readFileSync(text, "utf8").split("\n").length;
      extracted.set(entry.target, lines);
      log(`extracted ${path.basename(text)} (${lines} lines)`);
    } catch (err) {
      log(`pdftotext failed for ${entry.target}: ${err.message}`);
    }
  }
  return extracted;
}

/**
 * Pull the slice of J-Link output between the first line matching `start` and
 * the next line matching `end`. Captures are full of connect banners and
 * register dumps, and only a small part of each is worth keeping.
 */
function sliceBlock(text, start, end) {
  const lines = text.split("\n");
  const from = lines.findIndex((line) => start.test(line));
  if (from < 0) return "";
  const to = lines.findIndex((line, index) => index > from && end.test(line));
  return lines
    .slice(from, to < 0 ? undefined : to)
    .join("\n")
    .trim();
}

/**
 * Capture one fact from the installed tool. Hardware-dependent captures return
 * undefined rather than empty output, so a machine without a probe or target
 * cannot overwrite a good committed file with noise.
 */
async function capture(label, commands, extract, options = {}) {
  const { runJLink } = await import(`file://${path.join(root, "dist", "jlink.js")}`);
  const result = await runJLink(commands, { timeoutMs: 60_000, ...options });
  const value = extract(result.stdout);
  if (!value) {
    log(`${label}: not captured (no probe/target attached?); leaving any existing file untouched`);
    return undefined;
  }
  log(`captured ${label}`);
  return value;
}

async function main() {
  const exe = await resolveJLink();
  const installDir = path.dirname(exe);
  log(`J-Link install: ${installDir}`);

  fs.mkdirSync(vendorDir, { recursive: true });
  fs.mkdirSync(referenceDir, { recursive: true });

  const copied = copyVendorDocs(installDir);
  const extracted = extractPdfText(copied);

  // `?` needs no probe, and its output also carries the version banner.
  const surface = await capture("?", ["?"], (stdout) => sliceBlock(stdout, /^Available commands are:/, /^Script processing completed/));

  const version = await capture("version", ["?"], (stdout) =>
    stdout
      .split("\n")
      .filter((line) => /^SEGGER J-Link Commander V|^DLL version V/.test(line))
      .join("\n")
      .trim(),
  );

  // RSetType requires a target connection, so this one is hardware-dependent.
  const resetTypes = await capture(
    "reset types",
    ["RSetType"],
    (stdout) => sliceBlock(stdout, /^Syntax: RSetType/, /^Script processing completed/),
    // A device name stops J-Link from asking interactively for one.
    process.env.JLINK_DEVICE ? { device: process.env.JLINK_DEVICE } : {},
  );

  const write = (name, body) => {
    if (body === undefined) return;
    fs.writeFileSync(path.join(referenceDir, name), `${body}\n`, "utf8");
  };
  write("jlink-cli-surface.txt", surface);
  write("jlink-reset-types.txt", resetTypes);
  write("jlink-version.txt", version);

  const detected = /SEGGER J-Link Commander V([\w.]+)/.exec(version ?? "")?.[1] ?? "unknown";

  const manifest = [
    "# Vendor documentation manifest",
    "",
    "Generated by `npm run docs:sync`. The files listed here live in `docs/vendor/`,",
    "which is **git-ignored** because SEGGER's licence forbids redistribution. See",
    "`docs/README.md` for why, and run the script again on any machine with the",
    "J-Link software installed to recreate them.",
    "",
    `- Generated: ${new Date().toISOString()}`,
    `- J-Link Commander: V${detected}`,
    `- Source directory: \`${installDir}\``,
    `- Host: ${os.platform()} ${os.arch()}`,
    "",
    "| File | Size | SHA-256 (first 16) | Purpose |",
    "| --- | --- | --- | --- |",
    ...copied.map(
      (entry) => `| \`${entry.target}\` | ${human(entry.bytes)} | \`${entry.sha256}\` | ${entry.note} |`,
    ),
    "",
    "Extracted text (pdftotext -layout):",
    "",
    ...(extracted.size > 0
      ? [...extracted].map(([pdf, lines]) => `- \`${pdf.replace(/\.pdf$/, ".txt")}\` — ${lines} lines`)
      : ["- none (pdftotext unavailable)"]),
    "",
  ].join("\n");
  fs.writeFileSync(path.join(referenceDir, "vendor-manifest.md"), manifest, "utf8");
  log(`wrote docs/reference/vendor-manifest.md (${copied.length} vendor files)`);
}

main().catch((err) => {
  console.error(`[docs:sync] failed: ${err.message}`);
  process.exit(1);
});
