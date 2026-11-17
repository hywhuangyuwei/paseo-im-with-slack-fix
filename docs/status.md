# paseo-im 当前状态手册（Status Handbook）

> EN summary: all three flagship channels (QQ / Telegram / WeChat) are live-verified and bridged to one agent session. This file is the living handbook — channel states, defect fix index with commit map, no-human acceptance commands, backlog. Pitfall details live in `docs/gotchas.md`.

> 三通道实机在线的活文档：通道状态、缺陷修复索引（commit 对照）、自测/验收命令、待办清单。
> 变更后更新本文件；踩坑细节一律沉淀到 `docs/gotchas.md`，本文只放「是什么/怎么验/还欠什么」。

## 1. 通道状态（实机验收截止 2026-11-08）

| 渠道 | 连接 | 状态 | 绑定去向 | 备注 |
| --- | --- | --- | --- | --- |
| QQ | PaseoImQqBot | ✅ 在线 | 共同对话 agent | 官方 WS 长连接，断线 RESUME；实机收发/去重/准入/去向全通过 |
| Telegram | PaseoImTgBot | ✅ 在线 | 共同对话 agent（共享历史） | IPv6 黑洞修复后长轮询稳定；偶发 fetch failed 为瞬时抖动自动重试 |
| 微信 | PaseoWeChatBot | ✅ 在线 | 共同对话 agent（共享历史） | iLink 扫码配对实机闭环；二维码本地 PNG 生成；仅私聊 |
| 其余 9 渠道 | — | 适配器/单测齐备 | — | 实机联调待凭据，按 `docs/channel-test-matrix.md` K 清单逐渠道验收 |

会话绑定现状（`connections/<id>/state.json` 的 conversations）：QQ/TG/微信 DM 均指向共同对话 agent（target-agent）。修改去向请走 App「连接详情 → 消息去向」保存——save 时自动把跟随旧 agent 的会话绑定迁移/矫正（gotchas §5.8），无需手动清理。

### 2026-11-14 本机 Slack / IM 管理面修复

- Slack 每次 Socket Mode `hello` 均上报就绪，重连后恢复 ready/running 并清除旧 lastError；旧适配器及停止后的回调不可污染当前连接。
- IM「已关联会话」及已有聊天候选只展示当前未归档 agent；closed 但未归档的仍保留。目录完整分页，先过滤再截取最近 50 条；仅过滤展示，不删除历史路由状态。
- 验证：`tests/manager.test.ts` 与 Slack 重连回归；线上重载/RPC 结果见 `docs/webui-acceptance.md`。

### 运维维护分类：Slack dm 闲置 agent 归档

- 新增 `maintenance/agent-archive/`，接管原仓库外的归档脚本、cron 入口和独立测试；说明见 [maintenance/README.md](../maintenance/README.md)。
- 筛选修正为 **agent 标题**（`paseo ls` 的名称）不区分大小写同时包含 `Slack` 与 `dm`；连接仅要求 `channel=slack`，支持多个连接分别检查，并保留 `im/connection`、`im/conversation` 标签校验。中途改名会在归档前重新检查。
- 保留 24 小时闲置阈值、运行/关注/未完成投递/后台续跑/澄清问题/显式绑定保护、操作前复查和无 `--force`。归档后旧工作区线程会新建 agent，历史文件保留。
- cron 每天 20:10 UTC（北京时间次日 04:10），运行路径迁到本仓库；锁与日志仍留仓库外。安装插件不自动注册定时任务。
- 归档 fixture 纳入默认 Slack 相关 `npm test`，含不带 dm 的连接名、标题匹配/排除、标签隔离、24 小时阈值与归档前改名回归；子进程测试使用合成配置和 fake CLI，不接触生产归档。修复后默认 98/98 通过，typecheck、check:package、check:runtime 通过；生产 dry-run 为 `connections=1 agents=4 matched=2 eligible=0`，标题已命中但尚未全部通过闲置及保护条件。不重命名连接、不真实归档。修复根因见 gotchas §11。

### 默认测试范围：仅 Slack 相关

