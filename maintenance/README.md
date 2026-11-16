# 运维维护（maintenance）

独立于 `server/` 插件业务和 `scripts/` 开发检查的主机维护工具。不会被插件入口加载，安装或重载插件也不会自动注册 cron。

## agent-archive：Slack dm 闲置 agent 归档

```text
agent-archive/
├── slack-dm-archive.mjs       # 默认 dry-run；--apply 才归档
├── slack-dm-archive.test.mjs  # 离线 fixture，纳入 npm test
└── run-slack-dm-archive.sh    # cron 入口：加锁并传 --apply
```

### 匹配与保护

- **匹配 agent 名称，而不是连接名**：`paseo ls` 的 `name` 对应目录 API 的 `agent.title`，须不区分大小写同时包含 `Slack` 和 `dm`（子串，不要求顺序）。例如 `Slack GCP · dm:chat-1:thread-1`、`dm Slack AWS`。缺失标题或只命中一个词不匹配。
- 连接仅要求 `channel=slack`，例如名为 `Slack GCP` 的连接也会被发现；支持多个 Slack 连接，各用自己的 IM state 检查。agent 必须有对应的 `im/connection` 与 `im/conversation` 标签，不能仅凭标题归档非 Slack/未关联会话。标题匹配不等同额外的会话类型检查。
- 无 Slack 连接时正常退出；Slack 连接 ID 无效/重复、路由配置异常或读取失败时失败关闭，不放宽筛选。日志 `matched` 表示标题与 Slack 连接标签都匹配的数量，`eligible` 表示额外通过闲置及保护规则的数量。
- 最近元数据/用户消息/关注时间及 IM 会话/job 活动均须至少闲置 24 小时；仅处理 `idle` / `closed` 且不需要关注的 agent。
- 跳过显式绑定的 agent、未完成/不确定投递、未回答问题和 IM state 中仍有 followup 的 agent。
- 每次归档前重新读取配置、目录和 IM state，并重新校验标题（中途改名不再匹配则跳过）；使用 CLI `archive`，不传 `--force`。

**边界**：检查与归档并非原子操作，仍有竞态；followup 不覆盖所有后台进程。归档保留历史文件，但旧工作区路由线程后续发消息会新建 agent，不能自动沿用旧上下文。每天一次扫描，实际通常闲置 24–48 小时才归档，停机不会补跑。

### 验证与部署

在仓库根目录运行：

```sh
node --test maintenance/agent-archive/slack-dm-archive.test.mjs
node maintenance/agent-archive/slack-dm-archive.mjs --dry-run
# 限定单个 agent 的只读检查：
node maintenance/agent-archive/slack-dm-archive.mjs --dry-run --only <agent-uuid>
```

直接运行 `.mjs` 默认只读；**运行 shell 包装器会真实归档**。需要执行时显式传 `--apply`，不可同时传 `--dry-run`。

本机 GCP 的 ubuntu crontab（主机时区 UTC，20:10 UTC = 北京时间次日 04:10）：

```cron
10 20 * * * "$HOME/.paseo/local-plugins/paseo-im/maintenance/agent-archive/run-slack-dm-archive.sh" 2>&1 | /usr/bin/logger -t paseo-slack-archive
```

按目标机器替换绝对仓库路径；迁移时替换旧 cron 行，不要并存两份任务。查看日志：`journalctl -t paseo-slack-archive`。

### 路径配置

- `PASEO_HOME`：默认 `~/.paseo`。
- `PASEO_BIN`：默认 `~/.npm-global/bin/paseo`。
- `PASEO_CLI_DIST`：默认 `~/.npm-global/lib/node_modules/@getpaseo/cli/dist`。脚本依赖安装版 CLI 内部 API，升级后须重验。
- `PASEO_MAINTENANCE_STATE_DIR`：包装器锁目录，默认 `~/.local/share/paseo-maintenance`。

包装器通过自身位置查找 `.mjs`，不依赖 cron 工作目录。锁文件继续使用 `slack-gcp-archive.lock` 以兼容迁移前的执行实例；锁、运行数据和凭据不纳入 Git。本工具属于仓库运维源码，目前不在插件 npm 发布 `files` 清单中。
