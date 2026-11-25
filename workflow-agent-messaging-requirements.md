# Workflow MCP — Agent 间消息与通知需求（v0.1）

> 日期：2026-11-25　作者：fut-algo-api PLAN agent
> 状态：需求草案，供 MCP 作者实现
> 目的：补齐 main / PLAN / TODO / user 之间的消息投递、未读与唤醒，减少人工转发。
> 关联：`docs/template/AGENT-QUESTIONS.md`、`docs/plan-and-milestone-workflow.md`、`fut-algo-api/docs/agent-questions.md`

---

## 1. 现状

- 角色：`main`、`plan@<repo>`、`todo@<repo>`、`user`。
- 现有 MCP 工具：`bootstrap`、`status`、`next`、`ask`、`answer`、`close`、`questions`、`milestone_claim/complete/accept/reject`、`evidence_run`、`scope_check`、`commit_request/commit`、`doctor`。
- 现有问答：`ask` 把问题写入 `<repo>/docs/agent-questions.md`；被问方通过 `status`/`questions` 读取后 `answer`；提问方 `close`。
- **缺口**：`ask` 只写文件，不会通知/唤醒对方；用户必须手工复制摘要给 main，再把回答复制回来。里程碑流转、提交请求也没有通知。

## 2. 目标与非目标

**目标**

1. 任何角色可向另一个角色**定向发送**结构化消息，消息持久化、可查、可确认（ack）。
2. 状态机事件自动产生通知：`milestone_complete`、`milestone_accept`、`milestone_reject`、`commit_request`、`commit`、`ask`、`answer`、`close`。
3. `status`/`next` 能看到未读与 blocking 消息，recipient 不会“不知道有消息”。
4. 提供可实现的唤醒路径：SessionStart/Resume hook、`inbox`/`wait` 轮询、可选 Claude Code `SendMessage` 适配。
5. 用户仍是提交/推送/业务决策的审批人，但不再承担日常消息路由。

**非目标**

- 不做任意聊天/群聊；只做工作流消息。
- 不替代用户对 commit/push/上线/业务决策的批准。
- 不保证接收方在完全离线且无 hook/轮询时被即时唤醒；保证**不丢消息**（at-least-once）。
- 不执行消息内容中的命令（消息是数据，不是脚本）。

## 3. 参与者与地址

| Actor | 地址 | 说明 |
|---|---|---|
| main | `main` | 程序主 agent |
| repo plan | `plan@fut-algo-api` | 单仓 PLAN agent |
| repo todo | `todo@fut-algo-api` | 单仓 TODO agent |
| user | `user` | 人类审批/看板 |
| system | `system` | MCP 状态机自身产生的事件 |

- `broadcast` 只允许 `main`；范围默认当前 program 的所有 plan/todo。
- 跨仓 PLAN 之间不直接发消息；需要 main 转发/汇总。
- 每个 actor 可绑定 Claude Code session 名称（可选），用于 `SendMessage` 唤醒适配。

## 4. 消息模型

```json
{
  "id": "msg-20261125-...",
  "project": "fut-trade-system",
  "repo": "fut-algo-api",
  "from": {"role": "todo", "repo": "fut-algo-api", "session": "fut-algo-api-7f"},
  "to":   {"role": "plan", "repo": "fut-algo-api"},
  "kind": "question|answer|event|handoff|alert|approval_request",
  "subject": "M4 实现完成，待验收",
  "body": "cargo test 54 tests; evidence E1/E2; 请验收",
  "refs": {
    "question_id": "Q-005",
    "milestone": "M4",
    "commit": "687dd93",
    "sha": "687dd9335fb8bf22e72269d79c4ff557b080084a",
    "tag": "fut-contract-v0.3.0",
    "evidence_id": "E2",
    "files": ["TODO-M4.md", "docs/fut-contract-freeze.md"]
  },
  "blocking": false,
  "status": "queued|unread|read|acked|expired|failed",
  "created_at": "2026-11-25T...",
  "read_at": null,
  "acked_at": null,
  "expires_at": null,
  "correlation_id": "M4-review",
  "idempotency_key": "fut-algo-api:M4:complete:687dd93"
}
```

约定：

- `body` 是纯文本/Markdown；限制长度（建议 32 KB）。
- `refs` 只放 ID/SHA/文件路径，不放大段日志；日志走 evidence。
- `blocking: true` 的消息必须出现在 recipient 的 `status`/`next` 顶部；未处理时 recipient 不得推进相关 M。
- `idempotency_key` 相同则返回已有消息，不重复投递。
- `expires_at` 到期未 ack → 变 `expired` 并升级提醒（见 §8）。

## 5. 生命周期

```
created -> queued -> unread -> read -> acked
                         \-> expired（超时未读/未 ack）
                         \-> failed（持久化/投递失败）
```