- `npm test` 只运行 Slack 适配器、共享桥接/后台续跑/连接管理/权限/队列/路由迁移/状态持久化/文本分段和 Slack dm 归档维护测试，不执行其他渠道适配器测试。
- 原全渠道及维护测试保留为 `npm run test:all`，仅按需显式执行；默认不需要 iMessage 的 Node 22 定时器兼容 preload。类型检查仍覆盖 server/client。
- 验证：无兼容 preload 的默认 `npm test` 98/98 通过（0 失败、0 取消）；typecheck、check:package、check:runtime 及 diff 空白检查通过。本轮未运行全渠道测试。

### Thread 模型命令 `!m`（2026-11-16 已部署，真实 Slack 消息端到端未测）

| 能力 | 状态 | 范围 / 验证 |
| --- | --- | --- |
| `!m` 模糊选择 Pi 模型 | ✅ 回归通过，已部署 | 首行命令；裸 `!m` 只读显示当前/新会话默认模型；带参数按ID/名称分词包含匹配，唯一命中才切换，歧义列候选 |
| 当前 thread 后续沿用 / 新 thread 隔离 | ✅ 回归通过，已部署 | 只改工作区创建的独占 Pi agent，不改路由 profile；固定/共享 agent 拒绝 |
| 无正文只切模型 / 切换回执 | ✅ 回归通过，已部署 | 无模型生成；有正文先回执再发送，失败不静默降级 |
| 忙时队列 / 重载防重 / 超时补发 | ✅ 回归通过，已部署 | 带参数切换等前轮结束；持久化解析结果与 applied/notified，派发 identity 回查；补发只读本命令结果 |
| 裸 `!m` 优先只读回复 | ✅ 回归及独立 Pi 验收通过，已热重载 | 独立 `model-query` 队列，不等当前模型回答；查询时的实际模型/新会话默认；重载不挤掉未完成模型任务 |

- 使用说明与边界见 `README.md`「Thread 内切换 Pi 模型」。
- 后续小功能：裸 `!m` 查询当前模型（尚无 agent 则显示新会话默认），不发现目录、不创建 agent、不切换或生成；已有/共享聊天也允许只读查询。仅类型检查及模型相关 23/23 定向测试，真实 Pi 裸查询和热重载后 Slack 健康检查通过，未运行大套件。
- 拉取维护工具前验证通过：修改前 450 项、修改后 470 项测试全绿（新增 20 项）；双侧 typecheck、`check:package`、`check:runtime` 与 `git diff --check` 均通过。
- 两组 `!m` 回归已加入默认 `npm test` 的 Slack 相关测试清单，也可单独运行 `node --test tests/model-command.test.ts tests/model-bridge.test.ts`；全部渠道入口为 `npm run test:all`。
- 本机 Paseo 0.15.4 热重载成功，插件 enabled/running；重载后 im.list=12 渠道、Pi choices 可用，Slack running/ready=true、lastError=null、im.test=true。未重启 daemon，未修改归档定时任务。
- 默认门禁 118/118 通过；真实 Pi 使用独立测试 agent 验证模型切换读回、同 thread 复用、新 thread 默认隔离及纯命令无生成，验收 agent 已归档。未修改现有 IM 聊天模型，未发送真实 Slack 用户消息；详情见 `docs/webui-acceptance.md` 的本轮记录。

### 2026-11-17 同 Thread 跨轮后台续跑 `pendingTasks` 交接修复

- 保持每会话最多单个活跃 `followup` watcher 的不变量；同会话同 `agentId` 的新消息完成首轮投递时，先将前序 `followup` 追平至新消息 `after` 游标，再将未消费的 `pendingTasks` 交接给新 Job 并清空旧 `followup`。
- 不向 Agent 发送 prompt 的纯 `!m` 命令及派发前校验失败的请求不打断现有 `followup`。
- 验证：默认门禁 `npm run typecheck && npm test` 125/125 通过（新增 4 项跨轮交接/游标追平/裸 `!m` 不打断用例），`check:package`、`check:runtime`、脱敏/链接守卫与 `git diff --check` 通过；本机 `paseo plugin reload paseo-im` 热重载后 `im.list=12`、Slack `running/ready=true`、`lastError=null`、`im.test=true`。详情见 gotchas §8。

