# 调试与修复知识库（gotchas）

来源：paseo-im 验收期（2026-11-06/07）真实故障与修复。每条含 现象/根因/修复/验证，可复用于后续渠道联调与本插件维护。
关联：`docs/design.md`（架构）、`docs/plan.md`（验收标准）、`docs/webui-acceptance.md`（验收记录）、QQ 实机闭环修复提交链（按序：验收修复 → 归档轮换幂等键 → updateJob 落盘 → 随机键重建 → 模型 ID 切分 → 入站不预填，详见 docs/status.md 修复索引）。

---

## 1. Paseo daemon 插件包运行时约束 ⭐ 最高频

**现象**：装依赖即崩 `ReferenceError: __dirname is not defined`；或 `createRequire(import.meta.url)` 报 "The argument 'filename' must be a file URL object… Received undefined"。

**根因**：daemon（0.15.2）用 esbuild 把插件 server 入口打成 **CJS**，再经 `wrapCommonJsBundle` 包成 `(function(require){…})` 在普通函数作用域内 eval——`__dirname` / `__filename` / `import.meta` 全部不可用。任何被静态 import 的依赖只要源码引用裸 `__dirname` 就会加载即炸（实测：`@larksuiteoapi/node-sdk` 顶层读自身 package.json；`@whiskeysockets/baileys` 拖进 pino/thread-stream/protobufjs）。

**修复**：重 SDK 走运行时装载（`server/channels/runtime-loader.ts`），specifier 收进运行时字符串（esbuild 保持不透明）：

```ts
const require_ = createRequire(join(dirname(process.argv[1]), "package.json")); // 子进程入口必在插件目录内
export async function loadPackage<T>(name: string): Promise<T> {
  const entry = require_.resolve(name);
  return import(pathToFileURL(entry).href) as T;  // CJS/ESM 通吃
}
```

类型侧用 `import type` + `typeof import("pkg")` 别名（擦除，不影响打包）。ws/marked/entities 等干净包可静态 import。

**其余同族约束**：
- daemon 日志**按行**捕获插件 console 输出——多行 stack 被拆成独立日志条目，取帧要按时间窗抓连续 sequence；跨 RPC 重建的 Error 无 stack（`stack ?? message` 记日志可兜底）。
- `features.webUi.enabled` 属 `restartRequiredPaths`：改了必须 `paseo daemon restart`（会杀掉以该 daemon 为宿主的 agent 会话）。
- 双实例验收：`PASEO_HOME=~/.paseo-webui`（独立 home + 端口 + WebUI 开 + `pluginsEnabled`）起第二 daemon，Playwright headless 对真实 WebUI 断言，不动生产。

## 2. Node 24 strip-only 直跑 TS + zod v4

- **禁 TS 参数属性** `constructor(private readonly x)`（strip-only 不支持）→ 显式字段 + 构造器赋值。
- tsconfig `lib` 需含 **ES2024**（`Promise.withResolvers`）；注意脚本改 tsconfig 会写出重复顶层键（第一个生效）。
- zod v4：`z.string().hex()` 不存在 → regex；顶层 `z.literal(1)` 解析空文档需 `.default(1)`；绕过 `parse` 的内存写会在后续 parse 时炸。
- `.mjs` 文件（非 TS）不能写 `!` 非空断言。

## 3. provider/model 斜杠约定与长列表选择器

**现象**：选完模型显示"未选择"；模型下拉无法滚动，后方选项点不到。

