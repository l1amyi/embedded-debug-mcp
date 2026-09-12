// DESTRUCTIVE hardware test for jlink_erase / jlink_flash.
//
// It erases the target's flash. Requires an explicit acknowledgement flag:
//
//   node scripts/flash-test.mjs --yes-destroy-flash [device]
//
// The sequence is designed so the target is left exactly as it was found:
//
//   1. back the whole flash up with savebin and validate the image
//   2. chip erase, confirm the flash really is blank
//   3. label each STM32 sector with a known pattern so erase can be observed
//   4. exercise every flash code path (.bin by address, .hex, .srec, verify)
//   5. range erase and prove only the requested sector changed
//   6. restore the backup and prove it is byte-identical to the original
//
// If anything throws, the restore in the finally block still runs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const args = process.argv.slice(2);
if (!args.includes("--yes-destroy-flash")) {
  console.error(
    "Refusing to run: this test erases the target's flash.\n" +
      "Re-run with --yes-destroy-flash once you are sure the image can be lost.",
  );
  process.exit(2);
}
const device = args.find((a) => !a.startsWith("--")) ?? process.env.JLINK_DEVICE ?? "STM32F411CE";

const FLASH_BASE = 0x08000000;
const FLASH_SIZE = 0x80000;
// STM32F411 sector map: 4 x 16 KiB, 1 x 64 KiB, 3 x 128 KiB.
const SECTOR4 = { start: 0x08010000, size: 0x10000 };
const SECTOR5 = { start: 0x08020000, size: 0x20000 };

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "jlink-flash-test-"));
const backupPath = path.join(workDir, "backup.bin");
const dumpPath = path.join(workDir, "dump.bin");
// An existing file with an extension this J-Link release cannot load, so the
// extension guard is exercised rather than the file-existence check.
fs.writeFileSync(path.join(workDir, "fake.elf"), "this is not an ELF file");

const client = new Client({ name: "flash-test", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "inherit" }),
);

let passed = 0;
let failed = 0;
function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`   ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`   FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function call(name, extra = {}) {
  const r = await client.callTool({ name, arguments: { device, ...extra } });
  return { isError: r.isError ?? false, body: r.content.map((c) => c.text).join("\n") };
}

