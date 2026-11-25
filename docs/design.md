# paseo-im 架构设计

状态：设计定稿（v1，2026-11-07）
参考：`_refs/dsh-im`（渠道协议事实来源，MIT）、`_refs/paseo-telegram`（插件组织形式模板，MIT）

## 1. 目标与非目标

**目标**：一个 Paseo 插件 `paseo-im`，全量接入 dsh-im 支持的 12 个 IM 渠道（飞书、微信、钉钉、企业微信智能机器人、企业微信自建应用、QQ、Slack、Telegram、Discord、WhatsApp、iMessage、Matrix），把 IM 消息桥接到 Paseo agent，并把 agent 回复以各渠道原生形态送回。插件组织完全对齐 paseo-telegram：`index.client.tsx` + `index.server.ts` + `client/ server/ shared/ tests/`，TS 源码发布，node:test 测试。

**非目标（首版，规划文档 P3 列为后续）**：
- Bots 插件 profile 集成（paseo-bots 外部插件，可选增强）。
- Git worktree 自动同步（paseo-telegram sync.ts 对应物）。
- Matrix E2EE（dsh-im 亦标注实验性，不可靠）。
- Email / AI Office Connector（非 IM 聊天渠道，不在"所有 IM"范畴）。
- 语音转写、dsh-im 的扫码**建应用**流程（钉钉/飞书/QQ/企微的厂商私有配对后端）；我们支持**凭据手填 + 官方设备授权端点**（企微 `work.weixin.qq.com/ai/qc/*`、飞书官方设备授权）。

## 2. 总体架构

```
index.server.ts (contribute)
 └─ Manager                      生命周期：加载 registry → 逐连接 activate → Bridge
     ├─ Registry                 connections.json（无机密，乐观锁 revision，≤50 连接）
     ├─ SecretStore              secrets/<id>.json 0600（token/secret 每渠道字段）
     ├─ ChannelBridge（每连接）   渠道无关调度：准入→路由→队列→dispatch→回复→进度
     │   ├─ Router               target/agent 绑定、会话键、destination
     │   ├─ AgentQueue           per-agent 串行 + per-conversation 串行
     │   ├─ Policy               入站准入（dm/group × owner/operators/admins/everyone）
     │   ├─ ProgressSink         进度抽象（edit/stream/typing/none 四实现）
     │   ├─ QuestionRelay        permission/question → IM 回复匹配 → respondToPermission
     │   └─ ChannelAdapter       渠道传输 + 规范化 + 原生发送（12 个实现）
     ├─ DaemonLink               自建 PaseoApi 连接（paseo-telegram daemon.ts 移植）
     └─ pairing/<attempt>.json   QR / owner 配对会话
```

数据流（入站）：`ChannelAdapter.onMessage → ChannelBridge.handle(NormalizedMessage) → Policy.authorize → QuestionRelay.tryMatch → Router.resolve(target) → AgentQueue.run(key) → dispatch（receipt 防重放）→ agent.send(text, steer)`。
数据流（出站）：`agent turn 结束 → DaemonLink 取最终文本 → format(<channel>) → ProgressSink.finish(首块)/send(余块) → ChannelAdapter.sendText/sendMedia`。

进度：普通请求立即创建 ProgressSink；`!m` 带正文先发切换回执再建占位。每 5s 节流刷新（从原任务起点计算的时长 + 简短活动行），整个时间线读取/阶段轮转/计时更新周期串行，慢请求跳过重叠 tick。Slack 会将已确认完整的阶段正文写入当前占位，再创建新的尾部计时消息；最终回复首块原位替换当前进度消息（edit/stream 类渠道），typing 类渠道发分段文本，none 类直接最终回复。Slack 阶段正文只读本次 dispatch 的投影快照，以后续工具起点/另一段正文确认边界；mutable 尾行不推进游标，发送意图及已确认 ID 持久化，异常状态不盲目重发。

## 3. 核心契约（shared/ + server/channels/types.ts）

### 3.1 规范化消息（借 dsh-im SemanticMessage）

```ts
// shared/model.ts
NormalizedMessage {
  channel: ChannelId; connectionId: uuid;
  kind: "dm" | "group";
  chatId: string; threadId?: string;          // 会话键 = `${kind}:${chatId}[:${threadId}]`
  senderId: string; senderName?: string;
  messageId: string; timestamp: number;       // ms
  text?: string;
  media?: { kind: "image"|"file"; path: string; mime?: string; name?: string }[]; // 已下载到本地临时区
  replyTo?: { id?: string; text?: string; sender?: string };
  trigger: { mention: boolean; replyToBot: boolean; command: boolean };
}
```

