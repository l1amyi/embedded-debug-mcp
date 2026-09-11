# jlink-mcp

An MCP server that drives a [SEGGER J-Link](https://www.segger.com/products/debug-probes/j-link/) probe to debug microcontrollers: flash firmware, halt and resume the CPU, and read or write memory and core registers.

Built for use with [pi](https://github.com/earendil-works/pi) and any other MCP client.

## Status

The core debugging surface is implemented and the server runs end to end. What has been verified on real hardware:

- `jlink_status` — confirmed against a J-Link V11 (S/N 941000024), reads serial number, firmware, hardware version, VTref, target current and pin states.
- Error paths — invalid commands and unresponsive targets produce structured, actionable tool errors rather than hangs.

Not yet verified against a live MCU, because no target board was available while this was written: flash programming, memory access and register reads exercise the same command path but have not been confirmed on silicon. Treat them as untested until you point the server at a board.

## Requirements

- Node.js 18 or newer.
- SEGGER J-Link software installed (`JLink.exe` on Windows, `JLinkExe` elsewhere).

Path resolution order: the `JLINK_PATH` environment variable, then a scan of `C:\Program Files\SEGGER`, `C:\Program Files (x86)\SEGGER`, `/opt/SEGGER` and `/usr/local/SEGGER` (including versioned `JLink_V*` directories, newest first).

## Build

```bash
npm install
npm run build
```

Verify the server boots and talks to the probe:

```bash
npm run smoke
```

The smoke test lists the registered tools, calls `jlink_status` (which needs only the probe, not an MCU) and checks that a failing command surfaces as a clean error.

## Configuration

All settings are environment variables; every one can also be overridden per tool call.

| Variable | Default | Purpose |
| --- | --- | --- |
| `JLINK_PATH` | auto-detected | Full path to `JLink.exe` / `JLinkExe`. |
| `JLINK_DEVICE` | none | Default MCU name, e.g. `STM32F407VG`. Required for anything that touches the target. |
| `JLINK_INTERFACE` | `SWD` | `SWD`, `JTAG`, `FINE` or `ICSP`. |
| `JLINK_SPEED` | `4000` | Interface speed in kHz. |
| `JLINK_SERIAL` | none | Probe serial number, for setups with several probes. |
| `JLINK_TIMEOUT_MS` | `30000` | Per-invocation timeout. Raise it for large flash images. |
| `JLINK_MAX_OUTPUT` | `4194304` | Hard cap on captured J-Link output per invocation. |

The default timeout is deliberately below the 60 s request timeout most MCP clients apply, so a stuck operation returns a diagnosable error instead of the client giving up first.

## Tools

| Tool | Target needed | Purpose |
| --- | --- | --- |
| `jlink_status` | no | Probe serial number, firmware, VTref, pin states. Start here. |
| `jlink_connect` | yes | Establish a debug connection and report state. |
| `jlink_halt` | yes | Halt the CPU. |
| `jlink_resume` | yes | Resume the CPU. |
| `jlink_reset` | yes | Reset, optionally halting after N ms. |
| `jlink_step` | yes | Single step N instructions and report PC. |
| `jlink_read_memory` | yes | Read memory or peripheral registers at 8/16/32-bit width. |
| `jlink_write_memory` | yes | Write values, then read back and report mismatches. |
| `jlink_read_registers` | yes | Halt and dump core registers. |
| `jlink_erase` | yes | Chip erase, or erase an address range. |
| `jlink_flash` | yes | Program `.bin` (address required) or `.hex`/`.elf`/`.s19`/`.srec`. |
| `jlink_exec` | optional | Escape hatch: run arbitrary J-Link Commander commands. |
| `jlink_command_reference` | no | Static list of supported commands, for use with `jlink_exec`. |

Addresses are hexadecimal by default — both `0x20000000` and `20000000` mean the same thing; pass a JSON number for decimal.

## Using it from pi

pi's MCP gateway installs servers by URL, so a stdio server needs a small bridge. Any stdio-to-HTTP proxy works, for example:

```bash
npx -y supergateway --stdio "node dist/index.js" --port 8321 --sse
```

then install `http://localhost:8321/sse` through the gateway. Run the bridge with `JLINK_DEVICE` and friends set in its environment.

If your MCP client supports stdio servers directly, point it at `node dist/index.js` with no bridge and no arguments.

## Design notes

J-Link Commander is driven in **script mode, one fresh process per tool call**, rather than as a long-lived interactive session. Three behaviours of J-Link 7.52 on Windows forced this:

1. **Piped stdout is block-buffered.** When stdout is not a console, output is held until the buffer fills or the process exits. An interactive session that waits for the `J-Link>` prompt never receives it, so prompt-based synchronisation is impossible.

2. **Reading stdin at EOF spins forever.** If a script finishes and J-Link then reads stdin, it loops printing `Unknown command` — hundreds of megabytes in seconds. Every generated script therefore ends with an `exit` terminator so EOF is never reached, and `exit`-family commands are stripped from caller input so our terminator always stays last.

3. **Script files must use CRLF line endings.** A LF-only script is mis-parsed.

Because each call is a fresh process, each one reconnects to the target (roughly a second). Target state that lives in silicon — halted or running — persists across calls, but nothing else does. The compensating benefit is that no session can be left in a broken state by a crashed call.

Safety rails around the J-Link process:

- Hard timeout, then the process tree is killed (`taskkill /T /F` on Windows).
- Output capped in memory; the process is killed if it exceeds the cap.
- A detector kills the process early if J-Link asks an interactive question it can never receive an answer to.
- Temporary script files are always cleaned up.

## Known limitations

- **A wrong device name fails slowly, and can fail silently.** J-Link retries a failing connection for a long time, which shows up as a timeout; separately, it may substitute a different device from its own list instead of rejecting an unknown name. Confirm the device name independently.
- **No persistent session**, so each tool call pays a connection round trip.
- **`verify` on flash is only supported for `.bin`** (`verifybin`); `.hex`/`.elf` images rely on J-Link's own load verification.
- **Register writes** are not exposed as a dedicated tool — use `jlink_exec` with `w4 <reg>, <value>`.
- The device database (`JLinkDevices.xml`) is deliberately *not* used for pre-validation: it holds only ~241 supplementary devices, so it lacks common parts such as `STM32F407VG` and would reject valid names.

## Roadmap

- RTT: read and stream `SEGGER_RTT` output, for `printf`-style debugging without a UART.
- SWO: ITM trace and `printf` over the SWO pin.
- GDB Server management, for stepping through code with a real debugger in parallel.
- A persistent session, if a way to force line-buffered output on Windows turns up.

## License

MIT — see [LICENSE](LICENSE).
