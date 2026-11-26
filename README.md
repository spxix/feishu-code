# CodeLark

<p align="center">
  <img src="docs/assets/readme/codelark-logo.png" alt="CodeLark logo" width="280">
</p>

> 你的下一次Vibe Coding，何必从终端开始？以一流的 UI 界面和智能体协作，work ALL in 飞书。

- 本仓库（含 Antigravity 支持）：[GitHub (`spxix/feishu-code`)](https://github.com/spxix/feishu-code)
- 上游项目：[huiyeruzhou/codelark](https://github.com/huiyeruzhou/codelark)（[使用文档](https://huiyeruzhou.github.io/site/codelark/)）
- 基于上游版本：`codelark@0.5.1`

## 核心能力

| 能力 | 怎么用 | 入口 |
| --- | --- | --- |
| 共享本地 runtime 会话 | 在飞书上继续本地 Codex / Claude Code / Kimi Code / Cursor Agent / ZCode / Antigravity 对话，用可视化面板选择要接管的线程。 | `/t` |
| 流式卡片输出 | 将模型思考、工具调用、长任务进度和最终结果渲染成飞书卡片，对话留痕且可追踪。 | 普通消息 |
| 群聊 = Session | 一个群聊对应一个 session，用群聊名称管理任务；多线并行时一键拉起新群。 | `/new`、`/t rename <名称>` |
| Multi-Agent 协作 | Agent 可以发现其他 CodeLark 群聊、创建专用任务群，并把普通输入或 slash 命令交给另一个 Agent；两端都会显示可核对的收发卡片。 | 自然语言委派、`codelark sessions` |
| 云文档驱动开发 | 模型可以生成云文档；在云文档评论中 `@bot` 会直接按文档创建长线群聊，后续评论转发到群内处理。 | 云文档评论 |

## Showcase

> 第一次使用请看 [5 分钟日常工作流](https://huiyeruzhou.github.io/site/codelark/guide/daily-workflow)；设计模块和源码入口见 [CodeLark 设计文档](https://huiyeruzhou.github.io/site/codelark/product/)。


<table>
  <tr>
    <td width="50%" align="center">
      <img src="docs/assets/readme/showcase-cloud-document-chat.png" alt="CodeLark 云文档评论入口与群聊协作" style="width: 100%; max-width: 420px;">
    </td>
    <td width="50%" align="center">
      <img src="docs/assets/readme/showcase-workbench-card.png" alt="CodeLark 飞书工作台与流式卡片" style="width: 100%; max-width: 420px;">
    </td>
  </tr>
  <tr>
    <td colspan="2" align="center">
      <img src="docs/assets/readme/showcase-session-management.jpg" alt="CodeLark 会话管理" style="width: 100%; max-width: 840px;">
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="docs/assets/readme/showcase-session-control.png" alt="CodeLark Session 控制面板" style="width: 100%; max-width: 420px;">
    </td>
    <td width="50%" align="center">
      <img src="docs/assets/readme/shocase-runtime-control.png" alt="CodeLark Runtime 控制面板" style="width: 100%; max-width: 420px;">
    </td>
  </tr>
</table>


## 快速开始

### 依赖

- Node.js 24+
- 全局环境中已有 `codex` / `claude-code-router` / `claude-code` / `kimi` / `agent` / `zcode` / `agy`（Antigravity CLI）其中之一，或当前系统用户已有对应登录态/API 凭据。
- 手动创建飞书/Lark 自建应用（不走扫码）请看：[手动飞书应用配置指南（Manual Custom App Setup）](docs/guide/platform-setup.md)。

### 安装

- CodeLark 默认使用 tmux 驱动本地 TUI agent（**Antigravity 直接走 `agy acp` 协议，无需 tmux**）
  - macOS
  ```sh
  # 安装Homebrew
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # 安装 tmux
  brew install tmux
  ```
  - Linux
  ```sh
  sudo apt install tmux
  ```
  - Windows
  ```sh
  winget install psmux
  ```
  psmux 是原生 Windows tmux 兼容实现，会提供 `tmux.exe`，不需要 WSL。安装后请重新打开终端，并用 `tmux -V` 验证 PATH。

> **重要提示：** 请**不要**使用 `npx codelark` 或 `npm install -g codelark`——npm 上的 `codelark` 是上游包，**不包含 Antigravity 支持**。请务必按下方步骤从本仓库（`https://github.com/spxix/feishu-code`）安装。
> 如果你通过环境变量配置模型、代理或 API Key，需要在启动前 export。

**方式一：克隆并构建（推荐，私有/公开仓库均适用）**

```bash
git clone git@github.com:spxix/feishu-code.git   # 或 https://github.com/spxix/feishu-code.git
cd feishu-code
npm install
npm run build

# 可选：链接到全局 PATH，之后可直接运行 `codelark`
npm link
```

安装完成后运行配置向导并启动（手动创建飞书应用请先看 [手动飞书配置指南](docs/guide/platform-setup.md)）：

```bash
node dist/cli.mjs setup   # 若已执行 npm link，也可直接运行 codelark setup
chmod 700 ~/.codelark
node dist/cli.mjs start   # 只启动后台 bridge（或 node dist/cli.mjs run 同时打开 Web UI）
```

**方式二：从 GitHub 一键打包全局安装（Node.js 24+，Bash / Zsh）**

```bash
npx --yes --package=npm@11.6.2 -c 'codelark_pkg=$(npm pack "git+https://github.com/spxix/feishu-code.git#main" --silent) && npm install -g "./$codelark_pkg"'
```

> **更新提醒：** 请勿点击飞书内可能弹出的上游 npm「立即更新并重启」提示（它会安装上游 `codelark` 并覆盖 Antigravity 支持）。如需关闭每日 npm 版本检查，可在启动前设置 `CODELARK_DISABLE_DAILY_VERSION_CHECK=1`；更新本仓库请直接执行 `git pull && npm install && npm run build`。

## v0.5.1

`0.5.1` 修正附件发送语义：仅 Markdown 附图自动上传，普通文件链接保留在正文；`/file` 发送图片时使用飞书原生图片消息。

## v0.5.0

`0.5.0` 新增客服话题模式（`/customer on`、`/whitelist`），支持普通群中的话题追问；图片、引用文件和合并转发成为通用附件输入。Cursor Desktop 补齐原生控制、可选增强安装与卸载、工具结果及历史同步选择，持续使用统一的 `tmux` 入口。本版本还兼容 Codex CLI 0.163.0，并修复流式续卡导致的进度积压。

完整发布说明见 [Release Notes](docs/guide/release-notes.md)。

## 常用命令
- `/`：查看或修改当前群的会话配置。
- `/set`：修改全局默认配置；新建群会继承这些默认值。
- `//...`：向模型发送以 `/` 开头的文本，例如 `//status` 会作为 `/status` 发给模型。
  - 特别常用：`//goal`！
- `/tmux-screen`：显示本地 agent 的 TUI 界面，遇到卡住不动的问题排查用。
- `<enter>`、`<C-c>`、`<esc>`：向当前 tmux 会话发送控制键。
- `/p tmux`：当前本地 TUI 已退出时重新启动。
- `/runtime cursor`：切换到 Cursor Agent；原生 Cursor slash 命令使用 `/tmux /<command>`，例如 `/tmux /mcp list`。
- `/runtime zcode`：切换到 ZCode；普通消息进入受 CodeLark 管理的 ZCode tmux TUI，原生 slash 命令使用 `//`，例如 `//goal`。
- `/runtime antigravity`（别名 `/runtime agy`）：切换到 Antigravity；通过本机 `agy acp` 协议运行（无需 tmux），支持 `/model`、`/mode`（`default|accept-edits|auto|plan|yolo`）、`/r`（`low|medium|high|xhigh`）、`/sb`（sandbox）以及 `//...` 透传原生 slash 命令。
- `/reasoning`：查看或修改当前 runtime 的思考设置；Codex 支持 `max/ultra`，Kimi 使用 `on/off`，Cursor 使用模型 effort，Antigravity 支持 `low|medium|high|xhigh`；ZCode 保留自身原生命令，不由 CodeLark 硬映射。
- `/stop`：停止当前任务
- `/t`：查看最近本地 Codex / Claude Code / Kimi Code / Cursor Agent / ZCode / Antigravity 会话。
- `/t rename <名称>`：重命名当前线程；群聊通道会同步修改群聊名称，真实群名会自动带 `[botname]` 前缀。
- `/new`：发送创建表单，填写名称和工作目录后创建新的 IM 群聊会话。
- `/clear [名称] [路径]`：在当前聊天上下文创建新的对话并绑定过去，之后仍可用 `/t` 找回旧对话。
- `/every 10m <prompt>`：按固定间隔复用当前会话发送 prompt；`/every` 查看和取消。
- `/then <prompt>`：当前会话 completed/interrupted 后发送一次后续 prompt；`/then` 卡片可查看、新建、修改和取消。


## 典型使用方式

### 1. 接管本地会话

在 Web 工作台里新增好飞书通道实例后，启动 bridge。
然后在 IM 中发送：

```text
/t
```

### 2. 继续对话

绑定成功后，直接发送普通消息即可继续当前线程。

- tmux 会解释 `<enter>`、`<C-c>`、`<esc>` 等控制键；卡权限或需要中断时很有用。
- Codex CLI/Desktop、Claude Code、Kimi Code、Cursor Agent 或 ZCode 继续操作这条共享会话时，结果也会通过对应本地 transcript/SQLite mirror 同步到 IM。

> 也就是说，你可以回到电脑继续在 TUI 中和 Agent 协作，再回到飞书时依旧能看到完整对话记录。

### 3. 新建群聊任务

```text
/new
```

会发送创建表单，让你填写群聊名称和工作目录。表单会默认带出当前会话的工作目录也可以用纯文本直接指定名称，或同时指定名称和目录：

```text
/new my-thread
/new my-thread ./my-project
/new my-thread D:\work\my-project
```

名称或路径包含空格时，请使用英文双引号 `"` 或英文单引号 `'`，例如 `/new "my thread" ./my-project`。

`/clear [名称] [路径]` 会在当前聊天上下文创建一个新的对话，并把当前聊天绑定过去；名称或路径包含空格时，请使用英文双引号 `"` 或英文单引号 `'`。之后可用 `/t` 重新附加到之前的对话。若当前 SDK 任务、共享镜像状态或 tmux TUI 追加输入仍显示运行中，会先询问是否终止旧对话；确认后再切换。群聊通道会同步重命名群聊，真实群名会自动带 `[botname]` 前缀。



## 社区

| 微信 | 飞书 |
| --- | --- |
| <img src="docs/assets/community/wechat-qr.png" alt="微信群二维码" width="180"> | <img src="docs/assets/community/feishu-qr.png" alt="飞书群二维码" width="180"> |

## 致谢

深受以下项目的启发，并感谢作者们的开源
- codex-to-im
- lark-coding-agent-bridge