**根因/修复**：
- `config.provider` 约定 `"provider/model…"`，**model 本身可含斜杠**（`omp/tuya-gateway/glm-5.3-flash`、`omp/google-antigravity/claude-opus-4-6`；daemon 解析：首段=provider，其余=model）。拆分只能按**第一个斜杠**（`indexOf('/')` + slice）——`split("/")` 解构两段会截断 model。
- 宿主 SettingsSelect（自适应菜单）选项超出可视高度时**不可滚动**、后方项点不到（菜单背景拦截）。≥5 项的长列表用屏内自绘 `OptionPicker`（`client/route-editor.tsx`：Pressable 行 + maxHeight 260 ScrollView，`nestedScrollEnabled`，web 滚轮/触屏均可滚）；短菜单（<5 项）保留 SettingsSelect。
- choices 必须过滤不可用 provider（`status:"unavailable"`/`models:[]`）——否则用户随机选到不可用项。providers.snapshot：omp=ready+167 模型；models[].id 已含子前缀，choices 直接用。
- providers.snapshot 字段形状：models 元素 `{provider,id,label,thinkingOptions}`、modes `{id,label}`——用运行时探针（node 直连 SDK 打印）核对，勿靠文档猜。

**Playwright 驱动宿主菜单的坑**：菜单选项无 role（`role=menuitem` 计 0）；选项文本与页面文本同名（"默认去向"既是菜单项又是行值），必须 `page.locator('#overlay-root').getByText(...)` 限定作用域；首启向导遮罩（`aria-label="关闭"` ×2 层叠）拦截一切点击——点「跳过设置」文本按钮关闭（waitFor visible → click → waitFor hidden），点 X 层叠不可靠。

## 4. agent 绑定生命周期：幂等键、归档轮换、状态落盘

**现象（QQ 实机）**：绑定 workspace 后每条消息必败"关联的 Paseo 聊天当前不可用。"

**根因链**（三个独立缺陷叠加）：
1. `workspace.agents.create({idempotencyKey})` 的幂等映射**长于 agent 生命**：agent 归档后同 key 创建返回的仍是归档实例（labels 不参与去重；实测同 labels + 新 key → 全新 agent）。
2. 入站 `handle()` 从 conversation 绑定**预填 job.agentId** → `answer()` 里 `if (!job.agentId)` 为假 → **跳过 prepare** → 归档轮换逻辑永远不执行。
3. 归档 agent 的 `refresh()` 返回**空值快照**（archivedAt/status 均 undefined）——判活不能 `!archivedAt` 反推。

**修复**：
- prepare 的 known 分支刷新判死（空快照即死）→ 删 conversation 绑定 → **轮换幂等键**（`…-r<archivedAt.getTime()>`，undefined 时 `-r1`——键稳定，跨重试仍确定）。
- create 返回后**验活**（同判据），死则随机键 `-g<Date.now36>` 重建一次，再失败才报错（`routing.ts` isAlive/retry）。
- `handle()` 不预填 agentId（置 null），prepare 成为唯一解析点。
- `updateJob` 细粒度变更**内存改后立即异步落盘**（`void chain.run(() => atomicWrite(path, state))`）——只改内存会让 dispatch/failure 标记永不写盘，崩溃恢复 receipt 链路失效。

## 5. QQ 渠道专项（实机已验证）

- 传输：QQ 官方 bot WebSocket（`@tencent-connect` 协议自实现），断线 RESUME 会话恢复、4004 鉴权失败停连。
- 回复：c2c 被动回复窗口 60min / 群 5min，msg_id 每条上限 4/5 片，markdown msg_type=2 被拒（40034090）回退纯文本。
- 入站：C2C_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE（群 @ 天然 addressed）；msgId seen 环去重落盘重启有效。
- 端到端验收通过记录：`docs/webui-acceptance.md` QQ 节。

## 5.5 出站网络：双栈域名 IPv6 黑洞（WSL2 实机踩坑）

**症状**：连接报「无法连接 XX API（网络错误）」自动重试，但 `curl` 同机直连正常。

