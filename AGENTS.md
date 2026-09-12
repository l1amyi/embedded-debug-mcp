# AGENTS.md —— 给 AI 编码助手的项目说明

本文件是**强制阅读**的项目背景。它记录了这个 MCP 服务器的架构约束、**已经过硬件验证的事实**、以及一批会让你浪费大量时间的陷阱。修改代码前请先读完「陷阱清单」。

**与用户沟通使用中文。**

---

## 1. 项目是什么

`jlink-mcp` 是一个 MCP 服务器，通过 SEGGER J-Link 探头调试单片机：烧录固件、暂停/恢复 CPU、读写内存与寄存器、断点、以及 Cortex-M 故障诊断。

核心架构决策：**不使用长驻交互式会话，而是「每次工具调用启动一个全新的 JLink.exe 进程，跑一个脚本文件」**。原因见 `src/jlink.ts` 顶部注释（管道 stdout 块缓冲、stdin EOF 会疯狂自旋、脚本必须 CRLF）。

这个决策带来一条贯穿全局的推论：**目标状态不会跨调用自动保留**（详见陷阱 3、5、7）。

## 2. 权威文档来源（按可信度排序）

**优先级从高到低。冲突时，下位服从上位。**

| 级别 | 来源 | 位置 / 说明 |
| --- | --- | --- |
| 1 | **本机硬件实测** | 最高权威。文档说 A、实测是 B，就是 B。本项目已有多处文档/直觉被实测推翻。 |
| 2 | **已安装 J-Link 自身输出** | `docs/reference/`（由 `npm run docs:sync` 生成）。逐命令语法的**唯一**权威。 |
| 3 | **本机随附手册 UM08001** | `docs/vendor/UM08001_JLink.txt`（PDF 的可检索文本版）。 |
| 4 | 本机器件库 | `docs/vendor/JLinkDevices.xml`；完整导出用 `JLink.exe ExpDevList`。 |
| 5 | [SEGGER 在线 KB](https://kb.segger.com/) | **描述的是最新版**，已确认多处与本机 7.52a 不符（见 §2.4）。 |

### 2.1 文档已统一收集在 `docs/`

**不要再去 `C:\Program Files` 里翻找。** 所有参考资料集中在 `docs/`：

```bash
npm run build && npm run docs:sync   # 从本机 J-Link 安装目录重新收集
```

- `docs/reference/` —— 工具自身输出的事实数据（版本、命令列表、复位类型、厂商文件清单）。无需探头即可检索。
- `docs/vendor/` —— SEGGER 的版权文档（PDF + 提取出的 `.txt`）。包含 UM08001、UM08003、ReleaseNotes、JLinkDevices.xml 及许可原文。

**许可冲突（已知并已被所有者接受）：** `docs/vendor/` 的版权属 SEGGER，其许可禁止未经书面授权的再分发（"Any (re)distribution ... requires the prior written authorization from SEGGER"），而本仓库是**公开**的（已验证 `"private": false`）。这是仓库所有者在知情前提下作出的决定，责任由所有者承担。**根目录的 MIT 许可不覆盖 `docs/vendor/`。**

因此，处理这些文件时：**不要把它们当作本项目的作品**，不要声称它们适用 MIT；要引用时以 `docs/vendor/NOTICE.md` 为准。厂商文档与代码是**分开的提交**，可单独 `git revert`。详见 `docs/README.md`。

### 2.2 版本注记（重要，避免误用）

本机 J-Link 软件是 **7.52a**（2021-07-28 编译），但随附的 UM08001 手册标注的是 **7.50**（2021-07-01）。**两者并非严格同版本。** 并且 7.52a 的手册正文**没有逐命令参考**（第 3.2 节只有命令行参数与 Command File 用法）。所以逐命令语法只能查 `docs/reference/jlink-cli-surface.txt`。

### 2.3 检索示例

```bash
# 命令字符串的权威定义（UM08001 7.14.1.70）
grep -n -A6 '7.14.1.70 SetRestartOnClose' docs/vendor/UM08001_JLink.txt

# 命令字符串总表
sed -n '/7.14.1 List of available commands/,/7.14.2/p' docs/vendor/UM08001_JLink.txt

# Commander 逐命令语法
grep -n -i 'loadfile' docs/reference/jlink-cli-surface.txt

# 复位类型
cat docs/reference/jlink-reset-types.txt
```

**陷阱：7.52a 的 `? <命令>` 会忽略参数，只输出完整列表**，不能用它查单条命令。

### 2.4 已知的「在线 KB ≠ 本机 7.52a」实例

| 项目 | 在线 KB（最新版） | 本机 7.52a（以此为准） |
| --- | --- | --- |
| `loadfile` 支持的扩展名 | .bin .elf .hex .mot .s .s19 .s37 .srec | **仅 .bin .mot .hex .srec**（无 .elf / .s19） |
| `RSetType` 复位类型 | Cortex-M 只列 0/1/2/12 | **0–12 共 13 种**（用 `RSetType` 无参数可列出） |
| `loadfile` 的 `noreset` 参数 | 有文档 | `?` 输出中**未列出**，不要据此改动 |

**教训：改命令行为前，先查本机 `?` 输出，再查本机手册，最后才是在线 KB。**

## 3. 构建与验证

```bash
npm install
npm run build                       # tsc
npm run docs:sync                   # 收集本机 J-Link 文档到 docs/（见 §2.1）
npm run smoke                       # 不需要目标板：探测 + 器件库 + 错误路径
npm run hardware                    # 需要上电的目标板；会暂停并复位 CPU
npm run flash -- --yes-destroy-flash  # 破坏性：擦写 flash，最后自动还原原镜像
node scripts/hardware-check.mjs STM32F411CE
```

`npm run hardware` 是硬件在环测试（**21 项**），退出码非 0 表示有问题。**改完代码必须跑它**，并确认 `hardware-check.mjs` 里 `-> ok` 的数量。

改动涉及 `src/devices.ts` / `src/faults.ts` / `src/parse.ts` 的纯逻辑时，smoke 测试覆盖不到 —— 需要临时脚本或直接调用。

### 端到端验证（拿真实固件跑一遍）

`test_project/` 是唯一一个「我们知道它应该干什么」的固件，因此是端到端基准。

**方式一：Keil（本机当前用的，实测通过）**

```bash
cd test_project
"/c/Keil_v5/UV4/UV4.exe" -b "$(cygpath -w MDK-ARM/test_project.uvprojx)" -j0 -o "$(cygpath -w build.log)"
cd ..
HEX="$(cygpath -m "$PWD/test_project/MDK-ARM/test_project/test_project.hex")" node scripts/verify-blink.mjs
```

**方式二：GCC（已实测通过）**

工具链 **Arm GNU Toolchain 15.3.1** + Ninja。实测 **0 错误 0 警告，没有 C23 问题**：

```bash
export PATH=/path/to/arm-gnu-toolchain-15.3.rel1/bin:$PATH
cd test_project
cmake --preset Debug && cmake --build --preset Debug
arm-none-eabi-objcopy -O ihex build/Debug/test_project.elf build/Debug/test_project.hex
```

**⚠️ 不要用 Git Bash 的 `unzip` 解压那个 zip** —— 它把 2.1 MB 的 `arm-none-eabi/bin/ld.exe` 解压成了 **0 字节**，而 `unzip -t` 依旧报 "No errors detected"。唯一症状是链接时报 `collect2.exe: fatal error: CreateProcess: No such file or directory`。用 7-Zip 或官方 `.exe` 安装器；事后可把 zip 条目大小与磁盘逐一对比（实测 7360 个里坏了这 1 个）。

**验证思路很值得复用**：`verify-blink.mjs` 在**单个 J-Link 会话内**用 `Sleep` 间隔连续采样 `mem32`，而不是每次新建进程。后者在 250 ms 半周期下会严重混叠，根本看不出翻转规律。

## 4. 已验证硬件环境与实测数据

- 探头：J-Link V11，S/N `941000024`，固件 2025-04-01，授权含 `RDI, FlashBP, FlashDL, JFlash, GDB`
- 软件：**J-Link V7.52a**（2021-07-28），Windows
- 目标：**STM32F411CE**，Cortex-M4 r0p1，CPUID `0x410FC241`，SWD @ 4000 kHz
- 目标 flash `0x08000000` (512 KiB)，RAM `0x20000000` (128 KiB)
- 该板固件：初始 SP `0x20007DE8`，Reset_Handler `0x08000339`，主循环紧循环在 `0x08004336`–`0x0800433E` 附近（`run_to` 测试可用它当必定命中的目标）。**完整备份在 `tmp/flash-backup.bin`（sha256 `e8592443c930f083`）**
- **测试固件 `test_project/`**：CubeMX 工程，PC13 上 2 Hz LED 闪烁，Keil ARMCC 与 GCC 两条路径都能编译并已在硬件上验证。这是唯一一个「知道预期行为」的固件，所以端到端验证以它为基准。

### 断点开销（等待 1500 ms 未命中）

| 断点 | 用时 |
| --- | --- |
| 无（基线） | 1770 ms |
| RAM + `S` | 1770 ms |
| RAM + `H` | 1774 ms |
| flash + `H` | 1764 ms |
| flash + **`S`** | **6538 ms** |
| flash + `S`，且 `exec DisableFlashBPs` | **1771 ms** |

### 器件库

`ExpDevList` 导出 8621 个内置器件；`JLinkDevices.xml` 另有 241 个内置列表没有的名字。缓存于 `%TEMP%/jlink-mcp/device-list.json`，按 JLink.exe 的 mtime 失效。

### Flash 烧录（`npm run flash -- --yes-destroy-flash`）

已完整验证：芯片擦除后全为 0xFF；`.bin` 无地址被拒；`erase` 只给 `start` 被拒；不支持的扩展名被提前拒绝；`.bin` 带地址 + `verifybin` 后与备份逐字节一致；`.hex`/`.srec` 数据落在文件内声明地址；范围擦除只影响目标扇区且不碰邻区与固件区；最后原镜像逐字节还原（SHA-256 一致），CPU 恢复正常运行。

测试脚本先备份整个 flash 并**校验镜像合理性**（初始 SP 落在 SRAM、Reset Handler 落在 flash 且有 Thumb 位），校验不过就拒绝擦除。备份另存一份到 gitignore 的 `tmp/`。

**已知怪癖**：本版本 `loadfile` 完成后会自行复位，且 `?` 输出中没有可抑制它的参数（在线文档里的 `noreset` 属于更新版本），所以烧录过程会出现**两次复位**。无害。

## 5. 陷阱清单

**每一条都是实际踩过并付出代价的，不要凭直觉推翻。**

1. **写命令按字节宽度命名**：`w1` / `w2` / `w4`，**不是** `w32`。读命令才是 `mem8` / `mem16` / `mem32`。搞混会得到 `Unknown command`。（曾有 `w${width}` 的真实 bug，导致所有写内存操作全部失败。）

2. **`SetBP` 的 `S`/`H` 会强制断点类型**。手册定义：`S: Force software BP`、`H: Force hardware BP`。在 flash 上强制 `S` 会让 J-Link **重写整个 flash 扇区**（慢 4.8 s，且消耗擦写寿命）。默认用 `H`。想彻底禁掉 flash 重写：`exec DisableFlashBPs`。

3. **`SetRestartOnClose` 必须在每个会话里重新设置**。默认 J-Link 在连接关闭时**恢复目标运行**，所以 halt 默认不跨调用保留。用 `exec SetRestartOnClose = 0`（UM08001 7.14.1.70）可关闭，但该设置不跨进程保持 —— 漏掉一次就恢复默认。`JLINK_PERSIST_HALT=1` 会自动给每个脚本加上。

4. **`exec` 执行 command string 只能在「连接建立之后」生效**（UM08001 明说）。所以连接期设置（如 `SetRTTTelnetPort`）在 Commander 里无效。

5. **Cortex-M 复位后 J-Link 一定会让 CPU 停住**。所有 Cortex-M 复位策略都会设置 `DEMCR.VC_CORERESET`。所以 `r` 之后 CPU 是**停止在复位向量**的，需要显式 `g` 才会运行。（曾有 `jlink_reset` 无条件报告 "CPU running" 的 bug。）

6. **裸 `mem32` 会做 halt/restore 循环**，副作用是**把已暂停的 CPU 恢复运行**。需要一致快照或保持暂停，用 `halt: true`。

7. **每次调用都是新进程，连接期间目标已经在跑**。所以「复位后在 Reset_Handler 下断点」这种跨调用玩法不可靠 —— 连接阶段固件已经跑过去了。断点必须在**同一个会话**里设置并等待（`jlink_run_to` 就是这么设计的）。

8. **JavaScript 位运算会转成有符号 int32**。`(0xFFFFFFFD & 0xff000000) === 0xff000000` 是 `false`（得到 `-16777216`）。处理 `EXC_RETURN` 这类高位为 1 的值必须用 `>>> 24 === 0xff`。（这个 bug 曾让异常帧恢复静默失效。）

9. **`rreg`/`wreg` 不接受 `R13` / `R15` / `SP` / `PC` / `LR`**，尽管 J-Link 自己会把它们列出来。写 PC 用 `SetPC`，写栈用 `MSP` / `PSP`。给非法名字时 J-Link 会打印完整合法列表。

10. **7.52a 的 `? <命令>` 忽略参数**，只输出完整列表。

11. **`Regs` 输出里 `rreg` 的值带 `0x` 前缀，`Regs` 的不带**。`parseRegisters` 只接受不带前缀的十六进制，所以解析用 `Regs`，不要用 `rreg`。

12. **`g` 作用在已运行的 CPU 上会报错** `****** Error: CPU is not halted`。这是**状态报告不是故障**。故障检测因此改成逐行匹配（`benignPatterns`），因为整段匹配只能拿到 `Error:` 这个子串，无法分辨状态与真错误。

13. **Git Bash 的 `/tmp` 不是 `C:\tmp`**。传给 MCP 工具的 Windows 路径要用 `cygpath -w` 或 `cygpath -m` 转换。另外 **MSYS 会把 `cmd.exe /C` 的 `/C` 当路径转换**，要写成 `cmd.exe //C`。
14. **GCC 15 起默认 C 标准是 C23**（此前 C17），GCC 官方说这会造成大量老项目编译中断。当前这份 STM32F4 HAL 实测**没有**被影响（0 警告），但若以后出现怪异报错，先加 `-std=gnu11` 排除。
15. **解压工具会静默损坏大文件。** Git Bash 的 `unzip` 曾把 2.1 MB 的 `ld.exe` 解压成 0 字节，而 `unzip -t` 仍报无错。**不要只信压缩包的完整性测试** —— 要逐条对比归档记录的大小与磁盘实际大小。

## 6. 代码结构

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | MCP 服务器入口，stdio 传输。stdout 只用于 JSON-RPC，诊断一律走 stderr。 |
| `src/config.ts` | 环境变量配置（getter 形式，读取时求值）、`JLinkError`、JLink 可执行文件定位。 |
| `src/jlink.ts` | 生成脚本、启动进程、超时/输出上限/交互提示检测、**逐行故障检测**、`benignPatterns`。 |
| `src/tools.ts` | 全部 18 个工具注册 + 共享辅助（`guard` / `execute` / `resolveTarget` / `failure`）。 |
| `src/devices.ts` | `ExpDevList` 导出 + XML 补充 + 磁盘缓存 + 模糊搜索 + 器件名校验。 |
| `src/faults.ts` | Cortex-M 故障寄存器解码 + `EXC_RETURN` 解码 + 异常帧重建。 |
| `src/parse.ts` | 寄存器/内存/探测状态解析，寄存器名规范化，地址与数值解析。 |
| `scripts/smoke.mjs` | 无需硬件的端到端测试。 |
| `scripts/hardware-check.mjs` | 21 项硬件在环测试。 |
| `scripts/flash-test.mjs` | **破坏性** flash 测试（擦写 + 还原），需 `--yes-destroy-flash`。 |
| `scripts/verify-blink.mjs` | 烧录 `test_project` 并从调试器验证 PC13 在翻转。 |
| `scripts/sync-vendor-docs.mjs` | 把本机 J-Link 文档与 CLI 事实收集到 `docs/`。 |
| `test_project/` | 硬件测试固件：STM32F411CEU6，PC13 LED 2 Hz 闪烁。Keil 与 GCC 两条构建路径。 |
| `docs/reference/` | 可提交的事实数据（命令列表、复位类型、版本、清单）。 |
| `docs/vendor/` | SEGGER 版权文档。**已提交但版权属 SEGGER、不适用 MIT**，详见 §2.1 与 `docs/vendor/NOTICE.md`。 |

## 7. 尚未验证的区域

- **SWO / RTT 未实现**。7.52a 的 Commander **没有任何 RTT 命令**（以 `?` 输出为准）；RTT 只能靠 `JLinkRTTLogger.exe` / `JLinkRTTViewer.exe` 或 JLinkARM DLL。SWO 有 `SWOStart`/`SWORead`/`SWOShow` 等命令，可脚本化，但需要 SWO 引脚接线。
- **`jlink_fault_info` 的异常帧恢复**只在「`LR` 仍持有 `EXC_RETURN`」时可靠（即 `HardFault_Handler: b .` 这种没有压栈/没有调用函数的处理程序）。处理程序里调用过函数就恢复不了，工具会说明并建议改用 `jlink_run_to` 在入口下断点。
- **Zone / MEM-AP 语法**（`mem32 AHB-AP (AP1):0x20000000, 4`）已在 `?` 输出中确认存在，但没有工具暴露它，本板只有 AP[0]，也无从验证。

## 8. 开发准则

1. **先查文档，再改代码，最后用硬件验证。** 顺序不能颠倒。
2. **优先查本机 `?` 输出和本机手册**，不要直接照搬在线 KB（见 §2.3）。
3. **新行为必须可验证。** 加工具/加参数时，同步扩展 `scripts/hardware-check.mjs`，让回归可自动发现。
4. **错误信息要能直接指导下一步。** 好的例子：`J-Link has no device called "STM32F411X" ... Hint: J-Link knows similarly named devices: ...`、`SP has no writable alias; use MSP or PSP`。
5. **危险操作要保守**：会擦写目标 flash 的操作（`flash` / `erase`）在未获用户明确同意前不要在真机上执行。即使获得了同意，也**先备份并校验镜像合理性再擦除**（参考 `scripts/flash-test.mjs`）。
6. **验证固件行为靠寄存器采样，不靠猜**。看不见 LED 也能验证它在闪：在**同一个会话内**连续采样 `GPIOC->ODR` 的 bit13。注意每次调用结束会恢复目标运行，所以跨调用写入寄存器会被运行中的固件立即覆盖。
7. **文档与代码一致**：改了行为就同步 `README.md` 与本文件的实测数据，不要留下过时结论。
8. **注释解释「为什么」**，尤其是那些看起来多余、实际是为绕开上述陷阱的代码 —— 否则后来者（包括你自己）会把它们「优化」掉。
