# AGENTS.md — agent 协作者操作约定

> 本项目欢迎 agent 参与共建：IM 消息可直接驱动 agent 改代码，agent 也能以普通 PR 贡献者身份工作。
> 权利与义务对齐人类贡献者，另有五条铁律。**TL;DR**：改前跑门禁 → 只动分内文件 → 秘密不碰 → 实机 bug 必沉 gotchas → 协议无据不瞎改 → PR 里声明参与程度。

## 1. 门禁铁律

- 任何代码变更前后各跑一次：`npm run typecheck && npm test`（全绿才算完成）。本分支默认只跑 Slack 适配器、其共享桥接/后台回发/连接管理/权限/队列/路由/状态/分段逻辑和 Slack dm 归档维护测试；全渠道测试保留为 `npm run test:all`，仅按需显式运行。
- 新增/修改渠道适配器：必须对照 `docs/channel-test-matrix.md` 该渠道清单补充/更新测试；实机联调项按 K 清单验收并记录到 `docs/webui-acceptance.md`。
- 触碰文档：状态变化同步 `docs/status.md`（状态表/修复索引），踩坑同步 `docs/gotchas.md` 对应节——知识回路是既定工作法，不是可选动作。

## 2. 边界（不可逾越）

- 永不读取、引用、入库任何凭据与运行时私有数据：`secrets/`、`$PASEO_HOME/plugin-data/`、真实 token/AppID/用户 ID。
- 日志与文档示例一律用占位符（`token-abc`、`user-1@im.wechat`、`<msg-id>`）——`scripts/check-redaction.mjs` 是守卫，命中即视为事故。
- 破坏性操作（删除连接、清空状态、重置配对）必须先获得人工确认。
- **默认不 push**：commit 按需进行；推送远端（push）必须等待用户显式命令，或由人工手动执行。仓库可无 remote 运行。
- 不确定协议行为时（尤其 iLink 等未公开接口）：先写最小复现脚本实证，再改代码；禁止凭推理改协议字段（先例：gotchas §5.7 二维码 HTML 陷阱）。

## 3. 知识回路

- 实机 bug 修复 = 代码 + 测试 + gotchas 节（现象/根因/修复/验证四段）+ `status.md` 修复索引行（commit 对照）。
- 排查方法论沿用 gotchas §6（失败详情优先 / 时间过滤读日志 / 状态直读 / RPC 环回 / 复现优先于猜测）。
- 无人工自测优先：能写成脚本断言的验收（如 `scripts/verify-pairing.mjs`）不留给人工点按钮。

## 4. 协作边界（多 agent / 人-agent）

- 同一问题多会话并行时，先完成者把结论同步给其他活跃会话（注明 commit 与验收证据），避免重复排查。
- 涉及运行时状态的修复，优先改写**运行中组件持有的同一实例**，独立实例只写盘会被内存态覆盖（gotchas §5.8 双实例竞态）。
- 对用户可见的行为变更（路由/回发/配对语义）必须在 `docs/status.md` 状态表更新后才能宣布完成。

## 5. 披露

- agent 参与的 PR 在描述中必须包含披露行（格式见 `.github/PULL_REQUEST_TEMPLATE.md`）：参与程度（none / assisted / autonomous+reviewed）与模型标识（provider/model）。
- IM 桥接会话中 agent 的自主修复：完成后在 `docs/status.md` 留痕，并在对话中给出可复现的验收证据（脚本输出/日志行），不以「已完成」替代证据。