**根因链**（api.telegram.org 实测）：
1. 双栈域名（A + AAAA 都有）；本机 WSL2 的 IPv6 路由黑洞——`curl -6` 超时、`curl -4` 秒通。
2. node（v24 实测）按主机名拨号时命中 AAAA：happy-eyeballs 竞速里 v6 SYN 被黑洞吞掉后 ~400ms 内以 ETIMEDOUT **整体失败，不回退 v4**；`fetch(域名)` 必挂。
3. 关键鉴别：`net.connect` 裸 IP v4 秒通、`fetch(https://IP)` TLS 完整走完（报证书名不符是预期）——网络通，只有「域名→选址」坏。

**修复**（`index.server.ts` 引导期，进程级）：

```ts
dns.setDefaultResultOrder("ipv4first");
net.setDefaultAutoSelectFamily(false);
```

只影响解析顺序偏好，仅有 AAAA 的域名仍走 IPv6，无副作用。覆盖所有渠道出站（telegram/slack/matrix 等同理会撞）。

**排查顺序**：`curl -4`/`curl -6` 分家族测 → `node -e net.connect(裸IP)` 与 `fetch(域名)` 对比 → 定位在选址层再改 node 默认，不要先怀疑凭据/库。

## 5.6 插件 UI：labelAccessory 仅 web host 渲染（手机端不可见）⭐ 端差异

**症状**：web 预览正常的「label 旁按钮」，手机 App 同位置什么都不渲染。

**根因**：宿主 `SettingsInput` 把自有 FormTextInput 作为 row children 注入（插件传入的 `children` 被覆盖），唯一可用插槽是 `labelAccessory`——它存在于 web bundle 的行包装器实现里，但**手机端 host 不渲染**，且 SDK 类型从未声明该 prop（依赖它是赌宿主版本）。

**修复**：只用 SDK 公开契约组件拼装（`SettingsInput` + 输入框下方 `Pressable`+`Icon`）。凭证揭示按钮因此从 label 旁移到输入框下方。。**通用规则**：插件 UI 只依赖 `@getpaseo/plugin/client/ui` 的 .d.ts 声明面；未声明即不可依赖，哪怕 web 端实测可见。

## 5.7 微信扫码配对三坑合一（实机全修）

1. **qrUrl 是落地页不是图片**：iLink `get_bot_qrcode` 返回的 `qrcode_img_content` 实为 `liteapp.weixin.qq.com/q/...` 链接（HTTP 200 + `text/html`，1362 字节落地页）。旧 `defaultMakeQr` fetch 该 URL 把整页 HTML base64 成 `data:text/html` 塞给 `<Image>` → 手机端渲染空白、配对永远无码。修复：本地 `qrcode.toDataURL(qrUrl)` 生成标准 PNG（同 WhatsApp 适配器模式，零网络依赖）。
2. **pollLogin 是 30s 长轮询**：在 `poll()` 里同步 `await` 它，首个二维码要 30s 后才交付，且客户端 1s 轮询会在服务端堆几十个并发长轮询。修复：`poll()` 快照化（立即返回当前状态+缓存二维码），pollLogin 转**后台单飞**（同会话永不多飞）；`need_verifycode` 时暂停后台（空转会触发 verify_code_blocked 锁死），`submitVerification` 后恢复。
3. **配对渠道创建表单鸡生蛋死锁**：微信 token 只能由配对产生，但接入表单走 `connectRpc` → `configure({})` 空字段抛「缺少微信登录凭据」→ 创建必败。修复：配对渠道表单直连 `pairingStartRpc`（服务端无 connectionId 时自动建连接，配对成功自动激活回传 connectionId）；表单内嵌二维码直出。

**验证基线**：`scripts/verify-pairing.mjs`（RPC 环回，无人工）：断言自动建连、PNG 魔数级可渲染二维码（曾回归出 HTML 冒充图片）、15s 内交付、重复执行不堆僵尸行（`pairingStart` 复用最近孤儿连接）。

**测试竞态附坑**：会话 `stop()` 必须 `await backgroundLogin` 等后台单飞静止再返回——否则测试清理 `rm` 与幽灵 `persist()` 竞态（`ENOTEMPTY`，间歇 1/N 概率，8 连跑验证修复）。

