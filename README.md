# CodexDesktop-LxRebuild

将 Codex Desktop 官方 Windows 商店包重新打包为 **Windows x64 免安装 ZIP**，通过 GitHub Actions 自动检查上游版本、构建并发布到 Releases。

[![Windows 构建](https://github.com/liuxinshuo/CodexDesktop-LxRebuild/actions/workflows/sync.yml/badge.svg?branch=main)](https://github.com/liuxinshuo/CodexDesktop-LxRebuild/actions/workflows/sync.yml)

**[下载最新版](https://github.com/liuxinshuo/CodexDesktop-LxRebuild/releases/latest)** · [历史版本](https://github.com/liuxinshuo/CodexDesktop-LxRebuild/releases) · [构建记录](https://github.com/liuxinshuo/CodexDesktop-LxRebuild/actions/workflows/sync.yml)

> 本项目提供非官方重打包版本。当前正式构建仅支持 Windows x64。

## 下载与启动

1. 打开 [最新 Release](https://github.com/liuxinshuo/CodexDesktop-LxRebuild/releases/latest)，在 **Assets** 中下载 `Codex-win-x64-<App版本>-cli-<CLI版本>.zip`。
2. 解压到一个新目录。
3. 双击 `启动 Codex.cmd` 或 `ChatGPT.exe`。

新版使用 ChatGPT 桌面宿主，`ChatGPT.exe` 是当前程序入口。Release 中的 `Source code (zip)` 和 `Source code (tar.gz)` 是仓库源码，不是可运行的程序包。

## 更新已有版本

| 你的情况 | 选择哪个包 | 更新方式 |
| --- | --- | --- |
| 首次使用，或没有可用增量包 | 全量 ZIP | 解压到新目录后运行 |
| 本地 App 与 CLI 版本均匹配增量包标明的旧版 | `update-from` 增量 ZIP | 完全退出程序后，解压到原程序目录并替换全部文件 |
| 本地版本不匹配，或跳过多个版本 | 最新全量 ZIP | 解压到新目录；也可按对应版本顺序安装增量 |

**使用增量包前，请确认：**

- 在原程序目录的 `build-info.json` 中查看 App 和 CLI 版本，两者都必须与增量包的旧版一致。
- 完全退出程序，包括后台进程。
- 解压目标为原来包含 `ChatGPT.exe` 的目录，保留 ZIP 内部目录结构并选择替换全部文件。

每个 Release 都提供全量包；只有可以安全覆盖旧版时，才会额外提供增量包。首次发布没有旧包作为基线，仅提供全量包。历史版本不会自动补发增量，具体以 Release 附件为准。

附件命名：

```text
Codex-win-x64-<App版本>-cli-<CLI版本>.zip
Codex-win-x64-<新App版本>-cli-<新CLI版本>-update-from-<旧App版本>-cli-<旧CLI版本>.zip
SHA256SUMS.txt
```

增量包包含新增或内容变化的完整文件。构建时会校验旧包 SHA256，并验证覆盖后的文件和目录与新版全量包一致。若新版删除文件、调整目录或改变文件类型，无法通过直接覆盖得到一致结果，本次只发布全量包，并在 Release 说明原因。`app.asar` 和大型 EXE 变化时仍需整文件下载，增量包不保证总是很小。

### 校验下载文件

`SHA256SUMS.txt` 列出本次发布的 ZIP 校验值。在下载目录运行以下 PowerShell 命令，再与校验文件中的值对比：

```powershell
Get-FileHash -LiteralPath '实际下载的文件名.zip' -Algorithm SHA256
```

## 自动构建与发布

正式流程：[`.github/workflows/sync.yml`](.github/workflows/sync.yml)。所有构建步骤在 GitHub 云端运行，无需本地部署，也无需保持自己的电脑开机。

| 项目 | 当前配置 |
| --- | --- |
| 定时检查 | 每天北京时间 05:43（UTC 21:43） |
| 手动构建 | Actions → Build Codex Desktop for Windows → Run workflow |
| 强制重建 | 手动运行时勾选 `force_build` |
| 发布位置 | 本仓库 GitHub Releases |
| 构建授权 | Actions 自带的 `GITHUB_TOKEN`，工作流声明 `contents: write` |

构建流程：

1. 检查 Microsoft Store Windows 包版本和 npm 官方 `@openai/codex` CLI 版本，已发布的版本组合会跳过打包。
2. 下载 Windows x64 MSIX，解包桌面程序并应用 `app.asar` 补丁。
3. 使用当前官方 CLI 版本替换 `codex.exe` 及三个配套程序。
4. 生成全量 ZIP；存在可用旧包时，尝试生成并验证增量 ZIP。
5. 生成 SHA256 校验文件，发布到本仓库 Releases，并核对附件名称和大小。

打包前会检查侧栏项目排序：命中“切换手动／最近更新后项目顺序不变”的已知代码结构时，按项目和会话的最新活动修复“最近更新”，并保留手动顺序。检测不依赖固定版本号或资源文件 hash；重复执行或识别到上游已按模式排序时跳过。无法确认的上游结构会使构建失败并提示核查，避免静默发布未验证的修复。可用 `node scripts/patch-project-sort.js win --check` 只检查、不写入。

App 和 CLI 版本可在文件名、Release 说明及 `build-info.json` 中查看；Windows MSIX 包版本见 Release 说明。GitHub 定时调度可能延迟，05:43 是计划触发时间。提交代码不会立即触发正式打包；需要立即构建时，请手动运行工作流。

## 使用说明

- **自动发布与本地升级不同**：云端会自动生成新版，正式便携版仍需下载全量包或增量包更新；原客户端内置更新器已由补丁禁用。
- **组件预览**：本仓库已禁用 `Publish component updater preview` 工作流；当前下载和更新说明针对正式版本。
- **下载来源**：构建仍依赖 Microsoft Store 下载接口，CLI 来自 npm 官方包。上游下载失败时，可在 Actions 中查看日志并重试。
- **脚本维护**：自动流程跟踪官方程序和 CLI 版本，不会自动同步原作者后续修改的仓库代码。
- **运行费用**：公开仓库使用标准 GitHub-hosted runner 的运行时间免费；私有仓库会消耗账号额度。参见 [GitHub Actions 计费说明](https://docs.github.com/en/billing/concepts/product-billing/github-actions)。
- **定时任务**：公开仓库连续 60 天没有仓库活动时，GitHub 会自动禁用定时工作流，需要在 Actions 中重新启用。参见 [schedule 说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。

<details>
<summary>本地构建（可选）</summary>

需要 Node.js 24 和 7-Zip。运行 `npm test` 时，7-Zip 需要以 `7zz` 命令出现在 PATH 中。

在仓库目录执行：

```powershell
npm ci
npm test
node scripts/sync-upstream.js --force --skip-mac
node scripts/patch-all.js win
npm run build:win-x64
```

产物位于 `out/Codex-win-x64-<App版本>-cli-<CLI版本>.zip`。

</details>

## 项目来源

- 本仓库导入自 [WSGsety/rebuild-codex-desktop](https://github.com/WSGsety/rebuild-codex-desktop)，使用独立仓库构建和发布。
- 重打包流程基于 [Haleclipse/CodexDesktop-Rebuild](https://github.com/Haleclipse/CodexDesktop-Rebuild)，保留 Windows x64 Desktop 构建用途。
- Codex CLI 官方项目：[openai/codex](https://github.com/openai/codex)。