### 3.2 ChannelAdapter（server 侧接口，12 个实现）

```ts
ChannelCapabilities {
  progress: "edit" | "stream" | "typing" | "none";
  markdown: "native" | "html" | "custom" | "plain";
  uploadImage / uploadFile: boolean;
  reactions: boolean; typing: boolean;
  maxChunkChars: number;                      // dsh-im 实测值见 §5 矩阵
  threads: boolean;
}
ChannelAdapter {
  readonly channel: ChannelId;
  capabilities: ChannelCapabilities;
  start(signal): Promise<void>;               // 建连 + 开始接收；onNormalized 回调投递
  stop(): Promise<void>;
  sendText(chatId, threadId|undefined, text, opts?: { replyToId? }): Promise<{ messageId?: string }>;
  sendMedia?(...): Promise<{ messageId?: string }>;
  editMessage?(messageId, text): Promise<void>;        // progress==="edit"
  streamStart/streamAppend/streamFinish?(...): Promise<{messageId}>;
  sendTyping?(chatId): Promise<void>;
  addReaction?(messageId, emoji): Promise<void>;
  testConnection(): Promise<{ ok: boolean; detail?: string }>;
}
```

`createAdapter(deps)` 工厂每渠道一个模块；`deps` 提供 `{ config, secrets, dataDir, signal, emit(msg), log }`。传输层 mock 点在 adapter 构造函数（测试注入 `Recorder`，同 paseo-telegram tests/bridge.test.ts 模式）。

### 3.3 连接配置（shared/config.ts）

```ts
connectionCommon = { id: uuid, channel: ChannelId, name, enabled,
                     target: Target|null, bindings: Record<convKey, Target>,
                     policy: Policy, revision: int }
Target = { kind:"agent", agentId, sharedHistory } | { kind:"workspace", workspaceId,
          profile: { provider:"prov/model", modeId?, thinkingOptionId?, systemPrompt } }
Policy = { groupAdmission: operators|approval|everyone (默认 approval),
           directMessages: operators|everyone (默认 everyone),
           groupUsers: operators|admins|everyone, operators: string[](≤100),
           invocation: mentions|all }
```
v1 无 owner 配对子系统（paseo-telegram 因 token 共享场景引入；此处以 operators 名单 + 群审批覆盖同等安全面）。

渠道字段（与 dsh-im 对齐）：telegram `{botToken→secret, username, botId}`；slack `{botToken, appToken→secret, teamId}`；discord `{token→secret, botUserId}`；feishu `{appId, appSecret→secret, domain: feishu|lark}`；dingtalk `{clientId, clientSecret→secret}`；qq `{appId, appSecret→secret, botId→secret?}`；wecom `{botId, secret→secret}`；wecom-app `{corpId, agentId, secret→secret, token→secret, encodingAESKey→secret, apiBaseUrl?, callbackBaseUrl?, callbackSecret}`；whatsapp `{accountJid, authDir}`（凭据=Baileys auth 文件）；weixin `{token→secret, accountId, ownerUserId, baseUrl?}`；imessage `{}`（无凭据）；matrix `{homeserver, userId, accessToken|password→secret}`。

### 3.4 RPC 面（shared/contracts.ts）

| RPC | 输入 | 输出 |
| --- | --- | --- |
| `im.list` | `{}` | `{ channels: { channel, connections: ConnectionView[] }[], settings }` |
| `im.choices` | `{}` | `{ agents[], workspaces[], providers[{id,label,models[{id,label,thinking[],modes[]}]}] }` |
| `im.connect` | `{ channel, name, credentials… }` | `{ id, detail }`（连不上即报 `UserFacingError`） |
| `im.save` | `{ id, revision, name/enabled/target/bindings/policy }` | `{ connection }`（revision 冲突→false 路径错误） |
| `im.disconnect` | `{ id }` | `{ removed }` |
| `im.revoke` | `{ id, chatId }` | `{ revoked }` |
| `im.review` | `{ id, chatId, approve }` | `{ approved }` |
| `im.pairing.start` | `{ channel, id? }` | `{ attemptId }`（owner 配对 / whatsapp / weixin / wecom 扫码） |
| `im.pairing.poll` | `{ attemptId }` | `{ status: pending|scanned|ok|expired|failed, qrDataUrl?, detail? }` |
| `im.test` | `{ id }` | `{ ok, detail }` |
| `im.settings.save` | `{ settings, revision }` | `{}` |

