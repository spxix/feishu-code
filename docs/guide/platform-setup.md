# 手动飞书配置（Manual Custom App Setup）

本文提供**不使用扫码**、在飞书 / Lark 开放平台手动创建并配置自建应用（Custom App）的完整步骤，适用于 `codelark setup` 的「手动粘贴 App ID / Secret」路径。

> **机器人规划建议：按计算节点建 Bot，不要按 Runtime 建 Bot。**
> - **1 个机器人 = 1 台机器（Compute Node）**：同一台机器上的 1 个 CodeLark 机器人可以同时驱动所有 runtime（Antigravity、Codex、Claude Code、Kimi Code、Cursor Agent、ZCode），每个私聊或 `/new` 群聊可独立切换 `/runtime` 与工作目录。
> - **多台机器请各建 1 个机器人**：飞书长连接（WebSocket）会在使用同一 `App ID` 的在线进程间负载均衡；如果两台机器共用同一个机器人，消息会随机落到另一台机器。建议按节点命名，例如 `CodeLark-DevBox`、`CodeLark-GPU1`。

---

## 步骤 1：创建企业自建应用并获取凭据

1. 打开开发者后台：
   - 飞书（国内版）：`https://open.feishu.cn/app`
   - Lark（国际版）：`https://open.larksuite.com/app`
2. 点击 **创建企业自建应用（Create Custom App）**，填写应用名称（如 `CodeLark-DevBox`）和描述，点击 **创建**。
3. 在左侧进入 **凭证与基础信息（Credentials & Basic Info）**，记录：
   - **App ID**（形如 `cli_xxxxxxxxxx`）
   - **App Secret**

---

## 步骤 2：启用机器人能力

1. 在左侧进入 **添加应用能力（Add Features）**。
2. 启用 **机器人（Bot）** 能力。

---

## 步骤 3：配置应用权限（权限管理）

1. 在左侧进入 **权限管理（Permissions & Scopes）**。
2. 点击 **批量导入/导出权限（Batch Import / Export）**（或逐条搜索添加）。
3. **推荐（仅本人私用 / 最小核心权限集）**：粘贴以下 JSON 并点击 **保存 / 申请开通**。它覆盖私聊与群聊收发、CardKit 流式卡片、`/new` 建群与改名、Pin、表情回应和附件上传：

```json
{
  "scopes": {
    "tenant": [
      "cardkit:card:read",
      "cardkit:card:write",
      "im:chat:create",
      "im:chat:read",
      "im:chat:update",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message.pins:write_only",
      "im:message.reactions:read",
      "im:message.reactions:write_only",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:message:update",
      "im:resource"
    ],
    "user": []
  }
}
```

> **为什么不包含 `im:chat:create_by_user`？**
> 在部分飞书 / Lark 租户的批量导入中，`im:chat:create_by_user` 会标红（该租户未将其作为 tenant scope 开放）。去掉它即可正常导入，`im:chat:create` 已足够机器人创建会话群聊。

> **重要提醒：** 缺少 `cardkit:card:write` 时，飞书流式响应卡片无法正常工作（会报错 `99991672` 并降级为普通消息）。

### 可选：云文档评论建群权限（如仅本人使用，建议跳过）

仅当你希望在飞书云文档评论中 `@bot` 自动建群时，才额外添加以下 3 个权限；**如果你只希望机器人响应你自己的私聊/群消息，请不要添加这些权限，也不要在步骤 6 订阅云文档评论事件**：

- `docs:document.comment:read`
- `docs:document.comment:create`
- `docs:document.comment:write_only`

---

## 步骤 4：收紧可见范围并发布 `1.0.0`

> 必须先发布 `1.0.0` 并通过审核，权限和机器人才会生效，后续步骤才能建立 WebSocket 长连接。

1. 在左侧进入 **版本管理与发布（Version Management & Release）**，点击 **创建版本**，填写版本号 `1.0.0` 与说明。
2. **可用范围（Availability）**：强烈建议设置为 **仅自己可用**（不要选全员可见），防止同租户其他成员搜到或私聊你的本地机器机器人。
3. 点击 **保存** 并 **提交发布 / 审核**（管理员审批通过后进入下一步）。

---

## 步骤 5：在本地配置并先启动 CodeLark Bridge

> **顺序关键：** 飞书后台在步骤 6 保存「使用长连接接收事件 / 回调」时，会实时校验当前是否已有客户端通过 WebSocket 在线连接。因此**必须先在本机启动 CodeLark bridge，再配置步骤 6**。

1. 在终端运行配置向导：

```bash
codelark setup
# 如果从源码仓库运行：
# node dist/cli.mjs setup
```

