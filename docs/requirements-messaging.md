# 需求对照：Agent 间消息与通知（v0.1）

> 来源：fut-algo-api PLAN agent 的需求草案（2026-11-25），原文见仓库根 `docs/requirements-agent-messaging-v0.1.md`。
> 状态：P0 + P1 + 大部分 P2 已实现；本文件记录逐条落点，便于复核。

## 1. 工具

| 需求 | 实现 | 备注 |
|---|---|---|
| `send_message` | ✅ | ACL + 32KB 上限 + 幂等键 |
| `inbox` | ✅ | 默认当前 actor；main/user 可查任意 role |
| `read_message` / `ack_message` | ✅ | 只有收件人（或 main/user）能操作 |
| `wait_message` | ✅ | 500ms 轮询，上限 120s，收到即标记已读 |
| `broadcast` | ✅ | 仅 main，发往全部 plan/todo |
| `presence` | ✅ | `bootstrap`/工具调用自动心跳，5 分钟 TTL |
| `escalate` | ✅ | 生成 alert 给 user，并记录原因 |

## 2. 现有工具扩展

| 扩展 | 落点 |
|---|---|
| `bootstrap` 返回未读/blocking | `src/mcp/server.ts` bootstrap handler |
| `status` 增加未读/blocking | `statusText()` |
| `next` 优先显示 blocking | `next` handler |
| `ask` 自动发 question | `ask` handler + `canSend` 预校验 |
| `answer` / `close` 自动发消息并解除阻塞 | `Workflow.answerQuestion/closeQuestion` |
| `milestone_claim/complete/accept/reject` 自动事件 | `Workflow` 各方法末尾 |
| `commit_request` / `commit` 自动事件 | `Workflow.requestCommit/commitApproved` |
| `phase_activate` 通知所有 plan/todo | `Workflow.setActiveRepo` |

## 3. 自动事件矩阵

全部按 §7 实现；去重键为 `program:repo:event:milestone[:sha]`，
接收方在键尾追加 actor，避免多收件人互相覆盖。

## 4. 生命周期与失败

| 要求 | 实现 |
|---|---|
| `queued`（离线）→ `unread` | 发送时按 presence 判定；`bootstrap`/`inbox`/`wait` 提升 |
| `read` → `acked` | `read_message` / `ack_message` |
| blocking 未 ack 阻止推进 | `assertNotBlocked()` 拦截 claim/complete/accept/reject |
| 超时 `expired` + 升级 | 默认 45 分钟；`programStatus()`/`inbox` 惰性触发；升级给 user + main |
| 幂等 | `idempotency_key` 唯一，重复发送返回原消息 |
| 不丢消息 | 每条写一个 JSON 文件（原子写）+ `audit.jsonl`；唤醒失败不影响落盘 |
| 损坏消息 | 读取时跳过，不阻塞状态机 |
| 大消息 | >32KB 拒绝，要求放 evidence 并只引用路径 |

## 5. ACL

完全按 §9：todo→main 仅 alert；plan→user 仅 alert；跨仓经 main；
system（自动事件）不受限。

## 6. 验收标准对照

| # | 场景 | 测试 |
|---|---|---|
| 1 | 离线投递、上线后 unread、ack 后不再重复 | `tests/messages.test.ts` offline delivery |
| 2 | blocking 问题阻塞对方，answer 后解除 | `question lifecycle notifies and clears the blocker` |
| 3 | M 全流程自动通知（complete→accept→commit） | `milestone lifecycle emits notifications` |
| 4 | 重启持久化 | 同一测试中新建 `Workflow` 实例读取 |
| 5 | ACL（todo→main 契约变更被拒，alert 放行） | `message ACL matches the role matrix` |
| 6 | 幂等 | `idempotency key produces one message` |
| 7 | SessionStart hook 注入未读 | `session-start hook injects unread messages` |
| 8 | 唤醒失败但消息仍可拉取 | 离线投递测试（无 presence 仍可 inbox） |

## 7. 未做的部分

- Claude Code `SendMessage` 适配：未实现。理由：需要会话名映射，
  且唤醒只是加速，持久化 + hook + `wait_message` 已覆盖。
- 桌面/终端通知：只做看板。
- 消息归档/统计：未做；量级很小，后续需要再加 `messages/archive/`。
- 存储用每消息一个 JSON 文件而不是 SQLite：单机低量级下更简单、可手工检查，
  且与工具其余部分（Markdown/JSON）一致；换 SQLite 不影响接口。

## 8. 待确认问题的答复

1. 存储放 MCP 状态目录（`.workflow/runtime/messages/`），各仓
   `agent-questions.md` 继续作为人类可读审计。
2. 允许 plan→main 的 event/alert；契约决策仍应走 question。
3. `SendMessage` 适配暂不做，P0 用 hook + inbox + wait。
4. 用户通知只做看板，不做桌面通知。
5. blocking 默认 45 分钟，升级给 user（并抄送 main）。