### 3.5 持久化布局（`$PASEO_HOME/plugin-data/paseo-im/`）

```
connections.json            # Registry 文档 {version:1, connections:[…]}，无任何机密
settings.json               # defineSettings 宿主托管（图片限制/排队模式/附件 TTL）
secrets/<id>.json           # 0600，机密字段集中
connections/<id>/state.json # 游标、jobs（含 receipt/after 边界）、conversations、groups、pendingGroups
pairing/<attemptId>.json    # 配对会话（nonce hash、过期、QR 状态）
media-inbox/                # 入站媒体临时区（TTL 清理）
```

写入全部走 `atomicWrite`（目录 0700、tmp 文件 0600 `wx`、rename）+ promise 链串行（paseo-telegram files.ts/store.ts 同款）。

## 4. 关键机制（全部移植 paseo-telegram 已验证模式）

1. **Dispatch receipt 防重放**：`messageIdentity(connectionId, messageId)` 派生稳定 id；dispatch 前落盘 `dispatch:"sending"` + timeline `after={epoch,seq}`；崩溃恢复时 `findDispatch` 在 timeline 回查该 id，命中即跳过重发。
2. **乐观锁**：所有配置写带 `revision`，不匹配拒绝（多客户端安全）。
3. **429/限流**：Outbox per-chat 队列；`retry_after` → 全 chat 暂停；成功后 1100ms 聊天间隔。每渠道退避表：`[1,3,5,10,30]s`（Slack/Discord/Matrix 同 dsh-im）。
4. **串行化**：`conversation:<connectionId>:<convKey>` 队列投递 + `agent:<agentId>` 队列执行；question 回复绕过队列（控制输入，防死锁）。
5. **Question relay**：`agent.permission.before`（kind=question）→ 落盘 job.question → 回复原 IM 消息；用户回复按 destination+messageId 匹配 job → `respondToPermission`；`agent.permission.after` 清 job.question（`addHook` 新名，替代 paseo-telegram 旧 `server.on`）。
6. **最终答案获取**：`agent.waitForFinish` → timeline tail 取最新 assistant 文本（paseo-telegram answerUnlocked 同款）；失败/取消 → FALLBACK 文案；`missing_final_answer` 物化为 job.failure。
7. **超时补发（Deferred delivery）**：job 登记 `deadlineAt`；超时后继续轮询，完成后向原会话补发；明确失败 ≤3 次，结果不确定不重试（防重复消息）。首版仅文字结果。
8. **群准入**：`my_chat_member`/群成员事件 → pendingGroups → `im.review` 审批；owner pairing 前群不可用。
9. **归档会话**：目标 agent 归档 → 提示并阻塞，不再补发（同 dsh-im 归档提示）。

## 5. 渠道适配矩阵（12 渠道）

| 渠道 | 传输 | SDK/依赖 | 凭据 | 进度 | 富文本 | 分段上限 | 媒体回传 | 风险 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| telegram | 长轮询 REST | 自实现（fetch） | botToken | edit + typing | entities(marked) | 4096 | sendPhoto/sendDocument | 409 冲突检测 |
| slack | Socket Mode wss | 自实现（ws） | botToken+appToken | chat.startStream | mrkdwn | 38000（chunk 11000） | 上传三步 API | scope 缺失 |
| discord | Gateway v10 wss | 自实现（ws） | botToken | edit + typing | 原生 markdown | 2000 | attachments | intent 需后台开启 |
| feishu | WS 长连接 | @larksuiteoapi/node-sdk | appId+appSecret | cardkit 流式卡 / post 分步 | post/卡片 | 卡 18000B、post 24000B | im.v1 资源 | 需租户权限审批 |
| dingtalk | Stream 长连接 | dingtalk-stream | clientId+clientSecret | AI Card | markdown | 4000 | 媒体上传 API | 卡片模板权限 |
| qq | WebSocket | @tencent-connect/qqbot-nodejs | appId+appSecret | typing + 分片 | markdown→回退 text | 被动窗口 c2c 60min/群 5min | 仅 URL/受限 | 平台配额 |
| wecom | WebSocket | @wecom/aibot-node-sdk | botId+secret（官方扫码或手填） | replyStream 官方流式 | markdown | 18000B | uploadMedia | — |
| wecom-app | HTTP 回调（需公网基址） | node:http + SDK WecomCrypto | corpId/agentId/secret/token/AESKey | 加密应答内嵌流占位 | 文本 | 2048B | media/upload | 必须公网可达 |
| whatsapp | Baileys WS | @whiskeysockets/baileys | 扫码配对（多文件 auth） | edit + composing + 已读 | whatsapp 格式 | 4000 | 原生媒体 | 非官方协议封号风险 |
| weixin | iLink 长轮询 | 自实现（port dsh-im，MIT 注明） | 扫码 token | typing（sendtyping） | 纯文本 | 1800 | AES 加密上传 | 未公开接口，稳定性风险 |
| imessage | chat.db 轮询 + osascript | 自实现 | 无（macOS 权限） | none | 纯文本 | — | 不支持 | 仅 darwin；Linux 显示 unsupported |
| matrix | CS API 长轮询 sync | 自实现（fetch） | accessToken 或 userId+password | m.replace edit + typing | HTML 白名单 | 16000 | uploadMedia | E2EE 首版不支持 |