### 裸 `!m` 不等待正在生成的模型回复（本轮）

- 首行裸 `!m`（无关键词、无正文）走独立只读队列；不查询 catalog、不创建/切换 agent、不发送 prompt，也不打断原任务及后台 `followup`。
- 带参数切换及普通消息仍按原顺序执行；查询显示当前实际模型，不将已排队但未执行的切换说成已生效。
- 同 thread 的重载恢复分别选取最新模型任务与最新裸查询，防止查询覆盖原任务。
- 验证：修改前默认门禁 125/125；新增回归在旧代码复现 3 个预期失败（查询阻塞、恢复阻塞、恢复挤掉原任务）。修复后双侧 typecheck 与默认测试 130/130、模型命令/桥接/状态恢复定向测试 35/35 全绿，package/runtime、脱敏/文档链接守卫与 `git diff --check` 通过。文档守卫初次命令误写为 `check-doc-links.mjs`，已以正确的 `check-docs-links.mjs` 补跑通过；不是代码测试失败。用户随后授权 reload and push：已通过 `paseo plugin reload paseo-im --json` 热重载，无 daemon 重启；`im.list=12`、Pi choices 可用、Slack running/ready=true、lastError=null、im.test=true。独立 Pi agent + recorder channel 验证裸查询在普通会话队列释放前投递，无模型生成、无真实 Slack 消息，三个自建验收 agent 已归档；提交/推送获用户授权。根因与回归见 gotchas §12，验收边界见 `docs/webui-acceptance.md`。
- Agent participation: autonomous (deployment/push authorized by user); model: `nv-infer/azure/openai/gpt-6.1-sol`。

## 2. 缺陷修复索引（实机调试全记录，按主题）

| 主题 | 现象 | 根因 | 细节 |
| --- | --- | --- | --- |
| 裸 `!m` 回复晚于模型正文 | 模型仍在生成时，查询当前模型也等待 | 只读分支绕过 agent 队列，但外层仍共用 conversation 队列 | gotchas §12 |
| Slack dm 归档未匹配 | ls 明明有 Slack dm agent，但脚本 connections=0 | 将 agent 名称条件误放在连接名称上，CLI name 实际对应 agent.title | gotchas §11 |
| Slack 重连状态卡住 | 已恢复收发仍显示断开/退避 | Manager 只在首次 start 完成后清错，后续 hello 没有状态通知 | gotchas §9 |
| IM 历史关联过多 | 已归档或无绑定会话继续展示 | 直接列举历史 conversations，未与实时未归档目录求交 | gotchas §10 |
| Telegram 出站全网失败 | 连接报「网络错误」自动重试，同机 curl 正常 | WSL2 双栈域名 IPv6 路由黑洞，node 拨号卡 v6 不回退 v4 | gotchas §5.5 |
| 插件重载丢在途回复 | 重载窗口内的 agent 回复静默丢失 | 内存队列蒸发，job 冻结 dispatch null/sent | gotchas §7 |
| Pi 后台续跑答复未回发 IM | 首次 idle 已回复，后台完成后的最终答复丢失；或同 thread 中途插话后前序未到期 `bg_run` 唤醒答复丢失 | 旧桥接只追踪首轮；后继消息直接清空旧 `followup` 未交接 `pendingTasks` | gotchas §8 |
| 微信配对无二维码 | 点击扫码配对无响应/白卡 | qrUrl 是 text/html 落地页 + pollLogin 30s 阻塞 + configure 鸡生蛋死锁 | gotchas §5.7 |
| 凭证输入无显示/切换 | 手机端无眼睛按钮 | labelAccessory 仅 web host 渲染 | gotchas §5.6 |
| 改去向不生效 | 换新 agent 后消息仍进旧会话 | 会话绑定压过 target + save 双实例竞态回滚 | gotchas §5.8 |
| 钉钉卡片无令牌（P0） | 整渠道进度流必坏 | 审查发现 | channel-test-matrix |
| P1×10 / P2×30 | 各渠道审查项 | 四组并行深审 | 审查修复提交线（36 文件 +1993/-295） | 同上 |

## 3. 自测 / 验收命令集（全部无人工可跑）

