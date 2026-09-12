# docs/ —— 文档统一管理

这个目录把本项目依赖的全部参考资料集中到一处，这样 AI agent 和开发者不必去 `C:\Program Files` 里翻找。

## 目录结构

```
docs/
├── README.md            本文件：索引、许可说明、同步方式
├── reference/           从已安装的 J-Link 自身提取的**事实数据**
│   ├── README.md                  本目录的生成方式与权威性说明
│   ├── jlink-version.txt          J-Link 版本与 DLL 版本
│   ├── jlink-cli-surface.txt      完整命令列表（`?` 的输出）
│   ├── jlink-reset-types.txt      13 种复位策略（`RSetType` 的输出）
│   └── vendor-manifest.md         已复制厂商文件的清单、大小、校验和
└── vendor/              SEGGER 的原始文档（版权属 SEGGER，**不适用 MIT**）
    ├── NOTICE.md                  版权声明与许可冲突说明（**必读**）
    ├── UM08001_JLink.pdf / .txt   J-Link / J-Trace 用户指南
    ├── UM08003_JFlash.pdf / .txt  J-Flash 用户指南
    ├── ReleaseNotes_JLink.html    版本发布说明
    ├── JLinkDevices.xml           补充器件定义
    └── LicenseIncGUI.txt          SEGGER 许可协议原文
```

## 许可说明：`vendor/` 已纳入版本控制，但存在许可冲突

**`docs/vendor/` 里的文件版权属于 SEGGER Microcontroller GmbH，不适用本仓库的 MIT 许可。** 完整声明见 [`vendor/NOTICE.md`](vendor/NOTICE.md)。

SEGGER 的许可协议（`vendor/LicenseIncGUI.txt`）明确禁止未经书面授权的再分发：

> "The SOFTWARE means **all J-Link / Flasher related software components included in the J-Link software & documentation pack**"
> "**Any (re)distribution or shipment of the SOFTWARE requires the prior written authorization from SEGGER in each instance.**"

本仓库是**公开**的（`api.github.com` 未认证访问返回 `"private": false`），因此把这些文件提交进来落在上述条款禁止的范围内。

这是一个**知情决定**：仓库所有者在风险被明确指出后选择仍然纳入。后果：

1. 本项目与 SEGGER 之间可能存在许可违约，责任由仓库所有者承担；
2. 根目录的 MIT 许可**不得**被解释为覆盖 `docs/vendor/` 中的任何文件。

厂商文档与代码是**分开的提交**，因此可以单独撤回：`git revert <Add SEGGER vendor documentation>`。若要恢复成「本地保留、不进版本控制」，见 `vendor/NOTICE.md` 末节。

相反，`docs/reference/` **不存在这个问题**：那些是已安装工具自身输出的简短事实数据（版本号、命令列表、复位类型枚举），性质等同于 `gcc --help` 的输出，属于事实性接口描述，不包含 SEGGER 的文档正文。

## 同步方式

```bash
npm run build          # sync 脚本会复用 dist/ 里的 J-Link 路径解析逻辑
npm run docs:sync
```

脚本会：

1. 定位本机 J-Link 安装目录（复用 `src/config.ts` 的 `resolveJLinkPath()`，含 `JLINK_PATH` 覆盖）；
2. 复制上表列出的厂商文件到 `docs/vendor/`；
3. 若存在 `pdftotext`（poppler），把 PDF 转成可用 grep 的文本；
4. 调用 J-Link 抓取版本信息、完整命令列表、复位类型，写入 `docs/reference/`；
5. 生成 `docs/reference/vendor-manifest.md` 记录来源路径、大小与 SHA-256。

脚本可重复执行，幂等。缺少 `pdftotext` 时只会跳过文本转换并给出提示，其余照常完成。

## 版本注记

**手册版本与软件版本不完全一致。** 本机安装的是 J-Link 软件 **7.52a**（2021-07-28 编译），但随附的 UM08001 标注的是 **Software Version 7.50**（2021-07-01）。因此当两者表述冲突时，以**实测行为**和**`?` 输出**为准，手册作为佐证。详见 `AGENTS.md` 的「权威文档来源」一节。

## 检索示例

```bash
# 查某个 J-Link Command String 的权威定义
grep -n -A6 '7.14.1.70 SetRestartOnClose' docs/vendor/UM08001_JLink.txt

# 查命令字符串总表
sed -n '/7.14.1 List of available commands/,/7.14.2/p' docs/vendor/UM08001_JLink.txt

# 查某条 Commander 命令的语法
grep -n -i 'loadfile' docs/reference/jlink-cli-surface.txt

# 查某个器件
grep -i 'STM32F411' docs/vendor/JLinkDevices.xml
```
