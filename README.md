# jlink-mcp

An MCP server that drives a [SEGGER J-Link](https://www.segger.com/products/debug-probes/j-link/) probe to debug microcontrollers: flash firmware, halt and resume the CPU, read and write memory, registers and breakpoints, and diagnose Cortex-M faults.

Built for use with [pi](https://github.com/earendil-works/pi) and any other MCP client.

## Status

The full tool surface is implemented and the server runs end to end. Everything below was **verified on real hardware** — a J-Link V11 (S/N 941000024, firmware 2025-04-01) driving an **STM32F411CE** over SWD at 4000 kHz, with J-Link software V7.52a on Windows:

| Area | Tools | Evidence |
| --- | --- | --- |
| Probe | `jlink_status` | Reads S/N, firmware, hardware version, VTref, ITarget and pin states. |
| Device database | `jlink_devices` | 8621 built-in devices exported via `ExpDevList`, plus 241 XML-only names. |
| Connection and state | `jlink_connect`, `jlink_halt`, `jlink_resume`, `jlink_reset`, `jlink_cpu_state`, `jlink_step` | Connect reports the Cortex-M4 r0p1 core; reset and step confirmed against the running firmware. |
| Memory | `jlink_read_memory`, `jlink_write_memory` | Read the vector table and SCB; write-and-read-back confirmed in RAM. |
| Registers | `jlink_read_registers`, `jlink_write_registers` | Wrote `R0`, `R1` and `LR`, confirmed by read-back; `PC` routed through `SetPC`. |
| Breakpoints | `jlink_run_to` | Hit a breakpoint in the firmware's main loop; also verified the timeout path. |
| Faults | `jlink_fault_info` | Induced a controlled `IACCVIOL` HardFault and recovered the stacked frame, reporting the exact faulting PC. |
| Escape hatch | `jlink_exec`, `jlink_command_reference` | Ran raw Commander commands; the reference is taken from this J-Link's own `?` output. |

**Not yet verified:** `jlink_flash` and `jlink_erase`. No firmware image was programmed, because doing so would destroy the firmware already on the test board. The command sequences are built the same way as the verified ones, but treat them as untested until you point them at a board you are willing to reflash.

Several bugs were found by testing against hardware rather than by reading the documentation:

- `jlink_write_memory` emitted `w32`, but J-Link names its write commands by width in *bytes* (`w1`/`w2`/`w4`), so every write failed with `Unknown command`. Reads are different: those really are `mem8`/`mem16`/`mem32`.
- `jlink_run_to` forced a **software** breakpoint (`SetBP <addr> S`). In flash that makes J-Link reprogram the containing sector: 6538 ms versus 1764 ms for a hardware breakpoint at the same address. It now defaults to `H`.
- `jlink_reset` reported "CPU running" unconditionally, and both it and `jlink_flash` relied on `r` to leave the CPU running. `r` actually leaves it halted at the reset vector when vector catch is active, so both now issue an explicit `g`.
- `decodeExcReturn` silently failed on a JavaScript trap: bitwise operators coerce to signed int32, so `(0xFFFFFFFD & 0xff000000) === 0xff000000` compared `-16777216` against `4278190080`. Exception-frame recovery never ran until this was fixed.
- `jlink_resume` treated J-Link's `Error: CPU is not halted` as a failure; it is a state report, and failure detection had to become line-aware to express that.

## Requirements

- Node.js 18 or newer.
- SEGGER J-Link software installed (`JLink.exe` on Windows, `JLinkExe` elsewhere). Verified against V7.52a; newer releases should work but the exact command surface has not been checked.

Path resolution order: the `JLINK_PATH` environment variable, then a scan of `C:\Program Files\SEGGER`, `C:\Program Files (x86)\SEGGER`, `/opt/SEGGER` and `/usr/local/SEGGER` (including versioned `JLink_V*` directories, newest first).

## Build and verify

```bash
npm install
npm run build
```

`npm run smoke` boots the built server over stdio and exercises the tools that need no MCU: `jlink_status`, `jlink_devices`, and the error paths (a misspelled device name, an invalid Commander command).

`npm run hardware` is the hardware-in-the-loop suite. It needs a powered target and it **halts and resets** the CPU, so do not point it at something that must keep running:

```bash
node scripts/hardware-check.mjs STM32F411CE
```

It defaults to `JLINK_DEVICE`, then `STM32F411CE`, and exits non-zero if any check misbehaves.

### Reference documentation

Everything this project depends on for reference lives under `docs/`, collected by:

```bash
npm run docs:sync
```

- **`docs/reference/`** is committed. It holds facts extracted from the installed J-Link itself: its version banner, its complete command list, its reset-type list, and a manifest of what was copied. These can be grepped without a probe attached.
- **`docs/vendor/`** holds SEGGER's own documents (UM08001 and friends) as PDFs plus `pdftotext` output. **These files are SEGGER's copyright and are not covered by this project's MIT licence.** SEGGER's licence forbids redistribution without written authorisation and this repository is public, so including them here is a known conflict, deliberately accepted by the repository owner. Provenance and removal instructions are in [docs/vendor/NOTICE.md](docs/vendor/NOTICE.md); they live in a separate commit, so a single `git revert` undoes it without touching any code.

Note that the J-Link software installed here is 7.52a while its bundled UM08001 manual is labelled 7.50, so the two are not strictly the same revision — prefer the tool's own output when they disagree.

If you are working on this codebase with an AI agent, point it at [AGENTS.md](AGENTS.md) first.

## Configuration

All settings are environment variables; most can also be overridden per tool call.

| Variable | Default | Purpose |
| --- | --- | --- |
| `JLINK_PATH` | auto-detected | Full path to `JLink.exe` / `JLinkExe`. |
| `JLINK_DEVICE` | none | Default MCU name, e.g. `STM32F411CE`. Required for anything that touches the target. |
| `JLINK_INTERFACE` | `SWD` | `SWD`, `JTAG`, `FINE` or `ICSP`. |
| `JLINK_SPEED` | `4000` | Interface speed in kHz. |
| `JLINK_SERIAL` | none | Probe serial number, for setups with several probes. |
| `JLINK_TIMEOUT_MS` | `30000` | Per-invocation timeout. Raise it for large flash images. |
| `JLINK_MAX_OUTPUT` | `4194304` | Hard cap on captured J-Link output per invocation. |
| `JLINK_SKIP_DEVICE_VALIDATION` | unset | Set to `1` to stop checking device names against J-Link's list. |
| `JLINK_PERSIST_HALT` | unset | Set to `1` to stop J-Link resuming the target when a session ends, so a halt persists across calls. |
| `JLINK_DISABLE_FLASH_BP` | unset | Set to `1` to disable the FlashBP feature, so a breakpoint in flash never reprograms flash. |

The default timeout is deliberately below the 60 s request timeout most MCP clients apply, so a stuck operation returns a diagnosable error instead of the client giving up first.

## Tools

| Tool | Target needed | Purpose |
| --- | --- | --- |
| `jlink_status` | no | Probe serial number, firmware, VTref, pin states. Start here. |
| `jlink_devices` | no | Search J-Link's device list for core, flash banks and RAM. |
| `jlink_connect` | yes | Establish a debug connection and report state. |
| `jlink_cpu_state` | yes | Halted or running, and why it stopped. |
| `jlink_halt` | yes | Halt the CPU and confirm it stopped. |
| `jlink_resume` | yes | Resume the CPU. Already-running is reported, not treated as an error. |
| `jlink_reset` | yes | Reset, optionally with a specific reset strategy or a delayed halt, then report the resulting state. |
| `jlink_step` | yes | Single step N instructions and report PC. |
| `jlink_read_memory` | yes | Read memory at 8/16/32-bit width, optionally halting first for a consistent snapshot. |
| `jlink_write_memory` | yes | Write values, then read back and report mismatches. |
| `jlink_read_registers` | yes | Halt and dump core registers. |
| `jlink_write_registers` | yes | Write core registers with read-back verification. |
| `jlink_run_to` | yes | Set breakpoints, resume, wait for a hit, and report where it stopped. |
| `jlink_fault_info` | yes | Decode CFSR/HFSR and recover the stacked exception frame. |
| `jlink_erase` | yes | Chip erase, or erase an address range. |
| `jlink_flash` | yes | Program `.bin` (address required) or `.hex`/`.mot`/`.srec`. |
| `jlink_exec` | optional | Escape hatch: run arbitrary J-Link Commander commands. |
| `jlink_command_reference` | no | The commands this J-Link accepts, for use with `jlink_exec`. |

Addresses are hexadecimal by default — both `0x20000000` and `20000000` mean the same thing; pass a JSON number for decimal.

### Device names are checked against J-Link's own list

`jlink_devices` builds its answer from J-Link itself: `ExpDevList` exports the DLL's built-in list (8621 devices on 7.52a) and `JLinkDevices.xml` supplies 241 further names that the built-in list lacks. The parsed result is cached on disk and keyed to the J-Link executable's mtime, so the export cost is paid once per J-Link install.

Before connecting, the target tools check the device name against that list and fail early with suggestions:

```
Error: J-Link has no device called "STM32F411ZZ", so the target could not be connected.
Hint: J-Link knows similarly named devices: STM32F411CC, STM32F411CD, ... Set JLINK_SKIP_DEVICE_VALIDATION=1 to bypass this check.
```

This matters because J-Link's own behaviour is unhelpful: an unknown name either retries until the timeout, or is silently swapped for a different device. The check is best-effort — if the device list cannot be built at all, the server logs to stderr and proceeds.

### Register names

`rreg`/`wreg` accept `R0`-`R12`, `R14` (or `LR`), `XPSR`, `MSP`, `PSP`, `RAZ`, `CFBP`, `APSR`, `EPSR`, `IPSR`, `PRIMASK`, `BASEPRI`, `BASEPRI_MAX`, `FAULTMASK`, `CONTROL`, `IAPSR`, `EAPSR`, `IEPSR`, `FPSCR`, `FPS0`-`FPS31` and `CycleCnt`.

J-Link rejects `R13`, `R15`, `SP`, `PC` and `LR` with `Illegal register name`, which is surprising because it prints all of them in its own list. `jlink_write_registers` therefore routes `PC` through `SetPC` automatically and rejects `SP`/`R13` with a hint to use `MSP` or `PSP`.

## Using it from pi

pi's MCP gateway installs servers by URL, so a stdio server needs a small bridge. Any stdio-to-HTTP proxy works, for example:

```bash
npx -y supergateway --stdio "node dist/index.js" --port 8321 --sse
```

then install `http://localhost:8321/sse` through the gateway. Run the bridge with `JLINK_DEVICE` and friends set in its environment.

If your MCP client supports stdio servers directly, point it at `node dist/index.js` with no bridge and no arguments.

## Design notes

J-Link Commander is driven in **script mode, one fresh process per tool call**, rather than as a long-lived interactive session. Four behaviours of J-Link 7.52 on Windows forced this:

1. **Piped stdout is block-buffered.** When stdout is not a console, output is held until the buffer fills or the process exits. An interactive session that waits for the `J-Link>` prompt never receives it, so prompt-based synchronisation is impossible.

2. **Reading stdin at EOF spins forever.** If a script finishes and J-Link then reads stdin, it loops printing `Unknown command` — hundreds of megabytes in seconds. Every generated script therefore ends with an `exit` terminator so EOF is never reached, and `exit`-family commands are stripped from caller input so the terminator always stays last.

3. **Script files must use CRLF line endings.** A LF-only script is mis-parsed.

4. **Closing a session restarts the target, by default.** SEGGER states that when the debug connection is closed the target is left running, or its execution is *restarted from the pause point*. So by default a halt does not survive the call that requested it, and neither does a breakpoint. This is not a hard limit: SEGGER's remedy is the command string `SetRestartOnClose`, which is reachable only through J-Link Commander's `exec` command and applies **per session** — it does not carry over between processes, so it must be reapplied in every session. Setting `JLINK_PERSIST_HALT=1` makes this server add `exec SetRestartOnClose = 0` to every script it generates.

Note that even with that option, a bare memory read resumes the CPU: `mem32` performs a halt/restore cycle, so it leaves the core running. Use `halt: true` to keep it stopped.

Because each call is a fresh process, each one reconnects to the target (roughly a second). The compensating benefit is that no session can be left in a broken state by a crashed call.

Two consequences shape the API:

- **Tools that need a halted CPU halt within their own call.** `jlink_read_registers`, `jlink_step` and `jlink_fault_info` all issue `h` first, and `jlink_read_memory` takes `halt: true`. This is what makes them correct regardless of `JLINK_PERSIST_HALT`, since a fresh session's connect sequence cannot be assumed to preserve the state you left behind.
- **Breakpoints are set and waited on inside one session.** `jlink_run_to` combines `SetBP`, `g` and `WaitHalt` in a single process, because a breakpoint set by an earlier call is already gone. It accepts up to four addresses, all armed in that one session.

Safety rails around the J-Link process:

- Hard timeout, then the process tree is killed (`taskkill /T /F` on Windows).
- Output capped in memory; the process is killed if it exceeds the cap.
- A detector kills the process early if J-Link asks an interactive question it can never receive an answer to.
- Failure detection is **line-aware**, so a message that reports a state rather than an error can be excluded per call. This is what lets `jlink_resume` treat `****** Error: CPU is not halted` as "already running".
- Temporary script files are always cleaned up.

### Reset behaviour

SEGGER documents that **every** Cortex-M reset strategy halts the CPU after the reset, because J-Link sets `VC_CORERESET` in the DEMCR so the core stops before executing user code. A bare `r` therefore leaves the target *stopped at the reset vector*, which is a genuine surprise: `jlink_reset` used to report "CPU running" unconditionally and was simply wrong.

The tool now follows a plain reset with an explicit `g`, and asks the probe for the resulting state instead of assuming it. `haltAfterMs` maps to the `rx <ms>` form, which is the documented way to let a ROM bootloader run before the core is stopped. `resetType` exposes `RSetType`; SEGGER recommends leaving it at type 0, which lets J-Link pick the best strategy for the selected device — which is another reason the device name matters.

### Breakpoints: force hardware, or pay for flash

`SetBP` takes an `S`/`H` suffix which the [SEGGER Commander reference](https://kb.segger.com/J-Link_Commander) defines as **"S: Force software BP"** and **"H: Force hardware BP"**. That distinction matters enormously in flash, because SEGGER describes flash breakpoints as *"The J-Link software reprograms a flash sector to set or clear a breakpoint."*

Measured on the STM32F411CE, waiting 1500 ms for a breakpoint that is never reached:

| Breakpoint | Total |
| --- | --- |
| none (baseline) | 1770 ms |
| RAM, `S` | 1770 ms |
| RAM, `H` | 1774 ms |
| flash, `H` | 1764 ms |
| flash, **`S`** | **6538 ms** |
| flash, `S`, with `JLINK_DISABLE_FLASH_BP=1` | **1771 ms** |

Forcing a software breakpoint in flash cost ~4.8 s extra for set plus clear, while a hardware breakpoint at the same address was free. This is a trap worth knowing: by design *"J-Link prioritizes the use of hardware breakpoints and automatically switches to flash breakpoints once the available hardware breakpoints are exhausted"*, but an explicit `S` overrides that preference and forces the slow path. `jlink_run_to` therefore defaults to hardware breakpoints and only forces software when asked.

Setting `JLINK_DISABLE_FLASH_BP=1` goes further and turns the FlashBP feature off entirely, so J-Link can only ever use hardware comparators. Worth doing as a safety rail, because SEGGER documents two hazards on the flash-breakpoint path:

- It temporarily uses **the first 2-4 KiB of internal RAM** as a flash loader buffer (contents preserved and restored).
- **DMA engines keep running while the CPU is halted**, so a DMA that touches that RAM will corrupt the operation. SEGGER states this *"cannot be supported in a generic way to pause/temporarily disable all DMAs"*.

On a part that uses DMA heavily, disable flash breakpoints.

### Fault diagnosis

`jlink_fault_info` reads `SHCSR`, `CFSR`, `HFSR`, `MMFAR` and `BFAR`, decodes every set bit, and — when the CPU is inside a fault handler — follows the `EXC_RETURN` value in `LR` to the stack holding the exception frame and reports the **address of the faulting instruction**. Example from a deliberately induced fault:

```
A fault is latched in the System Control Block.
Current exception: HardFault (IPSR = 3)
MemManage: IACCVIOL - instruction access violation (MPU or XN region)
HardFault: FORCED - escalated from a configurable fault (see CFSR)

Stacked exception frame at 0x200003C0 (Thread mode, PSP):
Faulting instruction PC = 0xFFFFFFF0
LR at the fault = 0x08004495, xPSR = 0x61000000
```

Frame recovery needs `LR` to still hold `EXC_RETURN`, which is true for the common `HardFault_Handler: b .` idiom. If the handler has called a function, the tool says so and suggests breaking at the handler entry with `jlink_run_to` instead.

## Known limitations

- **Flash programming is untested.** See Status above.
- **No persistent session**, so each tool call pays a connection round trip (~200 ms here) and breakpoints cannot outlive a call. Halts outlive a call only with `JLINK_PERSIST_HALT=1`, and even then a bare memory read resumes the CPU.
- **Flash breakpoints cost seconds and wear flash**, unless you keep to hardware breakpoints. See above.
- **`verify` on flash is only supported for `.bin`** (`verifybin`); other formats rely on J-Link's own load verification.
- **This J-Link release loads only `.bin`, `.mot`, `.hex` and `.srec`.** The online SEGGER documentation lists `.elf`, `.s19` and `.s37` as well, but that describes a newer J-Link: 7.52a's own `?` output does not. `jlink_flash` rejects other extensions up front with the `objcopy` command needed to convert.
- **RTT is not reachable through Commander on 7.52a.** Its `?` output lists no RTT commands, so RTT needs `JLinkRTTLogger.exe` or the JLinkARM DLL rather than `jlink_exec`.
- **Watchpoints** are not wrapped: `SetWP`/`ClrWP` exist and are documented in `jlink_command_reference`, but there is no dedicated tool.

## Roadmap

- RTT, to read `SEGGER_RTT` output for `printf`-style debugging without a UART. Needs `JLinkRTTLogger.exe` or the DLL, since Commander does not expose it.
- SWO/ITM trace. Commander does expose `SWOStart`/`SWORead`/`SWOShow`, so this is scriptable but needs the SWO pin wired.
- ELF symbol resolution, so `jlink_run_to` and `jlink_fault_info` can accept `main` or `HardFault_Handler` instead of raw addresses.
- Watchpoint tools built on `SetWP`/`ClrWP`.
- GDB Server management, for stepping through code with a real debugger in parallel.
- A persistent session, if a way to force line-buffered output on Windows turns up. That would also make breakpoints durable, which `JLINK_PERSIST_HALT` alone cannot do.

## License

MIT — see [LICENSE](LICENSE).

**Exception:** the files under [`docs/vendor/`](docs/vendor/) are copyrighted documentation of SEGGER Microcontroller GmbH. They are included for reference only and are **not** covered by the MIT licence above. See [docs/vendor/NOTICE.md](docs/vendor/NOTICE.md).
