# OpenClaw Gateway Watchdog

让你的本地 OpenClaw gateway 在 macOS 上更容易恢复。

OpenClaw Gateway Watchdog 是一个小型 `launchd` watchdog：它检查 `openclaw gateway status --json`，在 OpenClaw gateway 健康合同失败时恢复服务，并通过飞书或 Discord 发送更清楚的告警。

[English README](./README.md)

许可证：MIT

## 范围

健康合同要求 `openclaw gateway status --json` 同时满足：

- `service.loaded == true`
- `service.runtime.status == "running"`
- `rpc.ok == true`
- `health.healthy == true`

已加载但尚未 ready 的状态会被视为 `neutral`，避免冷启动阶段误触发恢复。这个 watchdog 只通过 OpenClaw CLI 管理本地 OpenClaw gateway；不管理 Hermes、cloudflared、代理、DNS、OpenClaw 升级，也不提供远程聊天命令。

恢复优先执行 `openclaw gateway restart`。如果服务未加载或未安装，再回退到 `openclaw gateway install` 和 `openclaw gateway start`。

## 本地主动重启

不等待被动探测，直接本地触发重启：

```bash
bash gateway-watchdog.sh restart gateway
```

这个能力只在本地 CLI 生效；没有 webhook receiver、聊天命令或远程控制端点。

## 安装

依赖：macOS、`openclaw`、`jq`、`curl`、`launchctl`，以及用户级 OpenClaw gateway。

```bash
mkdir -p "$(dirname "${WATCHDOG_ENV_FILE:-$HOME/.openclaw/config/watchdog.env}")"
cp config.example.env "${WATCHDOG_ENV_FILE:-$HOME/.openclaw/config/watchdog.env}"
bash launchd/install-gateway-watchdog-launchagent.sh
launchctl list | rg "ai\.openclaw\.gateway-watchdog"
tail -n 20 "${WATCHDOG_LOG_DIR:-$HOME/.openclaw/logs}/gateway-watchdog.log"
```

安装脚本会把可运行副本部署到 `${OPENCLAW_HOME:-$HOME/.openclaw}/watchdog/runtime/current`，避免 `launchd` 依赖云盘同步目录里的 repo 路径。

## 配置

优先级：`process env > WATCHDOG_ENV_FILE > defaults`。

常用选项：

- `WATCHDOG_DISPLAY_NAME`：告警标题；Hermes 和 OpenClaw 都有 watchdog 时尤其有用。
- `NOTIFIER`：`discord`、`feishu` 或 `composite`。
- `FAIL_THRESHOLD`、`COOLDOWN_SEC`、`POST_RESTART_RETRIES`、`POST_RESTART_SLEEP_SEC`。
- `OPENCLAW_BIN`、`NODE_BIN`、`WATCHDOG_ENABLED`。
- `DISCORD_WATCHDOG_WEBHOOK_URL`、`FEISHU_WATCHDOG_WEBHOOK_URL`。

路径覆盖项包括 `OPENCLAW_HOME`、`WATCHDOG_STATE_DIR`、`WATCHDOG_LOG_DIR`、`WATCHDOG_ENV_FILE` 和 `WATCHDOG_DISABLE_FILE`。

Webhook URL 属于 secret，应放在私有 env 文件中。env 文件通过 allowlist 的 `key=value` 解析器读取，不会被当作 shell 脚本 source。

## 告警

告警是多行、面向用户的文本，包含：

- watchdog 显示名和事件状态
- 主机和来源（`passive watchdog` 或 `local CLI`）
- 故障环节和 raw reason
- 本次动作
- 最后一行 raw 字段，便于排查

示例：

```text
[OpenClaw Gateway Watchdog] 自动重启已触发

主机: my-mac
来源: passive watchdog
故障环节: OpenClaw Gateway / 健康状态
原因: gateway_status_unhealthy - openclaw gateway status --json 未满足健康合同
动作: 重启 OpenClaw gateway
连续失败: 3
raw: event=restart_triggered host=my-mac failures=3 reason=gateway_status_unhealthy action=restart_gateway
```

当 watchdog 能判断失败点时，失败摘要会包含 `gateway install failed`、`gateway start failed` 或 `recovery timed out`。

## 验证

```bash
bash -n gateway-watchdog.sh watchdog-core.sh config.sh probe.sh state.sh \
  notifiers/discord.sh notifiers/feishu.sh notifiers/composite.sh \
  launchd/install-gateway-watchdog-launchagent.sh \
  launchd/uninstall-gateway-watchdog-launchagent.sh
node --test tests/gateway-watchdog-core.test.mjs tests/gateway-watchdog-feishu.test.mjs
```

## 限制

- `NOTIFIER=composite` 是同步串行发送。
- 探测是本地 OpenClaw gateway 运行合同检查，不是外部端到端客户端测试。
- 仓库刻意只支持 `macOS + launchd + OpenClaw CLI`。