## 5.8 会话绑定压过 target + save 双实例 StateStore 竞态（实机全修）

**症状 1**：App 里把连接「消息去向」改到新 agent，实际对话仍进旧 agent。
**根因**：`routing.prepare` 的 `conversations[key].agentId`（会话绑定）只要旧 agent 活着就**永远优先于 target**——改连接去向对已绑定会话不生效。

**修复（save 时对齐 reconcile）**：显式保存 target 时把全会话绑定对齐 routing 期望值 `bindings[key]?.kind==='agent' ? bindings[key].agentId : (target.kind==='agent' ? target.agentId : null)`：跟随旧 agent 的绑定随 target 迁移（agent→agent）或解除（agent→workspace）；历史漂移绑定一次性矫正。迁移规则纯函数在 `routing.ts`（`migrateConversationTargets/migrateBindingTargets`，有单测）。

**症状 2（矫正后回滚复发）**：矫正写盘成功，下一条消息又派回旧 agent。
**根因**：矫正用**独立 StateStore 实例**只写盘；运行中 bridge 持有**另一个内存实例**（旧值），其下一次 mutate 把整个 state 文件覆盖回去。
**修复**：矫正必须优先改写 `active.get(id)?.state`（bridge 正在用的实例），连接未运行才 fallback 独立实例（c57355c）。**通用规则**：凡「读改写共享持久状态」，必须先找运行中组件持有的同一实例；独立实例只适用于确认无人持有的场景。

**存量矫正**：修复只覆盖未来 save；历史漂移绑定需显式触发一次 `im.save`（target 传现值即可）——`scripts/verify-pairing.mjs` 的 RPC 环回模式可直接复用。

## 5.9 微信三连显示判定（出站链路干净证明法）

「一条回复微信显示三条」的取证顺序（勿直接怀疑平台）：
1. agent 会话观测（ai-memory `read_session_observations`）：每条入站应恰好一次 user-prompt + 一次 stop；
2. `connections/<id>/state.json`：单 job 单 `answer`、`delivery=done`；
3. `sendTextChunk` mock HTTP 计数：`sendmessage` 恰 1 次（scripts/selftest-weixin-send.ts）；
4. 生产加观测日志 `sendmessage ok client=<id> bytes=<n>`，真实消息后数行数。
四层各 1 次 → 重复在 iLink 平台显示层，拿第 4 步日志可直接反馈平台。`target-agent` 实测终判：出站 1 次 = 微信显示 1 遍（历史三连为旧缺陷时期遗留显示）。

## 6. 调试工作法（本次沉淀的流程）

1. **失败详情优先**：deliver catch 同时打 `error.stack ?? message`（原始）与 `userMessage(error)`（用户文案）两行——原始行给定位，文案行给回显核对。
2. **时间过滤读日志**：daemon.log 条目带 timestamp（UTC），对比最后一次 "Plugin ready" 时间判断消息是否跑在新代码上；`grep | python json` 按时间窗过滤，避免旧行误导。
3. **状态直读**：`$PASEO_HOME/plugin-data/paseo-im/connections/<id>/state.json` 即真相（updateJob 持久化修复后文件≈内存）。
4. **RPC 环回**：CLI/脚本直连 daemon `invokePluginRpc('paseo-im', …)` 验证管理面（见 `docs/webui-acceptance.md` E 节脚本）。
5. **复现优先于猜测**：SDK 调用（create/refresh/send）逐个直连复现拿真实报错，再改代码；跨进程/打包边界的错误会丢 stack，纯靠推理容易走偏。

## 7. 插件重载丢失在途回复（孤儿 job）——实机复现并修复

**现象**：wechat test 3（23:25:14Z 派发）后恰逢 23:26:12Z 插件重载，agent 回复产出（23:33Z）但微信侧**静默丢失**，无任何 投递失败 日志。