/** J-Link wants a native Windows path inside its own command syntax. */
function nativePath(p) {
  return p.replace(/\//g, "\\");
}

/** Dump the whole flash to a file with savebin and return the bytes. */
async function dumpFlash() {
  fs.rmSync(dumpPath, { force: true });
  const r = await call("jlink_exec", {
    commands: ["h", `savebin "${nativePath(dumpPath)}", 0x${FLASH_BASE.toString(16)}, 0x${FLASH_SIZE.toString(16)}`],
  });
  if (!fs.existsSync(dumpPath)) throw new Error(`savebin produced no file: ${r.body.slice(0, 300)}`);
  return fs.readFileSync(dumpPath);
}

const isBlank = (image, start, size) => {
  const from = start - FLASH_BASE;
  for (let i = from; i < from + size; i += 1) if (image[i] !== 0xff) return false;
  return true;
};

/** Intel HEX with an extended linear address record so 0x08xxxxxx works. */
function intelHex(address, data) {
  const record = (type, addr, payload) => {
    const bytes = [payload.length, (addr >> 8) & 0xff, addr & 0xff, type, ...payload];
    const sum = bytes.reduce((a, b) => a + b, 0);
    bytes.push(-sum & 0xff);
    return `:${bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join("")}`;
  };
  const upper = (address >>> 16) & 0xffff;
  const lines = [
    record(0x04, 0, [(upper >> 8) & 0xff, upper & 0xff]),
    record(0x00, address & 0xffff, data),
    record(0x01, 0, []),
  ];
  return `${lines.join("\n")}\n`;
}

/** Motorola S-record, S3 (32-bit address). */
function srecord(address, data) {
  const addrBytes = [(address >>> 24) & 0xff, (address >>> 16) & 0xff, (address >>> 8) & 0xff, address & 0xff];
  const count = addrBytes.length + data.length + 1;
  const bytes = [count, ...addrBytes, ...data];
  const sum = bytes.reduce((a, b) => a + b, 0) & 0xff;
  const checksum = ~sum & 0xff;
  const hex = (b) => b.toString(16).padStart(2, "0").toUpperCase();
  return `S3${hex(count)}${addrBytes.map(hex).join("")}${data.map(hex).join("")}${hex(checksum)}\n`;
}

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

let original;
try {
  // ---------------------------------------------------------------- backup
  console.log("\n=== 1. back up the target flash");
  await call("jlink_halt", {});
  original = await dumpFlash();
  const initialSp = original.readUInt32LE(0);
  const resetHandler = original.readUInt32LE(4) & ~1;
  console.log(`   ${original.length} bytes, SP=0x${initialSp.toString(16)}, Reset=0x${resetHandler.toString(16)}`);
  if (
    original.length !== FLASH_SIZE ||
    initialSp < 0x20000000 ||
    initialSp > 0x20020000 ||
    resetHandler < FLASH_BASE ||
    resetHandler >= FLASH_BASE + FLASH_SIZE
  ) {
    throw new Error("the flash does not look like a Cortex-M image; refusing to continue");
  }
  fs.writeFileSync(backupPath, original);
  // A second copy in the project's git-ignored tmp/ so a reboot of the OS temp
  // directory cannot lose the only copy of the target's firmware.
  const durableDir = path.join(process.cwd(), "tmp");
  fs.mkdirSync(durableDir, { recursive: true });
  const durableBackup = path.join(durableDir, "flash-backup.bin");
  fs.copyFileSync(backupPath, durableBackup);
  console.log(`   sha256 ${sha(original).slice(0, 16)}`);
  console.log(`   second copy at ${durableBackup}`);

  // ------------------------------------------------------------ chip erase
  console.log("\n=== 2. jlink_erase (chip)");
  const erased = await call("jlink_erase", {});
  check("chip erase reports success", !erased.isError, erased.body.split("\n")[0].slice(0, 60));
  const afterErase = await dumpFlash();
  check("flash is blank after chip erase", isBlank(afterErase, FLASH_BASE, FLASH_SIZE));

  // -------------------------------------------------- argument validation
  console.log("\n=== 3. argument validation");
  const noAddress = await call("jlink_flash", { file: nativePath(backupPath) });
  check(
    "a .bin without an address is rejected",
    noAddress.isError && /address/.test(noAddress.body),
    noAddress.body.split("\n")[0].slice(0, 70),
  );
  const halfRange = await call("jlink_erase", { start: "0x08010000" });
  check(
    "erase with only start is rejected",
    halfRange.isError && /both start and end/.test(halfRange.body),
    halfRange.body.split("\n")[0].slice(0, 70),
  );
  const badExtension = await call("jlink_flash", { file: nativePath(path.join(workDir, "fake.elf")) });
  check("an unsupported extension is rejected", badExtension.isError);

  // ------------------------------------------------------ restore via .bin
  console.log("\n=== 4. jlink_flash (.bin at an address, with verify + reset)");
  const restored = await call("jlink_flash", {
    file: nativePath(backupPath),
    address: `0x${FLASH_BASE.toString(16)}`,
  });
  check("flashing the .bin reports success", !restored.isError, restored.body.split("\n")[0].slice(0, 70));
  check("the tool reports a verified write", /Verify: yes/.test(restored.body));
  check("the load address was cross-checked against the device layout", /Address check/.test(restored.body));
  const afterRestore = await dumpFlash();
  check("restored flash is byte-identical to the backup", sha(afterRestore) === sha(original), sha(afterRestore).slice(0, 16));

  // --------------------------------------------------------------- .hex
  console.log("\n=== 5. jlink_flash (.hex, addresses come from the file)");
  const hexData = Array.from({ length: 32 }, (_, i) => 0xa0 + i);
  const hexPath = path.join(workDir, "pattern.hex");
  fs.writeFileSync(hexPath, intelHex(SECTOR4.start, hexData));
  const hexResult = await call("jlink_flash", { file: nativePath(hexPath) });
  check(".hex flash reports success", !hexResult.isError, hexResult.body.split("\n")[0].slice(0, 70));
  const afterHex = await dumpFlash();
  const hexFrom = SECTOR4.start - FLASH_BASE;
  check(
    ".hex data landed at the address in the file",
    hexData.every((b, i) => afterHex[hexFrom + i] === b),
  );

  // -------------------------------------------------------------- .srec
  console.log("\n=== 6. jlink_flash (.srec)");
  const srecData = Array.from({ length: 32 }, (_, i) => 0xb0 + i);
  const srecPath = path.join(workDir, "pattern.srec");
  fs.writeFileSync(srecPath, srecord(SECTOR5.start, srecData));
  const srecResult = await call("jlink_flash", { file: nativePath(srecPath) });
  check(".srec flash reports success", !srecResult.isError, srecResult.body.split("\n")[0].slice(0, 70));
  const afterSrec = await dumpFlash();
  const srecFrom = SECTOR5.start - FLASH_BASE;
  check(
    ".srec data landed at the address in the file",
    srecData.every((b, i) => afterSrec[srecFrom + i] === b),
  );

  // ------------------------------------------------------- range erase
  console.log("\n=== 7. jlink_erase (range)");
  const range = await call("jlink_erase", { start: "0x08010000", end: "0x0801FFFF" });
  check("range erase reports success", !range.isError, range.body.split("\n")[0].slice(0, 70));
  const afterRange = await dumpFlash();
  check("the erased sector is blank", isBlank(afterRange, SECTOR4.start, SECTOR4.size));
  check(
    "the neighbouring sector was left alone",
    srecData.every((b, i) => afterRange[srecFrom + i] === b),
  );
  check(
    "the firmware region was left alone",
    sha(afterRange.subarray(0, SECTOR4.start - FLASH_BASE)) ===
      sha(original.subarray(0, SECTOR4.start - FLASH_BASE)),
  );
} catch (err) {
  console.error(`\n! aborted: ${err.message}`);
  failed += 1;
} finally {
  // ------------------------------------------------------------- restore
  console.log("\n=== 8. restore the original firmware");
  if (!original) {
    console.error("   ! no verified backup exists, so nothing was erased either. Nothing to restore.");
    failed += 1;
    await client.close();
    process.exit(1);
  }
  try {
    const restored = await call("jlink_flash", {
      file: nativePath(backupPath),
      address: `0x${FLASH_BASE.toString(16)}`,
      eraseMode: "chip",
    });
    console.log(`   ${restored.body.split("\n")[0]}`);
    const finalImage = await dumpFlash();
    const identical = sha(finalImage) === sha(original);
    check("the target holds the original firmware again", identical, sha(finalImage).slice(0, 16));
    await call("jlink_reset", {});
    const state = await call("jlink_cpu_state", {});
    console.log(`   ${state.body.split("\n")[0]}`);
  } catch (err) {
    console.error(`   ! restore failed: ${err.message}`);
    console.error(`   ! the original image is kept at: ${backupPath}`);
    failed += 1;
  }
  await client.close();
  console.log(`\n${failed === 0 ? "All flash checks passed." : `${failed} check(s) FAILED.`}`);
  console.log(`Scratch directory kept for inspection: ${workDir}`);
  process.exit(failed === 0 ? 0 : 1);
}