- `created`：写入存储成功。
- `queued`：接收方离线或未拉取。
- `unread`：接收方 `inbox` 可见、未读。
- `read`：接收方已读，未处理。
- `acked`：接收方确认处理（可带 note）。
- `expired`：超过 `expires_at`；blocking 消息升级给 user/main。
- 所有状态变更写 audit log；消息不可删除，只能归档。

## 6. MCP 工具需求

### 6.1 新增工具

| 工具 | 入参 | 返回 | 说明 |
|---|---|---|---|
| `send_message` | `to`, `kind`, `subject`, `body`, `refs?`, `blocking?`, `expires_at?`, `idempotency_key?` | `message_id` | 定向发送；校验 ACL |
| `inbox` | `role?`, `repo?`, `unread_only?`, `limit?`, `kind?` | `Message[]` + `unread_count` | 默认当前 actor；user/main 可查全部 |
| `read_message` | `id` | `Message` | 标记 read |
| `ack_message` | `id`, `note?` | `Message` | 标记 acked；blocking 解除 |
| `wait_message` | `role`, `repo?`, `timeout_ms` | `Message?` | 长轮询；无消息超时返回 null |
| `broadcast` | `kind`, `subject`, `body`, `refs?` | `message_id[]` | 仅 main |
| `presence` | `role`, `repo?`, `session?` | `Actor[]` | 上线/心跳/离线 |
| `escalate` | `id`, `reason` | `Message` | 升级给 user/main |

### 6.2 现有工具扩展

- `bootstrap`：返回 `unread_count`、`blocking_count`、`top_messages[]`；注册 presence。
- `status`：增加 `unread`、`blocking`、`last_message` 字段；blocking 消息置顶。
- `next`：若存在 blocking 消息，返回“先处理 msg-xxx”而不是里程碑动作。
- `ask`：创建问题的同时自动 `send_message(kind=question, to=recipient)`。
- `answer`：自动 `send_message(kind=answer, to=asker)`；blocking 问题解除。
- `close`：自动 `send_message(kind=event, subject=question closed)`。
- `milestone_complete`：自动通知 `plan@repo`（待验收）。
- `milestone_accept`：自动通知 `main` + `user`（已验收，待 review/commit）。
- `milestone_reject`：自动通知 `todo@repo`（打回原因）。
- `commit_request`：自动通知 `user`（approval_request，含 approval id）。
- `commit`：自动通知 `main` + `user`（committed SHA）。

### 6.3 CLI

```bash
workflow-mcp inbox --role plan --repo fut-algo-api --unread
workflow-mcp read msg-...
workflow-mcp ack msg-... --note "已处理"
workflow-mcp send --to main --kind event --subject "M4 accepted" --refs '{"milestone":"M4"}'
workflow-mcp wait --role plan --repo fut-algo-api --timeout 60
workflow-mcp watch --role main            # 前台 watch，适合用户/daemon
workflow-mcp dashboard                    # 可选：未读/blocking/里程碑总览
```

## 7. 自动事件矩阵

| 事件 | 发送方 | 接收方 | kind | 关键 refs |
|---|---|---|---|---|
| `ask` | 提问方 | 被问方 | question | question_id, milestone? |
| `answer` | 被问方 | 提问方 | answer | question_id |
| `close` | 提问方 | 原被问方 | event | question_id |
| `milestone_claim` | todo | plan | event | repo, milestone |
| `milestone_complete` | todo | plan | event | repo, milestone, evidence_id |
| `milestone_accept` | plan | main, user | event | repo, milestone, sha |
| `milestone_reject` | plan | todo | event | repo, milestone, reason |
| `commit_request` | 任意 | user | approval_request | approval_id, files, message |
| `commit` | 任意 | main, user | event | commit SHA |
| `phase_activate` | main | 全部 plan/todo | event | phase, repos |

- 去重键建议：`project:repo:event:milestone:sha`。
- 同一事件重复触发时返回已有 message，不重复通知。
- 事件通知失败不影响状态机事务；消息进入 queued，后续补投。

## 8. 唤醒与投递

MCP server 不能直接唤醒一个空闲的 Claude session。需要组合以下路径：

1. **SessionStart/Resume hook（推荐）**
   - hook 调用 `workflow-mcp inbox --role <role> --repo <repo> --unread --format hook`。
   - 把 `unread_count`、blocking 消息、最近 3 条消息注入会话上下文。
   - 现有 workflow hook 已注入状态摘要，扩展成本最低。

2. **`status`/`next` 集成**
   - 每次 `status`/`next` 都显示 unread/blocking；agent 不会“看不见”。
   - blocking 消息在 `next` 中优先于里程碑动作。