**根因**：`deliver` 的在途等待是纯内存态，只有超时（DeferredTimeoutError）后才 `deadlineAt`+`deferred.track`；重载 abort（`signal.aborted`）时 catch **提前 return 不标 failure**，且内存队列（会话级 + agent 级 `agent:${id}` 串行链）整体蒸发——job 冻结在 `delivery:null && failure:null`，dispatch 三形态皆可能：`null`（队列中未起跑，实证 TG `/status` 15:39Z 排在 peer agent 长任务后、`test 3` 23:24Z）、`sending`（打断在标记间隙）、`sent`（已派发未答复，实证 weixin `test 3`）。`sweepDeferred` 只遍历 deferred registry，启动路径无任何孤儿扫描。

**修复**（初版落地，后经 TG test 3 实证扩为统一重放）：`StateStore.resumableJobs()` 选出全部冻结态（`!delivery && !failure && !question`，dispatch 三形态通吃；**每会话只取最新一条**，平局按插入序；`question` 非空 = 等用户回复，排除）；`manager.activate` 在 `adapter.start()` **之前**逐条 `bridge.rerunQueued` 重放完整 deliver 管道——`findDispatch` 按 message_id 幂等去重（`sending` 不会重复派发），`dispatch:null` 且非问题回复的 job 重置 agentId 交 prepare 按当前绑定重解析（归档轮换本就是 prepare 的职责）。

**验证**：重载后日志 `恢复 1 条中断的在途回复。`（weixin/qq 各一）→ 补发走完 `sendmessage ok`（bytes=274，恰好 1 次 HTTP）→ 用户截图确认微信侧恰好显示 1 遍。1 发 = 1 显，出站链路干净；历史「三连显示」若再现即为 iLink 平台显示层。

**附带坑**：并行全量 `npm test` 下 whatsapp 配对测试（二维码→scanned→ok）会时序 flake（10ms 级断言），单独跑必过（HEAD 与改动侧均验证）——判「我的改动弄坏的」之前先单跑该文件。

## 8. Pi 后台续跑的最终答复未回到 IM

**现象**：IM 中收到「任务在后台运行」的首次答复，但 Pi 的后台完成通知唤醒新一轮后生成的最终答复只出现在 Paseo 时间线。

**根因**：桥接等待一次 `waitForFinish`，首次 idle 就标记 job 已投递；随后单独启动的自动续跑没有关联该 job。

**修复**：首次投递时持久化原消息之前的时间线游标。后台轮询仅认原 IM 消息身份之后的 Pi `bg_run` / `bg_delegate` 启动回执，且要求通知和自动唤醒均启用；只有任务 ID 匹配的合成完成通知后的答复才回发原会话。使用服务端 `endCursor` 分页（合并后的 tool call 的 `seqEnd` 可能覆盖其他条目）；时间线重置、缺口、会话改绑、后续用户输入或跟踪超期时停止，避免跨会话泄露。插件重载时恢复持久化跟踪。

**投递语义**：发送前持久化 in-flight 标记。若发送中断或重启时结果不确定，标记 uncertain 并停止自动重发，需人工核对渠道；多渠道无统一幂等键，不能保证此窗口既不丢又不重。旧 job 不会在升级时自动补发。跟踪期限为 7 天；存在新用户输入时旧后台结果故意不自动转发。关联 agent 被关闭时停止跟踪；本逻辑不阻止 Paseo 的闲置运行时回收，也不能替代 Pi 后台任务自身的存活与唤醒机制。

**验证**：`tests/followup.test.ts` 覆盖通知身份、禁用唤醒、用户输入边界及跨轮继承任务的派发前核销；`tests/followup-bridge.test.ts` 覆盖后台等待、原线程回发、持久化、分页、不确定发送、同 thread 多轮插话 `pendingTasks` 交接、5s 轮询前极速插话游标追平及裸 `!m` 查询不打断。生产会话时间线只读回放应能识别已知后台通知和最终结果；不依赖平台凭据。