```sh run
# 默认门禁：双侧 tsc + Slack 相关回归（提交前必跑）
cd "$(git rev-parse --show-toplevel)" && npm run typecheck && npm test
```

```sh run
# 微信扫码配对环回自测（连生产 daemon，无人工）：自动建连复用 + PNG 魔数二维码 + 15s 交付时限 + 孤儿复用
cd "$(git rev-parse --show-toplevel)" && node scripts/verify-pairing.mjs
```

```sh run
# 通道绑定对齐自检：三条连接 im.save 一次（reconcile 会话绑定到 routing 期望值）
cd "$(git rev-parse --show-toplevel)" && timeout 60 node --input-type=module -e "
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import os from 'node:os';
const require_ = createRequire(process.cwd() + '/package.json');
const { DaemonClient } = await import(pathToFileURL(require_.resolve('@getpaseo/client/internal/daemon-client')).href);
const home = process.env.PASEO_HOME ?? `${os.homedir()}/.paseo`;
const lock = JSON.parse(readFileSync(home + '/paseo.pid', 'utf8'));
const client = new DaemonClient({ url: 'ws://127.0.0.1:' + lock.listen.split(':').pop() + '/ws', clientId: 'paseo-im-selftest', clientType: 'cli', appVersion: '0.15.2', connectTimeoutMs: 8000,
  localCredential: () => readFileSync(home + '/local-credential', 'utf8').trim(),
  logger: { debug(){}, info(){}, warn(){}, error(){} } });
await client.connect();
const list = await client.invokePluginRpc('paseo-im', 'im.list', {});
for (const bucket of list.channels) for (const view of bucket.connections) {
  const saved = await client.invokePluginRpc('paseo-im', 'im.save', { id: view.config.id, revision: view.config.revision, target: view.config.target, enabled: view.config.enabled });
  console.log(bucket.channel, 'reconciled');
}
await client.close();
"
```

微信回发观测眼：`sendTextChunk` 成功即打 `sendmessage ok to=… client=… bytes=…`（`paseo plugin logs paseo-im` 数行数）——真实发送次数与微信显示数不一致即为 iLink 平台显示层（gotchas §5.9 四层取证法）。

## 4. 协同分工记录（两 agent + 桥接会话）

- `audit-agent`（已完成并归档）：多角度全量审查线——四组并行深审 11 渠道，1×P0+10×P1+30×P2 全修（审查修复提交线），产出测试矩阵与 54 个回归用例。
- `bridge-agent`（桥接会话，QQ/TG/微信汇合）：实机联调修复线——TG IPv6 黑洞、微信配对三坑、凭证 UI 端差异、改去向 reconcile（§5.5–§5.8）。
- `target-agent`（当前三通道共同去向）：在途回复恢复线——重载孤儿 job 统一重放（§7）、三通道补发验收闭环、微信三连终判。
- 协同事实：两个 agent 在同一 repo 各自提交（审查修复线 / 实机联调修复线 / 重载恢复线三条提交线），互不冲突；本文档为其信息合并产物。

## 5. 待办

1. 其余 9 渠道实机联调（凭据到位后按矩阵 K 清单逐渠道验收；TG/微信/QQ 已闭环）。
2. 微信三连若再现：按 gotchas §5.9 四层取证，`sendmessage ok` 行数为唯一判据，超 1 行先查本链路，1 行则反馈 iLink 平台。
3. ~~`state-store` 测试 tmp 清理竞态（ENOTEMPTY，间歇 1/N）~~ **已根修**（写链 `drain()` 静止模式：`withStore` 先排空 fire-and-forget 持久化再 `rm`；`manager.deactivate` 同步获得排空语义，顺带消除重载截断最后一次 `updateJob` 持久化的窗口。state-store 单文件 30 连跑 + 全量 6 连跑验证）。余下 whatsapp 配对/并行全量的时序 flake 为另一类（负载相关，诊断法见 gotchas §7 附带坑），独立跟踪。
4. Telegram 偶发 `fetch failed`（IPv6 修复后残余瞬时抖动）：自动重试已覆盖，若频率上升按 §5.5 排查序列复核宿主 v6 路由。
