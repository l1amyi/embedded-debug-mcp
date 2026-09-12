// Verify the built-in ELF resolver against addr2line, address by address.
import { execFileSync } from "node:child_process";
import { resolveAddresses, loadElfFunctions, lookupFunction, findAddr2Line } from "../dist/symbols.js";

const elf = process.argv[2];
const addresses = process.argv.slice(3).map((a) => Number.parseInt(a, 16));

const functions = loadElfFunctions(elf);
console.log(`parsed ${functions.length} function symbols from ${elf}`);
console.log(`addr2line: ${findAddr2Line() ?? "(not found)"}`);

const resolved = await resolveAddresses(elf, addresses);

let agree = 0;
let disagree = 0;
for (const address of addresses) {
  const ours = resolved.get(address);
  // Ground truth straight from the toolchain, one address per call so the
  // output cannot be misaligned.
  const truth = execFileSync(findAddr2Line(), ["-e", elf, "-f", "-C", `0x${address.toString(16)}`], { encoding: "utf8" })
    .split(/\r?\n/)
    .map((l) => l.trim());
  const truthFn = truth[0] === "??" ? undefined : truth[0];
  const truthWhere = truth[1] ?? "??:?";
  const truthLine = /:(\d+)/.exec(truthWhere)?.[1];

  const fnOk = (ours?.function ?? undefined) === truthFn;
  const truthHasLine = Boolean(truthLine) && truthLine !== "0";
  const lineOk = !truthHasLine || String(ours?.line ?? "") === truthLine;
  const ok = fnOk && lineOk;
  if (ok) agree += 1;
  else disagree += 1;

  console.log(
    `${ok ? "ok  " : "FAIL"} 0x${address.toString(16).padStart(8, "0")}  ` +
      `ours=${ours?.function ?? "?"}:${ours?.line ?? "?"}  ` +
      `addr2line=${truthFn ?? "?"}:${truthLine ?? "?"}`,
  );
}

// Also check the binary search directly, including the "outside any function" case.
const probe = functions[3]?.address ?? 0x08000000;
console.log(`\nlookupFunction at 0x${probe.toString(16)} -> ${lookupFunction(functions, probe)?.name ?? "none"}`);
console.log(`lookupFunction at 0x00000000 -> ${lookupFunction(functions, 0)?.name ?? "none (correct: below the image)"}`);

console.log(`\n${disagree === 0 ? "all agree" : `${disagree} mismatch(es)`} (${agree}/${addresses.length})`);
process.exit(disagree === 0 ? 0 : 1);