**补充（同 thread 中途插话打断长周期后台唤醒）**：
- **现象**：同一 Slack thread 内已启动 1 小时定时唤醒 `bg_run`，中途用户在同一 thread 发送支线排障消息及后续跟进消息（最后一轮未重新调用 `bg_run`）；1 小时任务到期唤醒后生成的最终汇总只留在 Paseo timeline，未推往 Slack。
- **根因**：旧逻辑只要同 `conversationKey` 出现后继 Job 就把前序 `followup` 置 `null`，而新 Job 的 `followup` 只从自身 `after` 游标开始且初始 `pendingTasks: []`；若新 Job 本轮无新 `bg_run`，首次 5s 轮询即判定 `finished = true` 关闭 watcher，前序仍在运行的定时任务随之失联。
- **修复**：保持每会话最多单活跃 watcher 的不变量；同会话同 `agentId` 的新消息完成首轮投递（`completeDelivery`）时，先将前序 `followup` 追平至新消息的 `after` 游标（防止 5s 轮询窗口期漏扫刚启动的 `bg_run`），再将其未消费的 `pendingTasks` 交接给新 Job 的 `followup` 并原子清空旧 `followup`。不向 Agent 派发消息的纯 `!m` 命令及派发前校验失败的请求不打断现有 `followup`。

## 9. Slack 已重连但管理页持续显示退避

**现象**：Slack 周期性断开后可恢复收发，管理面 ready/running 却一直为 false，旧 lastError 不消失。

**根因**：Manager 的 start().then 只执行一次；Slack 内部重连 hello 没有再次通报就绪。

**修复**：AdapterContext 增加可选 onReady，Slack 每次成功 hello 都调用。Manager 清除错误并恢复就绪，核对当前 adapter 身份和停止信号；保留无此回调渠道的首次 start 兼容逻辑。已上报 hello 的适配器以回调为准，防止 start 完成覆盖紧随 hello 的断线。

**验证**：Slack fake socket 覆盖重连前/后 hello、旧 generation 和 stop；manager 回归覆盖多轮恢复、替换及停止后的陈旧回调、start 完成竞态。不要用 auth.test 成功代替 Socket Mode 握手成功。

## 10. IM 历史关联列表不应当作当前 agent 目录

**现象**：清理脚本已归档 agent，IM「已关联会话」仍堆积历史线程。

**根因**：会话关联历史独立于 agent 归档，直接列举 state.conversations 不会反映当前目录；closed 与 archived 也不是同一状态。

**修复**：实时查询未归档 agent 目录（含 background，固定 created_at 排序完整分页），与关联 agentId 求交，之后才排序及截取 50 条；聊天候选复用同一目录查询。保留 closed 未归档项，不改写/删除历史 state，不改变路由和归档脚本。目录错误应失败，不可回退展示全部历史。

**验证**：manager/目录测试覆盖已归档、已删除、null 绑定、closed 未归档、分页、重复 cursor、过滤前历史超过 50 条、外部归档后下次查询生效和失败边界。

## 11. Slack dm 归档条件应匹配 agent 标题，而非连接名称

**现象**：`paseo ls` 中有名称形如 `Slack GCP · dm:chat-1:thread-1` 的 agent，但归档 dry-run 输出 `connections=0`。

**根因**：将同时包含 Slack 和 dm 的条件放在连接名上；实际连接叫 `Slack GCP`，只有 agent 标题带有 dm。安装版 CLI 将目录 API 的 `agent.title` 映射为 ls 的 `name`，不能直接在目录结果里读取 `agent.name`。

**修复**：从 `channel=slack` 的连接获取 state，以 `agent.title` 不区分大小写同时命中 Slack/dm，并保留连接/会话标签及全部闲置/在途保护。归档前重新检查标题，避免改名后继续归档；日志区分 `matched` 和 `eligible`。