2. 按提示选择：
   - **配置方式**：选择 **手动粘贴 App ID / Secret**。
   - **App ID / App Secret / 站点**：粘贴步骤 1 的凭据，选择 `feishu`（`open.feishu.cn`）或 `lark`（`open.larksuite.com`）。
   - **允许用户（Allowed Users / `open_id` 白名单）**：填写你在这个新应用下的 `open_id`（`ou_...`）。
     - **重要提示（Per-App `open_id`）**：飞书的 `open_id` 是**按应用隔离**的——从 `lark-cli` 或其他飞书应用查到的 `ou_...` 与这个新建应用**不同**。
     - **安全获取新应用 `open_id` 的方法**：此时可先填一个占位符（如 `ou_placeholder`，保证机器人始终不对外开放）；完成步骤 6～7 后给机器人发一条 `/current`，再从 `~/.codelark/logs/bridge.log` 中找到 `Unauthorized message from userId: ou_xxxx`，把它填回 `~/.codelark/config.toml` 的 `allowed_users` 并执行 `codelark restart`。
   - **默认 Runtime**：选择你想默认使用的 agent（例如 **Antigravity** 使用 `acp`，不依赖 `tmux`）。
   - **默认工作目录**：填写新建会话的默认目录（例如你的项目父目录；后续随时可用 `/new <名称> <路径>` 或 `/cd <路径>` 覆盖）。
3. 收紧配置目录权限（在多人共用 Linux 主机上强烈推荐）并只启动后台 Bridge：

```bash
chmod 700 ~/.codelark
codelark start
codelark status
```

> **提示：** `codelark start` 只启动后台 bridge，不会暴露本地 Web UI 端口（`4781`）。若输出中提示全局 `~/.lark-cli` 缺少用户授权（例如 `im:message.send_as_user`），**可以忽略**——它不影响机器人私聊、群聊、流式卡片或 Antigravity/Codex 等 agent 运行，只在需要用户身份的 `lark-cli` 扩展功能时用到。

确认 `codelark status` 显示 `Bridge: running`，且 `~/.codelark/logs/bridge.log` 中出现 `[feishu-adapter] Started` 后，再进入步骤 6。

---

## 步骤 6：配置事件与回调（长连接模式）

保持步骤 5 的 bridge 运行，回到飞书开发者后台左侧进入 **事件与回调（Events & Callbacks）**：

1. **事件配置（Event Configuration）**：
   - 将 **订阅方式（Subscription Mode）** 切换为 **使用长连接接收事件（Long Connection）** 并点击 **保存**。
   - 点击 **添加事件（Add Events）**，添加：
     - `im.message.receive_v1`（必需：接收私聊和群消息）
     - `im.chat.member.bot.deleted_v1`（推荐：检测机器人被移出群聊）
     - `im.chat.disbanded_v1`（推荐：检测群聊解散）
     - *（可选：`drive.notice.comment_add_v1` 仅用于云文档评论建群；如果只希望机器人响应你自己的聊天，请不要添加。）*
2. **回调配置（Callback Configuration）**：
   - 将 **订阅方式（Subscription Mode）** 切换为 **使用长连接接收回调（Long Connection）** 并点击 **保存**。
   - 点击 **添加回调（Add Callbacks）**，添加：
     - `card.action.trigger`（必需：用于 `/current`、`/set`、`/t` 选择器与权限审批按钮）

---

## 步骤 7：发布 `1.1.0` 并验证

1. 再次进入 **版本管理与发布（Version Management & Release）**，创建版本 **`1.1.0`**，点击 **保存并发布**（事件和回调只有在发布审批通过后才会生效）。
2. 打开飞书，搜索你的机器人名称进入**私聊**，发送：

```text
/current
```

预期效果：机器人会给你的消息贴上 `Get` 表情，并回复一张可交互的当前会话配置卡片。
- 如果你在步骤 5 填了 `ou_placeholder`，此时查看 `~/.codelark/logs/bridge.log` 中的 `Unauthorized message from userId: ou_...`，替换 `~/.codelark/config.toml` 中的 `allowed_users` 后执行 `codelark restart`，再发一次 `/current` 即可。

---

## 从旧版本升级

如果你已经配置过旧版飞书应用，需要补齐权限与回调：

1. **添加新权限**：进入权限管理补齐缺失 scope：
   - `cardkit:card:write`、`cardkit:card:read`：流式卡片。
   - `im:message:update`：实时更新卡片内容。
   - `im:message.reactions:read`、`im:message.reactions:write_only`：投递确认与 Typing 指示。
   - `im:message.pins:write_only`：Pin/Unpin 线程表消息。
   - `im:chat:create`、`im:chat:read`、`im:chat:update`：创建、读取和重命名 bridge 群聊（部分租户还可选配 `im:chat:create_by_user`）。
   - *（可选，仅云文档评论场景）* `docs:document.comment:read`、`docs:document.comment:create`、`docs:document.comment:write_only`。
2. **发布新版本**并等待审批通过。
3. **启动或重启 bridge**，确保 WebSocket 长连接处于在线状态。
4. **添加回调**：进入事件与回调，在长连接模式下添加 `card.action.trigger`。
5. **再次发布**并审批通过，然后重启 bridge。

## 域名与访问控制参考

- **站点域名**：飞书国内版默认 `https://open.feishu.cn`；Lark 国际版使用 `https://open.larksuite.com`。
- **允许用户 ID（`allowed_users`）**：
  - 使用当前应用下的 `open_id`（`ou_...`）。
  - 留空（`[]`）表示**允许所有能给机器人发消息的人**使用该 bot；在公司/团队租户中强烈建议始终填写自己的 `open_id`，并将应用可用范围限制为仅自己可见。