3. **`wait_message` 长轮询 / `watch` CLI**
   - agent 空闲时可调用 `wait_message`（建议 30–60s）。
   - 用户可用 `workflow-mcp watch` 在终端持续看到消息。

4. **Claude Code `SendMessage` 适配（可选）**
   - 若 actor 绑定了同机 session 名称，`send_message` 在持久化后 best-effort 发一条
     `"workflow: N unread, blocking=..."` 的唤醒 ping；业务内容仍从 inbox 读。
   - 适配器失败不影响消息持久化；不能把 ping 当唯一投递。

5. **用户通知**
   - blocking 超时/审批请求可桌面通知/终端高亮；用户仍可人工介入。

**保证**：消息 at-least-once 持久化；唤醒是 best-effort。

## 9. ACL

| 发送方 | 允许接收 |
|---|---|
| main | 任意 actor / broadcast |
| plan@repo | main；todo@同一 repo |
| todo@repo | plan@同一 repo |
| user | 任意（主要用于审批/通知） |
| system | 任意（状态机事件） |

- 跨仓 plan→plan 默认禁止；需要 main 转发。
- todo 不得绕过 plan 直接向 main 提契约变更；允许 `alert`（如阻塞/事故）并抄送 plan。
- 消息内容不触发 shell/文件写入；只做通知。
- 提交/推送仍需 `commit_request` + 用户批准。

## 10. 持久化与一致性

- 存储：`$WORKFLOW_STATE_DIR/messages/`（JSON 文件或 SQLite；建议 SQLite + JSONL audit）。
- 原子写：temp + rename + fsync；文件锁；进程重启不丢。
- 索引：按 `to/status/created_at`；`unread_count` 走索引。
- 保留：默认 30 天，归档到 `messages/archive/`；blocking/审批消息保留更久。
- 幂等：`idempotency_key` 唯一索引；重复 send 返回已有 ID。
- 审计：`messages/audit.jsonl` 记录 create/read/ack/expire/escalate。

## 11. 失败与边界

- 接收方离线：消息 `queued`；上线后 `bootstrap`/`inbox` 拉取。
- blocking 超时：`expired` + `escalate` 给 user/main；不自动代替决策。
- 重复事件：按 `idempotency_key` 去重。
- 消息过大：拒绝 >32 KB；日志/证据走文件引用。
- 时钟漂移：以 server 时间为准；客户端时间只作显示。
- 存储损坏：跳过坏消息 + audit/alert；不阻塞状态机。
- 多实例：文件锁/DB 事务；同一 actor 多 session 时按 session 维度 presence，消息按 actor 聚合。

## 12. 验收标准（可测试）

1. **离线投递**：main 不在线，plan 发 `milestone_accept`；main 下一次 `bootstrap` 看到 unread；`inbox`/`ack` 后不再重复。
2. **blocking**：todo 向 plan 发 blocking question；plan 的 `next` 显示“先处理 msg-xxx”；todo 的 `status` 显示等待；`answer` 后解除。
3. **M4 全流程**：todo `milestone_complete` → plan 收到通知 → plan `milestone_accept` → main/user 收到通知 → `commit_request` → 用户批准 → `commit` 事件；全程无人工复制消息。
4. **重启持久化**：重启 MCP server 后未读/blocking 仍在。
5. **ACL**：todo 直接向 main 发契约变更被拒；alert 允许并抄送 plan。
6. **幂等**：同一 `idempotency_key` 重复 send 只产生一条消息。
7. **hook 注入**：SessionStart/Resume 能看到 unread/blocking 摘要。
8. **不丢消息**：发送成功但唤醒失败，消息仍可被 inbox 拉取。

## 13. 分阶段实现建议

- **P0（最小可用）**：`send_message`/`inbox`/`read`/`ack` + `status`/`next` 未读字段 + SessionStart hook 注入。
- **P1**：`ask`/`answer`/`close`、milestone/commit 自动事件 + blocking/expire/escalate + 幂等。
- **P2**：`wait_message`/`watch`、presence、Claude Code `SendMessage` 适配、dashboard。
- **P3**：跨 program 广播、消息归档/统计、告警集成。

## 14. 待确认

1. 消息存储放 MCP server 状态目录，还是放各仓 `docs/`？建议 MCP 状态目录 + 各仓 `agent-questions.md` 保留人类可读审计。
2. 是否允许 `plan` 直接给 `main` 发普通 event？建议允许 event/alert，契约决策仍走 question。
3. Claude Code `SendMessage` 是否对所有部署可用？若不可用，P0 只做 hook + inbox。
4. 用户是否需要桌面/终端通知，还是看板即可？
5. blocking 超时默认时长（建议 30–60 分钟）与升级对象（main 还是 user）。