**验证**：fixture 覆盖连接名不带 dm 仍发现 agent、大小写/顺序/缺失标题、非关联标签、闲置保护；隔离 fake CLI 子进程回归覆盖 dry-run、无 --force 的假归档和中途改名跳过。生产仅运行 dry-run，不记录真实聊天标识、不真实归档。

## 12. 裸 `!m` 查询被正在生成的模型回复挡住

**现象**：在同 thread 发送裸 `!m` 查询当前模型，但查询回执等到正在生成的实际模型回答之后才出现。

**根因**：`answer()` 的裸查询分支虽不入 `agent:` 队列，`handle()` 与 `rerunQueued()` 外层仍将所有消息放入同一个 `conversation:` 队列，前一轮 `deliver()` 等待模型并发送回答期间会阻塞只读查询。将查询并行化后还必须处理重载：只按会话选最新冻结 job 会让未完成查询覆盖原模型任务。

**修复**：仅将无关键词、无正文的首行裸 `!m` 放入独立 `model-query:` 会话队列，沿用授权、去重、原 thread 回发、持久化及超时流程；带参数切换和普通消息仍严格串行。重载同样分离查询与普通任务的最新 job。查询返回执行时实际模型，不等待已排队切换，不中断任务、不向模型发送 prompt。

**验证**：`tests/model-bridge.test.ts` 用未释放的模型完成 Promise 验证裸查询已投递、原模型任务仍未结束、已排队切换未执行、查询原 thread/reply 引用与去重不变；另覆盖忙时重载恢复与未授权查询。`tests/state-store.test.ts` 覆盖未完成查询与原模型任务分别恢复。门禁结果见 `docs/status.md`；用户授权后已热重载。独立 Pi agent + recorder channel 实机读取当前模型，并人为阻塞 conversation 队列验证裸查询先投递；无模型生成，自建 agent 已归档。Slack 健康检查通过，但真实 Slack 消息端到端未测。

## 13. 带正文的 `!m` 切换回执排在模型响应消息之后

**现象**：在 Slack 等支持原位编辑（`progress: "edit"`）或流式消息（`progress: "stream"`）的渠道发送 `!m 关键词\n正文` 时，线程中模型对正文的响应消息显示在第一条，而 `✅ 本 thread 后续使用 Pi 模型：…` 切换回执显示在响应消息下方，造成「首轮回复后才切模型」的错觉。

**根因**：`Bridge.deliver()` 在进入 `answer()` 前无条件调用 `sink.start()`，先在渠道内发出了 `⏳ 正在处理…` 进度占位（或开启流式消息，`msg-1`）；随后 `answer()` 完成模型切换并调用 `sendText()` 发送 `✅` 切换回执（`msg-2`，时间戳晚于 `msg-1`）；待模型生成完毕后，`sink.finish()` 将首块回复原位编辑进 `msg-1`，导致最终响应消息位于 `msg-1`（排在 `msg-2` 切换回执之前）。旧单测夹具将 `capabilities.progress` 设为 `"none"`，`sink.start()`/`finish()` 未创建占位消息，因而未暴露该时序倒置。

**修复**：`deliver()` 入口对 `!m` 命令不再提前启动 `ProgressSink`，且 `refreshProgress()` 在进度消息尚未创建前不触发刷新；纯 `!m` 切换与裸 `!m` 查询直接发送单条回执，不再产生多余的 `⏳` 占位；带正文的 `!m` 在模型切换确认且 `✅` 回执发送成功后再调用 `startProgress()` 创建进度占位（含 `dispatch === "sent"` 的重载恢复路径），保证切换回执始终先于进度占位与最终响应消息发出。

**验证**：`tests/model-bridge.test.ts` 新增 `edit` 与 `stream` 进度模式回归，覆盖切换回执先于进度占位与分段响应、纯切换/裸查询无多余占位、以及切换被拒时不残留孤儿进度消息。
