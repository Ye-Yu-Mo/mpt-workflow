# mpt-workflow

[English](https://github.com/Ye-Yu-Mo/mpt-workflow/blob/main/README.md)

> 状态：pre-1.0。当前版本与下一步见 [ROADMAP.md](https://github.com/Ye-Yu-Mo/mpt-workflow/blob/main/ROADMAP.md)。

多 agent、多仓开发的**流程状态机**：一个本地 MCP server + 一个只读看板。

它替代的不是“文档”，而是文档背后那套**靠人转发、靠自觉遵守的协作流程**：
PLAN → TODO → 实现 → 验收 → 提交 → 问题问答。文档仍然留在 Markdown 里、仍然可用
git diff 审阅；工具负责状态、门禁、跨会话可见性。

```
上游约束                    本工具负责
─────────                  ──────────────────────────────────
PLAN.md / TODO-Mn.md   →   解析、状态推导、下一步
docs/agent-questions.md →  问答板、阻塞判定、前端回答
角色边界（main/plan/todo）→  MCP 工具权限 + Claude Code hook 拦截
验收与提交               →  证据自动记录、禁止自验、一次性审批
```

## 快速开始

> npm 包名是 **`mpt-workflow`**（`workflow-mcp` 已被无关包占用，不要安装那个名字）。
> 已发布到 npm：`npm i -g mpt-workflow`，或直接用 `npx mpt-workflow <命令>`。

```bash
npm install -g mpt-workflow

# 0. 想先看效果：在 $TMPDIR 建一个一次性工作区，不碰任何现有目录
mpt-workflow demo

# 1. 在工作流根目录（伞仓）初始化，采用已有 PLAN/TODO/questions，不覆盖任何文件
mpt-workflow init --root /path/to/workspace --adopt

# 2. 看一眼状态
mpt-workflow status --root /path/to/workspace

# 3. 起看板
mpt-workflow web --root /path/to/workspace --port 7788
#    → http://127.0.0.1:7788
```

源码 checkout 也可以用 `./scripts/demo.sh` 走同样的流程。

更多可复制的工作区见 [examples/](https://github.com/Ye-Yu-Mo/mpt-workflow/tree/main/examples/)（minimal / multi-repo / rust）；
遇到问题先看 [docs/troubleshooting.md](https://github.com/Ye-Yu-Mo/mpt-workflow/blob/main/docs/troubleshooting.md)。

`init` 会做这些事（全部幂等，已存在的文件不覆盖）：

| 产物 | 作用 |
|---|---|
| `.workflow/program.yaml` | 程序、仓库、阶段、active repo、契约（**进 git，可 review**） |
| `.workflow/.gitignore` | `runtime/` 本地状态不进 git |
| `<root>/.mcp.json`、`<每个仓>/.mcp.json` | 给 Claude Code 注册 MCP server（写了 `.git/info/exclude`，不污染 diff） |
| `<repo>/docs/agent-questions.md` | 缺失时补一份空问答板 |

装护栏（可选，但强烈建议）：

```bash
mpt-workflow init --root /path/to/workspace --install-hooks
```

会写 `.claude/settings.json`（每个仓 + 根目录）和 `.git/hooks/pre-commit`。

## 每天怎么用

### 1. 开会话时声明角色

每个 Claude Code 会话只做一件事。角色两种声明方式，**并发会话请用环境变量**：

```bash
# 方式 A：环境变量（推荐，多会话互不干扰）
WF_ROLE=plan WF_REPO=my-service claude
WF_ROLE=todo WF_REPO=my-service claude
WF_ROLE=main claude

# 方式 B：会话里调用 MCP 工具
bootstrap(role="plan", repo="my-service")
```

装了这个 MCP 后，会话第一句就可以是 `status` 或 `next`，不用再解释“我是谁、做到哪了”。

### 1.5 消息与通知

角色之间不再需要人工转发。每个状态动作都会自动给相关方发一条**持久化消息**：

```
todo: milestone_complete   → plan@repo   「待验收」
plan: milestone_accept     → main, user  「已验收，待 review/提交」
plan: milestone_reject     → todo@repo   「被打回」+ 原因
any:  commit_request       → user        approval_request + approval id
any:  commit               → main, user  「已提交 @ sha」
todo: ask(to=PLAN)         → plan@repo   question（blocking 时拦截对方推进）
```

收发：

```bash
mpt-workflow inbox --role plan --repo my-service --unread
mpt-workflow read msg-...        # 标记已读
mpt-workflow ack msg-... --note "已处理"
mpt-workflow wait --role plan --repo my-service --timeout 60000
mpt-workflow watch --role main   # 前台持续看
```

MCP 工具：`inbox` / `read_message` / `ack_message` / `wait_message` /
`send_message` / `broadcast`（仅 main）/ `presence` / `escalate`。

规则：

- **不丢**：offline 时 `queued`，下一次 `bootstrap`/`inbox` 变 `unread`；消息只增不删。
- **blocking**：未 ack 时接收方不能 `milestone_claim/complete/accept/reject`；`next` 会把它排在最前。
  回答 question 会自动 ack 对应的阻塞消息。
- **超时**：blocking 默认 45 分钟过期，过期后自动升级一条 alert 给 user 和 main。
- **幂等**：带 `idempotency_key` 的重复发送只产生一条。
- **ACL**：`todo@repo → plan@同仓`；`todo → main` 仅 `alert`；`plan → main`；`plan → todo@同仓`；
  `plan → user` 仅 `alert`；`main`/`user`/`system` 不受限；跨仓必须经 main。
- 唤醒是 best-effort：SessionStart hook 会注入未读摘要，但**消息本身以存储为准**。

### 2. 主 agent（main）

- `status` / `next` / `doctor` —— 全局视图。
- `phase_activate(repo="my-service")` —— 串行锁，一次只激活一个仓。
- `ask(to="user", ...)` —— 需要用户拍板时提问。
- 写伞仓 `docs/`、`CLAUDE.md`、`decisions` —— 直接用 Edit/Write，不需要经过工具。
- 提交伞仓文档：`commit_request(repo="root")` → 用户批准 → `commit(repo="root")`。
- **不写源码**（hook 会拦）。

### 3. PLAN agent（plan）

- `ask` / `answer` / `close` —— 问答。
- 写 `PLAN.md` / `TODO-Mn.md` —— 用原生 Write/Edit，模板沿用伞仓 `docs/template/`。
- `milestone_accept` / `milestone_reject` —— 验收，必须带证据；实现者不能自验。
- `scope_check` —— 检查实现方有没有越界。
- 不写源码、不碰伞仓（hook 会拦）。

### 4. TODO agent（todo）

- `milestone_claim` —— 领取 TODO。
- 写代码（原生 Edit/Write/Bash）。
- `evidence_run(command="cargo test --workspace --locked")` —— **由 server 执行并自动记录**退出码、SHA、tree oid、输出。手动声称的证据不可信。
- `milestone_complete` —— 进入待验收。
- 有歧义 → `ask(to="PLAN")`；blocking 时 hook 会直接拦住实现。
- 不能改 PLAN/TODO，不能自验，不能 push。

### 5. 用户

- 看板：`http://127.0.0.1:7788`
  - 问题收件箱：直接选选项、写决定 → 回写 Markdown，agent 下一次 `questions` 就能看到。**不用再复制粘贴转发。**
  - 消息：未读 / blocking / 审批请求，点“标记已处理”即 ack。
  - 批准提交：review 完 diff 点“批准”，agent 才能 `commit`。
  - 切换 active repo。
- 终端等价物：`mpt-workflow answer Q-005 --answer "..."`、`mpt-workflow approve <id>`、
  `mpt-workflow ack msg-...`。

## 提交是怎么被拦住的

```
agent: commit_request(message="feat: ...")
   → server 校验 scope，返回一次性 approval id
用户: 看板点“批准” 或 `mpt-workflow approve ap-xxx`
agent: commit(approval="ap-xxx")
   → 校验「审批时的工作区 hash」== 当前 hash，否则拒绝（防止批准后偷改）
   → 只做本地 git commit，永不 push
```

- Bash 的 `git commit` / `git push` 以及 `mpt-workflow approve|commit` 都会被 hook 拒绝；
  agent 只能走 MCP `commit`，push 由用户手工执行。
- 审批是**防误操作**，不是防恶意：同机同用户，agent 理论上能绕过。
  真正的护栏是 hook + 你 review diff 的习惯。

### 伞仓（`root`）提交

工作流根目录通常自己也是一个 git 仓库，存放伞仓文档。它用哨兵仓库 id **`root`**
寻址：`root` 不会出现在 `program.yaml.repos` 里，也没有 PLAN/TODO/里程碑状态。

```bash
# 在伞仓根目录、main 角色下：
commit_request(repo="root", message="docs: update umbrella contracts")
# 用户在看板批准，或：mpt-workflow approve ap-...
commit(repo="root", approval="ap-...")
```

MCP 进程就在伞仓根目录运行时，`repo` 可以省略。只有 `main` / `user` 能提交伞仓，
`plan` / `todo` 会被拒绝；提交 `root` 也不会改变会话绑定的仓库。

伞仓提交只允许以下路径：

| 允许 | 用途 |
|---|---|
| `CLAUDE.md` | 伞仓 agent 指令 |
| `docs/**` | 伞仓文档 |
| `milestone/**` | 跨仓里程碑与契约 |
| `.workflow/program.yaml` | 程序配置（受版本管理） |
| `.workflow/.gitignore` | 让 `runtime/` 不进 git |

其他路径会在暂存前被拒绝：子仓内容、嵌套仓库/gitlink、`.workflow/runtime/**`、
`.mcp.json`、`.claude/**`、`.git/**` 以及临时文件。审批同样绑定工作区 hash 和
暂存区 hash，批准后再改动会失效。伞仓提交只在本地完成，`git push` 始终由用户执行。

## 状态存在哪

**Markdown 是唯一事实源**（可 git diff、可 review）：

- `PLAN.md` —— M 总览表
- `TODO-Mn.md` —— `状态：` 行 / front-matter；`## 证据记录`；`## 验收记录`
- `docs/agent-questions.md` —— 问答
- `.workflow/program.yaml` —— 阶段、active repo、契约版本

**本地运行时**（`.workflow/runtime/`，已 gitignore）：事件日志、锁、审批、完整证据输出。

工具**不信任** PLAN/TODO 手写的状态字段：它从 TODO 文件解析、从 git 取 SHA、
从证据推状态。状态写错了会被看出来（`doctor`）。

## 工具清单

| 工具 | 角色 | 作用 |
|---|---|---|
| `bootstrap` | 全部 | 声明角色、返回权限矩阵 |
| `status` / `next` / `doctor` | 全部 | 状态、下一步、环境体检 |
| `questions` | 全部 | 列出问题 |
| `ask` / `answer` / `close` | 全部（按被问方） | 问答生命周期 |
| `milestone_claim` | todo/main | 领取 M |
| `milestone_complete` | todo/main | 实现完成 → 待验收 |
| `evidence_run` | todo/plan/main | 执行命令并记录证据 |
| `milestone_accept` / `milestone_reject` | plan/main | 验收 / 打回 |
| `scope_check` | 全部 | 改动 vs ACL + TODO 文件清单 |
| `commit_request` / `commit` | 全部（root：main/user） | 提交审批与执行 |
| `phase_activate` | main/user | 激活仓（串行锁） |
| `send_message` / `inbox` / `read_message` / `ack_message` | 全部（按 ACL） | 定向消息 |
| `wait_message` | 全部 | 长轮询等新消息（30–120s） |
| `broadcast` / `presence` / `escalate` | main / 全部 / 全部 | 广播、在线状态、升级 |

只保留原生工具**做不到**的：状态推导、跨进程状态、门禁、证据执行、审批。
读写文件仍然用 Edit/Write，不另造一套。

## 看板

单页、本地、默认只读：

- 顶部：程序进度（hero number）、阻塞问题、进行中的 M、待批准提交、脏工作区。
- 左：仓库卡片（里程碑轨道、当前 M、证据）+ 问题收件箱。
- 右：下一步、待批准提交、环境体检、时间线。
- 待批准提交可先看 diff；工作区变化会标记并禁用批准。
- 自动刷新不会抢输入焦点；写失败用固定 toast 提示；仓库卡片可直接“设为 active”。

唯一写操作：回答问题、关闭问题、批准提交、切换 active repo。

## 运维

```bash
mpt-workflow doctor                          # 运行时体积 + 失效 CLI 路径
mpt-workflow gc                              # dry-run，只报告
mpt-workflow gc --apply                      # 删除 30 天前已处理的消息/审批，以及过期 presence/lock
mpt-workflow gc --apply --evidence-days 90   # 同时删除 90 天前的完整证据日志
```

`gc` 默认不删除，`--apply` 才执行。未读消息和待批准审批永远不会被删除；
证据默认保留，只有显式 `--evidence-days` 才清理（TODO 里仍有截断副本）。
`--older-than N` 可以改已处理状态的阈值。

## 语言与客户端

本项目**中文优先**：CLI 输出、看板、MCP 工具描述和 server instructions 都是中文；
英文 README 用于发现项目。我们不做“只翻译一半”的 UI；完整 locale 层是 1.0 之后
按需求决定的事情。

**当前只支持 Claude Code**：它提供 `PreToolUse` / `SessionStart` hook，是角色 ACL
和提交门禁真正的执行边界。其他 MCP stdio 客户端可以连上，但不在支持范围内；没有
这些 hook 时，只有 MCP 工具和 git pre-commit 还有约束力。详见
[docs/support-scope.md](https://github.com/Ye-Yu-Mo/mpt-workflow/blob/main/docs/support-scope.md)。

## 与现有文档系统的关系

- **保留**：伞仓 `docs/` 的调研事实、契约文档、MS-N 快照、`milestone/SKILL.md`。
- **接管**：PLAN/TODO 的状态流转、问答板、验收门禁、提交审批、跨会话状态。
- **不接管**：代码实现、git 分支策略、部署。

## 与设计稿 v0.1 的差异

[docs/design-notes-v0.1.md](https://github.com/Ye-Yu-Mo/mpt-workflow/blob/main/docs/design-notes-v0.1.md) 是原始需求稿。实现时有意改了几处，原因见各自条目：

| 设计稿 | 这里 | 原因 |
|---|---|---|
| 三个角色三个 server，靠工具列表过滤 | 一个 server + `bootstrap` 握手 | 项目 `.mcp.json` 对所有会话生效，三个 server 会全部暴露；stdio 每会话一个进程，握手等价且更简单 |
| 角色 ACL 由 MCP 写工具校验 | 同一 ACL 引擎同时用于 MCP 和 **PreToolUse hook** | agent 改文件用 Edit/Write，不经过 MCP；hook 才是真正的拦截层 |
| 40+ 工具 | 25 个 | `plan_write`/`todo_get` 之类是 Edit/Read 的薄包装，占 token、增加选错概率 |
| 前端放 v0.3 | 与 MCP 同期 | 问题转发（P2/P11）是最高频痛点，只有 UI 能根治 |
| `.workflow/repo.yaml` 放每个子仓 | 全部状态放伞仓 `.workflow/` | 少 4 份要同步的状态，且不污染子仓 diff |
| 手写 evidence | `evidence_run` 由 server 执行并绑定 tree oid | 手写证据无法验证 |
| MS 工具包 | v1 不做 | 低频操作，skill 已够用；先 `ms_check` 都不做，避免规则双份 |

## 边界与已知限制

- 角色是**自报**的：MCP stdio 每个会话一个进程，`bootstrap` 决定本会话权限；
  这防误操作，不防恶意。hook 通过 `WF_ROLE` 环境变量拿到同一个角色。
- Bash 的路径 ACL 只检查明显的重定向；`python -c "open(...)"` 之类拦不住。
  git 层有 pre-commit scope 检查兜底。
- 证据记录绑定 `tree oid`（含已跟踪改动）+ 未跟踪文件内容 hash；受验后改文件会被发现。
- 不做通知推送；状态靠每次工具调用和看板刷新。
- 不做多机/多人协作。

## 开发

```bash
npm run typecheck
npm run lint      # Biome：格式 + lint
npm run format    # Biome：写入安全修复
npm test          # 72 个测试（含示例、MCP stdio 与看板端到端）
npm run build
```

代码结构：

```
src/core/       解析、状态机、ACL、git、证据、审批、消息
src/mcp/        MCP server（25 个工具）
src/web/        HTTP API + 单页看板
src/cli.ts      init/status/doctor/web/mcp/hook
tests/          node:test
```

## 参与贡献

- 开发环境、测试、加一个 MCP 工具的步骤：[CONTRIBUTING.md](https://github.com/Ye-Yu-Mo/mpt-workflow/blob/main/CONTRIBUTING.md)
- 安全模型与漏洞报告：[SECURITY.md](https://github.com/Ye-Yu-Mo/mpt-workflow/blob/main/SECURITY.md)
- 行为准则：[CODE_OF_CONDUCT.md](https://github.com/Ye-Yu-Mo/mpt-workflow/blob/main/CODE_OF_CONDUCT.md)
- 变更记录：[CHANGELOG.md](https://github.com/Ye-Yu-Mo/mpt-workflow/blob/main/CHANGELOG.md)
- 架构与设计取舍：[docs/architecture.md](https://github.com/Ye-Yu-Mo/mpt-workflow/blob/main/docs/architecture.md)

## 许可证

[MIT](https://github.com/Ye-Yu-Mo/mpt-workflow/blob/main/LICENSE)