依赖策略：全部为 devDependencies（TS 源码发布 + manifest `build: npm ci --omit=dev --ignore-scripts`）。传输统一用原生 `fetch`/`WebSocket`（Node 24）/`ws` 包（daemon 与 Slack/Discord/WS 渠道共用）。

## 6. Client 设计

单 screen `im` + sidebar header item + Command Center item（同 paseo-telegram 三件套，id=`im`）。内容为渠道注册表驱动的通用 UI（`client/channels.ts`：每渠道 `{ id, title, icon, credentialFields[{key,label,secure,placeholder,help}], connectHint }`）：

- 渠道分段列表（icon+连接数+状态色）→ 点开渠道的连接列表（desktop 260px 左栏 / compact `SettingsSelect`，paseo-telegram 同款）。
- 连接表单：credentialFields 动态渲染（`SettingsInput secureTextEntry`）→ `im.connect`。
- 连接详情：状态条（Ready/Needs attention/Confirm owner/Choose destination/Connecting/Paused）、`RouteEditor`（default + per-convKey bindings，三层 Select）、Policy 编辑、pendingGroups 审批、Linked conversations、Save（带 revision）/Disconnect/Test。
- QR 渠道：`im.pairing.start/poll` 轮询渲染 `qrDataUrl`（RN `Image`）+ 状态行。
- 全局设置段：图片输入限制、忙时 queue/steer、附件 TTL。
- 数据获取：`client.rpc()` + 5s 轮询（paseo-telegram 同款，无订阅推送可用）。RN 原语、`theme.colors`、`layout.compact`，无 DOM。

## 7. 与参考实现的差异决策

| 决策 | 理由 |
| --- | --- |
| 不复用 dsh-im cordis 宿主层（plugin-src/host/*） | 绑定 DeepSeek Harness ctx（credentials/typertGateway/harness*）；paseo 对应物是 plugin RPC + SecretStore + DaemonLink |
| 采纳 dsh-im `src/channels/*` 协议事实（端点、字段、限制），代码按 TypeScript 重写；weixin iLink API 客户端逐段移植并在文件头注明出处 | 协议正确性优先；MIT 允许；cordis 无关 |
| 机密存本插件 `secrets/` 文件而非宿主服务 | Paseo 无 plugin credential 服务；paseo-telegram 已验证 0600 文件方案 |
| `addHook` 新名（0.14+） | 我们 requirements `>=0.15.2`，旧名 deprecated |
| operators 用 string | 12 渠道 sender id 形态不一（openid/openid/userid/jid/mxid…） |
| Target 去掉 bots profile | 首版不集成外部插件；保留 agent/workspace 两类 |
| progress 四实现统一抽象 | dsh-im 每渠道手写；抽象后 12 渠道共享同一 deliver 流程 |

## 8. 风险登记

1. **未公开协议**（weixin iLink、whatsapp Baileys）：可能失效/封号。对策：独立 adapter、清晰 lastError、文档警示。
2. **渠道 SDK 体积/兼容**（lark/dingtalk/wecom/qq）：安装失败或 ESM 冲突。对策：M2 首个渠道先装依赖验证；失败则降级自实现（qq/wecom 均为可自实现的 REST/WS 协议）。
3. **wecom-app 需公网回调**：本机不可达时渠道不可用。对策：UI 明示 callbackBaseUrl 要求 + 校验失败呈lastError。
4. **imessage 平台**：Linux daemon 上恒 unsupported。对策：连接卡片直接显示平台要求，不允许启用。
5. **12 渠道 × 回归面**：对策：每渠道单测（normalize/format/policy）+ 共享框架单测 + 静态守卫脚本（Runtime 边界/导入边界）。
