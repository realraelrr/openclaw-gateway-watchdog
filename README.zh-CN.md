# OpenClaw Gateway Watchdog

让你的本地 OpenClaw gateway 在 macOS 上更容易恢复，而不是悄悄坏掉。

OpenClaw Gateway Watchdog 是一个面向生产使用习惯的 `launchd` watchdog：它会定时探测 `openclaw gateway status --json`，在 gateway 不健康时自动重启或修复，并通过飞书或 Discord 发送告警。

[English README](./README.md)

许可证：MIT

## 这个项目解决什么问题

单靠 `launchd KeepAlive`，只能做到“进程死了就再拉起一次”。但它无法判断：

- gateway 是否真的健康
- gateway 是否只是刚启动，还没 ready
- gateway 是否还挂着进程，但 RPC 或健康检查已经坏掉

这个项目是在 macOS 原生 `launchd` 之上补一层“基于健康状态的自动恢复”，不引入额外常驻服务、不依赖容器，也不要求外部监控平台。

## 它能做什么

- 每次 tick 都探测 `openclaw gateway status --json`，而不是只看 PID。
- 只有当 `service.loaded=true`、`service.runtime.status="running"`、`rpc.ok=true`、`health.healthy=true` 同时满足时，才认为 gateway 健康。
- 对“已加载但尚未 ready”的状态判定为 `neutral`，避免冷启动阶段被误判。
- 连续失败达到阈值后，触发受 cooldown 保护的恢复流程，避免反复重启。
- 优先执行 `openclaw gateway restart`；如果服务未加载，再走 `gateway install` + `gateway start` 的修复路径。
- 在“开始重启”“重启成功”“重启失败”这三个关键节点发送飞书和/或 Discord 通知。

## 支持范围

当前仓库刻意只支持以下组合：

- macOS
- `launchd`
- OpenClaw CLI
- Discord 和飞书 webhook

它不是通用进程守护器，也不是跨平台 watchdog。

## 前置依赖

- `openclaw`
- `jq`
- `curl`
- `launchctl`

## 快速开始

1. 基于示例生成私有配置文件：
   - `mkdir -p "$(dirname "${WATCHDOG_ENV_FILE:-$HOME/.openclaw/config/watchdog.env}")"`
   - `cp config.example.env "${WATCHDOG_ENV_FILE:-$HOME/.openclaw/config/watchdog.env}"`
2. 在这个私有配置文件里填入 webhook 和可选覆盖项。
3. 安装 LaunchAgent：
   - `bash launchd/install-gateway-watchdog-launchagent.sh`
4. 确认服务已加载：
   - `launchctl list | rg "ai\.openclaw\.gateway-watchdog"`
5. 查看 watchdog 实时日志：
   - `tail -n 20 "${WATCHDOG_LOG_DIR:-$HOME/.openclaw/logs}/gateway-watchdog.log"`

## 通知示例

```text
[WATCHDOG] Gateway unhealthy, restarting (failures=3 host=My-Mac)
[WATCHDOG] Restart succeeded (host=My-Mac retries=6)
[WATCHDOG] Restart failed: gateway install failed (host=My-Mac retries=6)
[WATCHDOG] Restart failed: gateway start failed (host=My-Mac retries=6)
[WATCHDOG] Restart failed: recovery timed out (host=My-Mac retries=6)
```

当 watchdog 能判断失败点时，失败通知会带上更具体的原因，例如 `gateway install failed`、`gateway start failed` 或 `recovery timed out`。

## 工作原理

1. `launchd` 调用 `gateway-watchdog.sh` 作为稳定入口。
2. 入口脚本加载 `watchdog-core.sh`，再调用 `watchdog_main`。
3. watchdog 在每个 tick 中执行 `openclaw gateway status --json` 探测。
4. 连续失败次数写入 `gateway_watchdog_state.json`。
5. 达到阈值后，先发送“开始重启”通知，再执行恢复流程，最后发送“成功”或“失败”通知。

## 配置说明

配置优先级固定为：`process env > watchdog env file > defaults`

公共路径变量：

- `OPENCLAW_HOME`
- `WATCHDOG_STATE_DIR`
- `WATCHDOG_LOG_DIR`
- `WATCHDOG_ENV_FILE`

运行与行为变量：

- `NOTIFIER`
- `FAIL_THRESHOLD`
- `COOLDOWN_SEC`
- `POST_RESTART_RETRIES`
- `POST_RESTART_SLEEP_SEC`
- `OPENCLAW_BIN`
- `NODE_BIN`
- `WATCHDOG_ENABLED`
- `WATCHDOG_DISABLE_FILE`
- `DISCORD_WATCHDOG_WEBHOOK_URL`
- `FEISHU_WATCHDOG_WEBHOOK_URL`

watchdog 的 env 文件通过 allowlist 的 `key=value` 解析器读取，不会直接 `source` 整份 secret env 文件。

## 安全说明

1. 不要提交私有 watchdog env 文件；仓库里只应提交 `config.example.env`。
2. Webhook URL 属于 secret，应放在私有 env 文件中。
3. notifier 的加载是白名单方式，且仅限受控的 `notifiers/` 目录。
4. secret env 文件是“解析”，不是“执行”。

## 验证命令

```bash
bash -n gateway-watchdog.sh
bash -n watchdog-core.sh
bash -n config.sh
bash -n probe.sh
bash -n state.sh
bash -n notifiers/discord.sh
bash -n notifiers/feishu.sh
bash -n notifiers/composite.sh
bash -n launchd/install-gateway-watchdog-launchagent.sh
bash -n launchd/uninstall-gateway-watchdog-launchagent.sh
node --test tests/gateway-watchdog-feishu.test.mjs tests/gateway-watchdog-core.test.mjs
launchctl list | rg "ai\.openclaw\.gateway-watchdog"
tail -n 20 "${WATCHDOG_LOG_DIR:-$HOME/.openclaw/logs}/gateway-watchdog.log"
```

## 常见问题

### 为什么要单独用 `watchdog.env`，而不是直接复用整个 OpenClaw `.env`？

因为 watchdog 只需要一小部分明确列出的配置。把它们隔离在单独的 env 文件里，可以降低耦合、收缩 secret 暴露面，也更适合作为公开仓库复用。

### 为什么选 `launchd`，而不是另起一个常驻守护进程？

因为 v1 的目标就是 macOS 原生工具。`launchd` 已经存在，天然适合管理用户级服务生命周期，也更符合这个仓库的部署模型。

### 能不能拿来监控别的服务？

当前不建议直接拿来复用。现有探测和修复逻辑是围绕 `openclaw gateway status --json` 以及相关 OpenClaw CLI 命令定制的。

## 已知限制

1. `NOTIFIER=composite` 仍然是同步串行发送，通知端持续异常时仍可能拖慢 tick。
2. notifier 仍然是 `source` 方式加载，而不是子进程隔离。
3. 当前仓库只面向 `macOS + launchd + OpenClaw CLI`。

## 仓库地址

公开 GitHub 仓库：`https://github.com/realraelrr/openclaw-gateway-watchdog`
