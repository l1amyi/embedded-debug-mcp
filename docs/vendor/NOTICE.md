# NOTICE —— 本目录的第三方文档

**本目录中的文件不是本项目的作品，也不适用仓库根目录 `LICENSE` 中的 MIT 许可。**
除本文件（`NOTICE.md`）外，其余文件的版权均属于 **SEGGER Microcontroller GmbH**。

## 来源

全部复制自本机安装的 SEGGER J-Link 软件包，由 `npm run docs:sync` 完成：

| 文件 | 说明 |
| --- | --- |
| `UM08001_JLink.pdf` / `.txt` | J-Link / J-Trace 用户指南（手册标注 7.50，随软件 7.52a 提供） |
| `UM08003_JFlash.pdf` / `.txt` | J-Flash 用户指南 |
| `ReleaseNotes_JLink.html` | J-Link 软件版本发布说明 |
| `JLinkDevices.xml` | J-Link 补充器件定义 |
| `LicenseIncGUI.txt` | SEGGER 许可协议原文 |

`.txt` 是用 `pdftotext -layout` 从对应 PDF 提取的文本，版权同样属于 SEGGER。
来源路径、大小与 SHA-256 校验和见 [`../reference/vendor-manifest.md`](../reference/vendor-manifest.md)。

## 已知的许可冲突（请勿忽视）

`LicenseIncGUI.txt` 中写明：

> "The SOFTWARE means **all J-Link / Flasher related software components included in the J-Link software & documentation pack**"
> "**Any (re)distribution or shipment of the SOFTWARE requires the prior written authorization from SEGGER in each instance.**"
> "Licensee is entitled to make copies of the SOFTWARE for **backup purposes only**."

**把本目录提交进一个公开的代码仓库，属于上述条款禁止的再分发行为，而本项目并未取得 SEGGER 的书面授权。**

这是一个**知情决定**：仓库所有者在风险被明确指出后选择仍然纳入。它带来两个后果：

1. 本项目与 SEGGER 之间可能存在许可违约，相关责任由仓库所有者承担；
2. 根目录的 MIT 许可**不得**被解释为覆盖本目录中的任何文件。两者冲突时以本 NOTICE 为准。

## 如何撤销

厂商文档与代码是**分开的提交**，因此可以单独撤回而不影响任何代码：

```bash
git log --oneline -- docs/vendor      # 找到 "Add SEGGER vendor documentation"
git revert <commit>
```

若只想恢复成「本地保留、不进版本控制」：

```bash
git rm -r --cached docs/vendor
printf 'docs/vendor/\n' >> .gitignore
npm run docs:sync                     # 任何时候都能重新生成
```

## 建议

若需长期在版本控制中保留这些文档，正确做法是先取得 SEGGER 的书面授权；
更简单的替代方案是让它们保持在本地（`docs/vendor/` 重新加入 `.gitignore`），
用 `npm run docs:sync` 在任何装有 J-Link 软件的机器上一键重建。
详见 [`../README.md`](../README.md)。
