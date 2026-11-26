import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkAcl } from './acl.js';
import {
  configPath,
  evidenceDir,
  findRoot,
  loadConfig,
  ROOT_REPO_ID,
  runtimeDir,
  saveConfig,
} from './config.js';
import {
  appendEvidenceSection,
  listTodoFiles,
  parseEvidence,
  parsePlan,
  parseTodo,
  setTodoSha,
  setTodoStatus,
  statusLabel,
} from './docs.js';
import {
  ensureDir,
  exists,
  isoNow,
  readText,
  readTextRequired,
  truncate,
  within,
  writeAtomic,
} from './fsutil.js';
import { dirSize, formatBytes } from './gc.js';
import {
  allChangedFiles,
  diffStat,
  commit as gitCommit,
  gitInfo,
  gitlinkPaths,
  stageAll,
  stagedTreeHash,
  workingTreeHash,
  workingTreeOid,
} from './git.js';
import { matchGlob } from './glob.js';
import { appendToSection } from './markdown.js';
import { type Actor, actorFromRole, actorKey, MessageStore } from './messages.js';
import { parseQuestionsFile, questionsFile, updateQuestion } from './questions.js';
import { readRoleLease, sessionDisplay } from './session.js';
import {
  type Approval,
  createApproval,
  listApprovals,
  logEvent,
  readApproval,
  supersedeApprovals,
  withLock,
  writeApproval,
} from './state.js';
import type {
  DoctorFinding,
  MilestoneState,
  NextAction,
  ProgramConfig,
  ProgramStatus,
  Question,
  RepoState,
  Role,
  TodoDoc,
} from './types.js';
import { isRole } from './types.js';

export interface RepoRef {
  id: string;
  abs: string;
}

export class Workflow {
  root: string;
  cfg: ProgramConfig;
  private _msgs?: MessageStore;
  private cfgMtimeMs = 0;
  private cfgSize = 0;
  private cfgIno = 0;
  private cfgVersion = '';
  private cfgLoadedAt = '';
  private cfgMtime = '';
  private cfgError?: string;

  constructor(root: string, cfg?: ProgramConfig) {
    this.root = path.resolve(root);
    const loaded = cfg || loadConfig(this.root);
    if (!loaded) throw new Error(`未找到 ${path.join(this.root, '.workflow/program.yaml')}`);
    this.cfg = loaded;
    this.trackConfigState();
  }

  /** Record the current file stat/hash without replacing the in-memory config. */
  private trackConfigState(): void {
    const p = configPath(this.root);
    try {
      const text = fs.readFileSync(p, 'utf8');
      const st = fs.statSync(p);
      this.cfgVersion = crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
      this.cfgMtimeMs = st.mtimeMs;
      this.cfgSize = st.size;
      this.cfgIno = st.ino;
      this.cfgMtime = new Date(st.mtimeMs).toISOString();
      this.cfgLoadedAt = isoNow();
      this.cfgError = undefined;
    } catch {
      /* missing/unreadable config: leave the error to refreshConfig */
    }
  }

  /**
   * Reload program.yaml when its mtime/size/inode changed. Every MCP tool call
   * and status read calls this, so a second agent's config edit is visible
   * without restarting the process. On a parse error the last good config is
   * kept and the error is reported in `status.config.error`.
   */
  refreshConfig(): { changed: boolean; error?: string } {
    const p = configPath(this.root);
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      this.cfgError = 'program.yaml 不存在';
      return { changed: false, error: this.cfgError };
    }
    if (st.mtimeMs === this.cfgMtimeMs && st.size === this.cfgSize && st.ino === this.cfgIno) {
      return { changed: false, error: this.cfgError };
    }
    const loaded = loadConfig(this.root);
    this.cfgMtimeMs = st.mtimeMs;
    this.cfgSize = st.size;
    this.cfgIno = st.ino;
    this.cfgMtime = new Date(st.mtimeMs).toISOString();
    if (!loaded) {
      this.cfgError = 'program.yaml 无法解析（保留上次有效配置）';
      return { changed: false, error: this.cfgError };
    }
    this.cfg = loaded;
    try {
      this.cfgVersion = crypto
        .createHash('sha256')
        .update(fs.readFileSync(p))
        .digest('hex')
        .slice(0, 12);
    } catch {
      /* the file changed again between load and hash; keep the old version */
    }
    this.cfgLoadedAt = isoNow();
    this.cfgError = undefined;
    // Program/repo changes invalidate the cached message store.
    this._msgs = undefined;
    try {
      logEvent(this.root, {
        role: 'system',
        tool: 'config_reloaded',
        ok: true,
        detail: { version: this.cfgVersion, mtime: this.cfgMtime },
      });
    } catch {
      /* the audit log is best-effort */
    }
    return { changed: true };
  }

  sessionIdentity(): { role: Role; repo?: string; id?: string } | null {
    const lease = readRoleLease(this.root);
    if (!lease || !isRole(lease.role)) return null;
    return { role: lease.role, repo: lease.repo, id: sessionDisplay(lease.session) };
  }

  /** Message store for this program (lazy). */
  get msgs(): MessageStore {
    if (!this._msgs) {
      this._msgs = new MessageStore({
        root: this.root,
        project: this.cfg.program,
        repos: this.cfg.repos.map((r) => r.id),
      });
    }
    return this._msgs;
  }

  actor(role: Role, repo?: string): Actor {
    return { role, repo };
  }

  /** Idempotent workflow event; never fails the state transition. */
  private notifyEvent(input: {
    from: Role;
    repo?: string;
    to: Actor[];
    kind: 'event' | 'alert' | 'approval_request';
    subject: string;
    body?: string;
    refs?: Record<string, string | string[]>;
    blocking?: boolean;
    key: string;
  }): void {
    try {
      this.msgs.emit({
        from: { role: input.from, repo: input.repo },
        to: input.to,
        kind: input.kind,
        subject: input.subject,
        body: input.body,
        refs: input.refs,
        blocking: input.blocking,
        repo: input.repo,
        idempotencyBase: `${this.cfg.program}:${input.key}`,
      });
    } catch {
      /* notification must not break the state machine */
    }
  }

  /** Unacked blocking messages for an actor; used to gate transitions. */
  private assertNotBlocked(role: Role, repoId: string): void {
    const blocked = this.msgs.blockingFor({ role, repo: repoId });
    if (blocked.length) {
      throw new Error(
        `有未处理的 blocking 消息，先读并 ack：${blocked.map((m) => m.id).join(', ')}\n` +
          blocked.map((m) => `  ${m.id}  ${m.subject}`).join('\n'),
      );
    }
  }

  static discover(start: string): Workflow | null {
    const root = findRoot(start);
    if (!root) return null;
    return new Workflow(root);
  }

  /* ------------------------------ repos ------------------------------ */

  repoRefs(): RepoRef[] {
    return this.cfg.repos
      .filter((r) => r.id !== ROOT_REPO_ID)
      .map((r) => ({
        id: r.id,
        abs: path.isAbsolute(r.path) ? r.path : path.join(this.root, r.path),
      }));
  }

  repoRef(id: string): RepoRef {
    if (id === ROOT_REPO_ID) return { id, abs: this.root };
    const r = this.repoRefs().find((x) => x.id === id);
    if (!r)
      throw new Error(`未知仓库 ${id}；已配置: ${this.cfg.repos.map((x) => x.id).join(', ')}`);
    return r;
  }

  repoConfig(id: string) {
    if (id === ROOT_REPO_ID) {
      throw new Error(`'${ROOT_REPO_ID}' 是伞仓保留 id，不是配置中的仓库`);
    }
    const c = this.cfg.repos.find((r) => r.id === id);
    if (!c) throw new Error(`未知仓库 ${id}`);
    return c;
  }

  /** Map an absolute path to the repo that owns it. */
  repoForPath(absPath: string): RepoRef | null {
    for (const r of this.repoRefs()) {
      if (within(r.abs, absPath)) return r;
    }
    return null;
  }

  save(): void {
    saveConfig(this.root, this.cfg);
    this.refreshConfig();
  }

  /* --------------------------- questions ---------------------------- */

  questionFiles(): { abs: string; repo?: string }[] {
    const out: { abs: string; repo?: string }[] = [];
    for (const r of this.repoRefs()) {
      const f = questionsFile(r.abs);
      if (exists(f)) out.push({ abs: f, repo: r.id });
    }
    const rootF = path.join(this.root, 'docs', 'agent-questions.md');
    if (exists(rootF)) out.push({ abs: rootF });
    return out;
  }

  allQuestions(): Question[] {
    return this.questionFiles().flatMap((f) => parseQuestionsFile(f.abs, f.repo));
  }

  findQuestion(id: string): Question | null {
    return this.allQuestions().find((q) => q.id === id) || null;
  }

  /** Answer a question: update the file, notify the asker, clear the blocker. */
  answerQuestion(q: Question, answer: string, resolution: string | undefined, by: Actor): void {
    withLock(this.root, 'questions', () =>
      updateQuestion(q.file, q.id, { status: 'answered', answer, resolution }),
    );
    const asker = actorFromRole(String(q.from), q.repo);
    try {
      this.msgs.send({
        from: by,
        to: asker,
        kind: 'answer',
        subject: `${q.id} 已回答：${q.context.split('\n')[0].slice(0, 80)}`,
        body: answer,
        refs: { question_id: q.id, repo: q.repo || '' },
        idempotency_key: `${this.cfg.program}:answer:${q.id}`,
        repo: q.repo,
      });
    } catch {
      /* the file is updated; notification is best-effort */
    }
    // Clear the blocker for whoever the question was addressed to, even when a
    // human answered on their behalf (e.g. the user answering a PLAN question).
    this.msgs.ackByRef(by, 'question_id', q.id);
    const addressee = actorFromRole(String(q.to), q.repo);
    if (actorKey(addressee) !== actorKey(by)) {
      this.msgs.ackByRef(addressee, 'question_id', q.id);
    }
  }

  /** Close a question: update the file, notify the other party. */
  closeQuestion(q: Question, resolution: string | undefined, by: Actor): void {
    withLock(this.root, 'questions', () =>
      updateQuestion(q.file, q.id, { status: 'closed', resolution }),
    );
    const asker = actorFromRole(String(q.from), q.repo);
    const addressee = actorFromRole(String(q.to), q.repo);
    const other = actorKey(by) === actorKey(asker) ? addressee : asker;
    try {
      this.msgs.send({
        from: by,
        to: other,
        kind: 'event',
        subject: `${q.id} 已关闭`,
        body: q.resolution || resolution || '',
        refs: { question_id: q.id, repo: q.repo || '' },
        idempotency_key: `${this.cfg.program}:close:${q.id}`,
        repo: q.repo,
      });
    } catch {
      /* best-effort */
    }
    // Closing (even without an answer) must clear the blocking message on both
    // sides; otherwise the addressee stays gated by a question that is gone.
    for (const actor of [by, asker, addressee]) {
      try {
        this.msgs.ackByRef(actor, 'question_id', q.id);
      } catch {
        /* message cleanup is best-effort */
      }
    }
  }

  /* -------------------------- repo state ---------------------------- */

  repoState(id: string): RepoState {
    const ref = this.repoRef(id);
    const conf = this.repoConfig(id);
    const plan = parsePlan(ref.abs); // PlanDoc | null
    const todoFiles = listTodoFiles(ref.abs);
    const todos = new Map<string, TodoDoc>();
    for (const f of todoFiles) {
      const doc = parseTodo(path.join(ref.abs, f));
      if (doc) todos.set(doc.id, doc);
    }

    const ids = new Set<string>();
    for (const m of plan?.milestoneIds || []) ids.add(m);
    for (const m of todos.keys()) ids.add(m);

    const git = gitInfo(ref.abs);

    const milestones: MilestoneState[] = [...ids]
      .sort((a, b) => Number(/(\d+)/.exec(a)?.[1]) - Number(/(\d+)/.exec(b)?.[1]))
      .map((mid) => {
        const todo = todos.get(mid);
        const evidence = todo ? parseEvidence(todo) : [];
        let status: MilestoneState['status'] = todo ? todo.status : 'planned';
        // `committed` is derived, never written: an accepted TODO whose record is
        // clean in git means the acceptance itself has landed in history.
        if (status === 'accepted' && todo && git.available) {
          const rel = path.relative(ref.abs, todo.file).split(path.sep).join('/');
          if (!git.changed.includes(rel) && !git.untracked.includes(rel)) {
            status = 'committed';
          }
        }
        return {
          id: mid,
          title: todo?.title || plan?.milestoneTitles[mid] || mid,
          status,
          statusRaw: todo ? todo.statusRaw : '无 TODO',
          repo: id,
          todoFile: todo ? path.relative(this.root, todo.file) : undefined,
          sha: todo?.sha,
          acceptance: todo?.acceptance || [],
          evidence: evidence.map((e) => ({
            id: e.id,
            at: e.at,
            command: e.command,
            exitCode: e.exitCode,
            head: e.head,
            tree: e.tree,
            dirty: e.dirty,
            outputTail: e.outputTail,
          })),
          planRef: todo?.planRef,
        };
      });

    const current = milestones.find((m) => !['accepted', 'committed'].includes(m.status)) || null;

    const questions = exists(questionsFile(ref.abs))
      ? parseQuestionsFile(questionsFile(ref.abs), id)
      : [];

    const problems: string[] = [];
    if (!plan) problems.push('缺少 PLAN.md');
    if (milestones.length === 0) problems.push('PLAN 中未解析到任何 M，且无 TODO-Mn.md');
    if (git.dirty)
      problems.push(`工作区有未提交改动: ${git.changed.length + git.untracked.length} 个文件`);
    const acceptedMilestones = milestones.filter((m) => m.status === 'accepted');
    if (acceptedMilestones.length) {
      problems.push(`${acceptedMilestones.map((m) => m.id).join(', ')} 已验收但尚未提交`);
    }
    for (const q of questions.filter((q) => q.blocking && q.status === 'open')) {
      problems.push(`阻塞问题未回答: ${q.id}`);
    }

    // phase: explicit PLAN phase, else the phase that lists this repo
    const phase = plan?.phase || this.cfg.phases.find((p) => p.repos.includes(id))?.id;

    return {
      id,
      path: conf.path,
      absPath: ref.abs,
      branch: conf.branch,
      phase,
      plan: plan
        ? {
            file: path.relative(this.root, plan.file),
            title: plan.title,
            version: plan.version,
            statusRaw: plan.statusRaw,
            phase: plan.phase,
            milestoneIds: plan.milestoneIds,
          }
        : undefined,
      milestones,
      currentMilestone: current,
      questions,
      git,
      problems,
    };
  }

  /* --------------------------- program ------------------------------ */

  programStatus(): ProgramStatus {
    const refresh = this.refreshConfig();
    try {
      this.msgs.expireDue();
    } catch {
      /* expiry is best-effort */
    }
    const repos = this.repoRefs().map((r) => this.repoState(r.id));
    const questions = this.allQuestions();
    const blocking = questions.filter((q) => q.blocking && q.status === 'open');
    const next = this.nextActions(repos, blocking, questions);
    const rootFiles = this.rootPendingFiles();
    if (rootFiles.length) {
      next.push({
        actor: 'main',
        action: '提交伞仓文档',
        detail: `${rootFiles.length} 个文件待提交：${rootFiles.slice(0, 5).join(', ')}${
          rootFiles.length > 5 ? ' …' : ''
        }；commit_request(repo="root")`,
        blocking: false,
      });
    }
    return {
      program: this.cfg.program,
      root: this.root,
      activeRepo: this.cfg.active_repo,
      session: this.sessionIdentity(),
      config: {
        path: configPath(this.root),
        version: this.cfgVersion || '(unknown)',
        loaded_at: this.cfgLoadedAt,
        mtime: this.cfgMtime,
        error: refresh.error ?? this.cfgError,
      },
      phases: this.cfg.phases,
      repos,
      questions,
      blockingQuestions: blocking,
      next,
      generatedAt: isoNow(),
    };
  }

  /** Allowlisted umbrella files with uncommitted changes (empty without a git root). */
  rootPendingFiles(): string[] {
    if (!gitInfo(this.root).available) return [];
    return allChangedFiles(this.root).filter((f) => isRootCommitAllowed(f));
  }

  nextActions(repos: RepoState[], blocking: Question[], questions: Question[]): NextAction[] {
    const out: NextAction[] = [];

    for (const q of blocking) {
      const to = String(q.to).toLowerCase();
      out.push({
        actor: to === 'plan' ? 'plan' : to === 'user' ? 'user' : 'main',
        action: '回答阻塞问题',
        detail: `${q.id} (${q.from} → ${q.to})：${q.context.split('\n')[0].slice(0, 120)}`,
        repo: q.repo,
        question: q.id,
        blocking: true,
      });
    }

    // Answered questions belong to the asker: apply the decision, then close.
    for (const q of questions) {
      if (q.status === 'answered') {
        out.push({
          actor: nextActor(String(q.from)),
          action: '应用回答并 close',
          detail: `${q.id} 已回答：先把结论回写到 PLAN/TODO/decisions，再 close(${q.id}, resolution=...)；只 answer 不 close 会一直未闭合`,
          repo: q.repo,
          question: q.id,
          blocking: false,
        });
      } else if (q.status === 'open' && !q.blocking) {
        out.push({
          actor: nextActor(String(q.to)),
          action: '回答非阻塞问题',
          detail: `${q.id} (${q.from} → ${q.to})：${q.context.split('\n')[0].slice(0, 120)}`,
          repo: q.repo,
          question: q.id,
          blocking: false,
        });
      }
    }

    const activeId = this.cfg.active_repo;
    if (!activeId) {
      const nextPhase = this.cfg.phases.find((p) => p.status !== 'accepted' && p.status !== 'done');
      out.push({
        actor: 'main',
        action: '激活一个仓',
        detail: nextPhase
          ? `程序阶段 ${nextPhase.id}「${nextPhase.title}」尚未完成；选择一个仓开始`
          : '所有阶段已完成，准备最终验收',
        blocking: false,
      });
      return out;
    }

    const active = repos.find((r) => r.id === activeId);
    if (!active) {
      out.push({
        actor: 'main',
        action: '修正配置',
        detail: `active_repo=${activeId} 不在 repos 列表中`,
        blocking: true,
      });
      return out;
    }

    const pendingCommit = active.milestones.filter((x) => x.status === 'accepted');
    if (pendingCommit.length) {
      out.push({
        actor: 'user',
        action: '评审并 commit',
        detail: `${pendingCommit.map((x) => x.id).join(', ')} 已验收，等待 review diff 后批准提交`,
        repo: activeId,
        milestone: pendingCommit[pendingCommit.length - 1].id,
        blocking: false,
      });
      return out;
    }

    const m = active.currentMilestone;
    if (active.milestones.length === 0) {
      out.push({
        actor: 'plan',
        action: '补 PLAN.md / 里程碑',
        detail: `${activeId} 没有解析到任何 M；先写 PLAN 的里程碑总览和 TODO-M1`,
        repo: activeId,
        blocking: false,
      });
      return out;
    }
    if (!m) {
      out.push({
        actor: 'main',
        action: '阶段收尾',
        detail: `${activeId} 所有 M 已验收；确认后 activate 下一个仓或进行阶段验收`,
        repo: activeId,
        blocking: false,
      });
      return out;
    }

    const base = { repo: activeId, milestone: m.id, blocking: false };
    switch (m.status) {
      case 'planned':
        out.push({
          ...base,
          actor: 'plan',
          action: `写 TODO-${m.id}.md`,
          detail: `${activeId} / ${m.id}「${m.title}」还没有 TODO；PLAN agent 按 PLAN 生成`,
        });
        break;
      case 'todo_ready':
        out.push({
          ...base,
          actor: 'todo',
          action: `claim 并实现 ${m.id}`,
          detail: `${activeId} / ${m.id}「${m.title}」TODO 已就绪`,
        });
        break;
      case 'implementing':
        out.push({
          ...base,
          actor: 'todo',
          action: `实现并用 evidence_run 记录证据`,
          detail: `${activeId} / ${m.id}「${m.title}」实现中；完成后调用 milestone_complete`,
        });
        break;
      case 'review':
        out.push({
          ...base,
          actor: 'plan',
          action: `验收 ${m.id}`,
          detail: `${activeId} / ${m.id}「${m.title}」待验收；证据 ${m.evidence.length} 条`,
        });
        break;
      case 'rejected':
        out.push({
          ...base,
          actor: 'todo',
          action: `按打回意见返工 ${m.id}`,
          detail: `${activeId} / ${m.id}「${m.title}」已被打回`,
        });
        break;
      case 'accepted':
      case 'committed':
        out.push({
          ...base,
          actor: 'user',
          action: '评审并通过 commit',
          detail: `${activeId} / ${m.id} 已验收，等待用户 review diff 后提权提交`,
        });
        break;
    }

    const repoBlocking = blocking.filter((q) => q.to === 'PLAN' || q.to === 'main');
    if (repoBlocking.length === 0) {
      // no-op; kept for clarity
    }
    return out;
  }

  /* --------------------------- mutations ---------------------------- */

  setActiveRepo(id: string | null): void {
    if (id === ROOT_REPO_ID) {
      throw new Error(`'${ROOT_REPO_ID}' 是伞仓保留 id，不能作为 active_repo`);
    }
    if (id !== null) {
      const ref = this.repoRef(id); // validate
      if (!exists(ref.abs)) throw new Error(`仓库目录不存在: ${ref.abs}`);
    }
    withLock(this.root, 'program', () => {
      const fresh = loadConfig(this.root);
      if (fresh) this.cfg = fresh;
      this.cfg.active_repo = id;
      this.save();
    });
    if (id) {
      this.notifyEvent({
        from: 'main',
        to: this.cfg.repos.flatMap((r) => [
          { role: 'plan' as const, repo: r.id },
          { role: 'todo' as const, repo: r.id },
        ]),
        kind: 'event',
        subject: `active repo 切换为 ${id}`,
        body: '串行锁：一次只激活一个仓。未激活的仓暂停实现。',
        refs: { repo: id },
        key: `activate:${id}:${Date.now()}`,
      });
    }
  }

  /** Validate a phase activation without writing (used before the repo lock). */
  assertPhaseActivation(id: string, acceptPrevious = false): void {
    const p = this.cfg.phases.find((x) => x.id === id);
    if (!p) throw new Error(`未知阶段 ${id}`);
    if (acceptPrevious) return;
    const previous = this.cfg.phases.filter((q) => q.status === 'active' && q.id !== id);
    if (previous.length) {
      throw new Error(
        `阶段 ${previous.map((q) => q.id).join(', ')} 仍为 active；` +
          `加 accept_previous=true 明确接受旧阶段，或先单独设置其状态`,
      );
    }
  }

  updatePhase(
    id: string,
    status: 'planned' | 'active' | 'accepted' | 'done',
    opts: { acceptPrevious?: boolean } = {},
  ): { id: string; from: string; to: string; auto: boolean }[] {
    return withLock(this.root, 'program', () => {
      const fresh = loadConfig(this.root);
      if (fresh) this.cfg = fresh;
      const p = this.cfg.phases.find((x) => x.id === id);
      if (!p) throw new Error(`未知阶段 ${id}`);
      const changes: { id: string; from: string; to: string; auto: boolean }[] = [];
      // Activating a phase is explicit: by default it never changes another
      // phase. The caller must opt in to accepting the previously active one.
      if (status === 'active') {
        this.assertPhaseActivation(id, opts.acceptPrevious);
        const previous = this.cfg.phases.filter((q) => q.status === 'active' && q.id !== id);
        if (opts.acceptPrevious) {
          for (const q of previous) {
            changes.push({ id: q.id, from: q.status, to: 'accepted', auto: true });
            q.status = 'accepted';
          }
        }
      }
      if (p.status !== status) {
        changes.push({ id: p.id, from: p.status, to: status, auto: false });
      }
      p.status = status;
      this.save();
      return changes;
    });
  }

  todoPath(repoId: string, milestone: string): string {
    return path.join(this.repoRef(repoId).abs, `TODO-${milestone}.md`);
  }

  requireTodo(repoId: string, milestone: string): { abs: string; doc: TodoDoc } {
    const abs = this.todoPath(repoId, milestone);
    const doc = parseTodo(abs);
    if (!doc) throw new Error(`${repoId} 缺少 TODO-${milestone}.md；先由 PLAN agent 生成`);
    return { abs, doc };
  }

  private assertActiveRepo(repoId: string): void {
    const active = this.cfg.active_repo;
    if (active && active !== repoId) {
      throw new Error(`仓库 ${repoId} 不是 active_repo（当前 ${active}）；先 activate ${repoId}`);
    }
  }

  claim(repoId: string, milestone: string, role: Role): MilestoneState {
    return withLock(this.root, `todo-${repoId}-${milestone}`, () =>
      this.claimUnlocked(repoId, milestone, role),
    );
  }

  private claimUnlocked(repoId: string, milestone: string, role: Role): MilestoneState {
    this.assertActiveRepo(repoId);
    this.assertNotBlocked(role, repoId);
    const { abs, doc } = this.requireTodo(repoId, milestone);
    if (!['todo_ready', 'rejected', 'planned'].includes(doc.status)) {
      throw new Error(`${milestone} 当前状态为 ${doc.statusRaw}，不能 claim（需 待实现/已打回）`);
    }
    const attempts = (doc.body.match(/^\s*-\s.*\*\*(?:通过|打回)\*\*/gm) ?? []).length;
    writeAtomic(abs, setTodoStatus(readTextRequired(abs), 'implementing'));
    logEvent(this.root, { role, tool: 'milestone_claim', repo: repoId, milestone, ok: true });
    this.notifyEvent({
      from: role,
      repo: repoId,
      to: [{ role: 'plan', repo: repoId }],
      kind: 'event',
      subject: `${repoId}/${milestone} 开始实现`,
      refs: { repo: repoId, milestone },
      key: `${repoId}:${milestone}:claim:${attempts}`,
    });
    return this.milestone(repoId, milestone);
  }

  complete(repoId: string, milestone: string, role: Role): MilestoneState {
    return withLock(this.root, `todo-${repoId}-${milestone}`, () =>
      this.completeUnlocked(repoId, milestone, role),
    );
  }

  private completeUnlocked(repoId: string, milestone: string, role: Role): MilestoneState {
    this.assertActiveRepo(repoId);
    this.assertNotBlocked(role, repoId);
    const { abs, doc } = this.requireTodo(repoId, milestone);
    if (doc.status !== 'implementing') {
      throw new Error(`${milestone} 当前状态为 ${doc.statusRaw}，不能 complete（需 实现中）`);
    }
    const evidence = parseEvidence(doc);
    if (evidence.length === 0) {
      throw new Error(`${milestone} 没有任何证据；先调用 evidence_run 运行测试/构建`);
    }
    writeAtomic(abs, setTodoStatus(readTextRequired(abs), 'review'));
    logEvent(this.root, { role, tool: 'milestone_complete', repo: repoId, milestone, ok: true });
    this.notifyEvent({
      from: role,
      repo: repoId,
      to: [{ role: 'plan', repo: repoId }],
      kind: 'event',
      subject: `${repoId}/${milestone} 实现完成，待验收`,
      body: `证据 ${evidence.length} 条；最后一条 ${evidence[evidence.length - 1]?.command || '-'}`,
      refs: {
        repo: repoId,
        milestone,
        evidence_id: evidence[evidence.length - 1]?.id || '',
      },
      key: `${repoId}:${milestone}:complete:${evidence.length}`,
    });
    return this.milestone(repoId, milestone);
  }

  milestone(repoId: string, milestone: string): MilestoneState {
    const st = this.repoState(repoId);
    const m = st.milestones.find((x) => x.id === milestone);
    if (!m) throw new Error(`${repoId} 没有里程碑 ${milestone}`);
    return m;
  }

  accept(
    repoId: string,
    milestone: string,
    role: Role,
    opts: { note?: string; force?: boolean } = {},
  ): MilestoneState {
    return withLock(this.root, `todo-${repoId}-${milestone}`, () =>
      this.acceptUnlocked(repoId, milestone, role, opts),
    );
  }

  private acceptUnlocked(
    repoId: string,
    milestone: string,
    role: Role,
    opts: { note?: string; force?: boolean } = {},
  ): MilestoneState {
    this.assertActiveRepo(repoId);
    if (role !== 'plan' && role !== 'main') {
      throw new Error(`只有 PLAN/主 agent 能验收；当前角色 ${role}`);
    }
    this.assertNotBlocked(role, repoId);
    const { abs, doc } = this.requireTodo(repoId, milestone);
    if (doc.status !== 'review' && !opts.force) {
      throw new Error(
        `${milestone} 当前状态为 ${doc.statusRaw}，需先 milestone_complete 进入待验收`,
      );
    }
    const evidence = parseEvidence(doc);
    const latest = evidence[evidence.length - 1];
    if (!opts.force) {
      if (!latest) throw new Error(`${milestone} 没有证据；拒绝验收`);
      if (latest.exitCode !== 0) {
        throw new Error(`${milestone} 最新证据 exit=${latest.exitCode}；拒绝验收`);
      }
    }

    const ref = this.repoRef(repoId);
    const gi = gitInfo(ref.abs);
    const currentHash = workingTreeHash(ref.abs);
    let note = opts.note || '';
    if (latest?.tree && latest.tree !== workingTreeOid(ref.abs)) {
      note += '\n⚠️ 最新证据之后工作区又发生了变化，建议重新跑 evidence_run。';
    }

    let text = readTextRequired(abs);
    text = setTodoStatus(text, 'accepted');
    text = setTodoSha(text, gi.head || 'working-tree');
    text = appendReview(text, {
      at: isoNow(),
      action: 'accept',
      by: role,
      note: note.trim(),
      head: gi.shortHead,
      dirty: gi.dirty,
      evidence: latest ? `${latest.command} (exit ${latest.exitCode})` : '(force)',
    });
    writeAtomic(abs, text);
    logEvent(this.root, {
      role,
      tool: 'milestone_accept',
      repo: repoId,
      milestone,
      ok: true,
      detail: { head: gi.head, tree_hash: currentHash, evidence: evidence.length },
    });
    this.notifyEvent({
      from: role,
      repo: repoId,
      to: [{ role: 'main' }, { role: 'user' }],
      kind: 'event',
      subject: `${repoId}/${milestone} 已验收，待 review/提交`,
      body: `受验 SHA ${gi.head || 'working-tree'}；证据 ${evidence.length} 条。`,
      refs: { repo: repoId, milestone, sha: gi.head || '' },
      key: `${repoId}:${milestone}:accept:${gi.head || 'wt'}`,
    });
    return this.milestone(repoId, milestone);
  }

  reject(repoId: string, milestone: string, role: Role, reason: string): MilestoneState {
    return withLock(this.root, `todo-${repoId}-${milestone}`, () =>
      this.rejectUnlocked(repoId, milestone, role, reason),
    );
  }

  private rejectUnlocked(
    repoId: string,
    milestone: string,
    role: Role,
    reason: string,
  ): MilestoneState {
    this.assertActiveRepo(repoId);
    if (role !== 'plan' && role !== 'main') {
      throw new Error(`只有 PLAN/主 agent 能打回；当前角色 ${role}`);
    }
    if (!reason.trim()) throw new Error('打回必须写原因');
    this.assertNotBlocked(role, repoId);
    const { abs, doc } = this.requireTodo(repoId, milestone);
    if (doc.status !== 'review') {
      throw new Error(`${milestone} 当前状态为 ${doc.statusRaw}，只有待验收的 M 可以打回`);
    }
    const gi = gitInfo(this.repoRef(repoId).abs);
    let text = readTextRequired(abs);
    text = setTodoStatus(text, 'rejected');
    text = appendReview(text, {
      at: isoNow(),
      action: 'reject',
      by: role,
      note: reason,
      head: gi.shortHead,
      dirty: gi.dirty,
      evidence: '',
    });
    writeAtomic(abs, text);
    logEvent(this.root, {
      role,
      tool: 'milestone_reject',
      repo: repoId,
      milestone,
      ok: true,
      detail: { reason },
    });
    this.notifyEvent({
      from: role,
      repo: repoId,
      to: [{ role: 'todo', repo: repoId }],
      kind: 'event',
      subject: `${repoId}/${milestone} 被打回`,
      body: reason,
      refs: { repo: repoId, milestone, reason },
      key: `${repoId}:${milestone}:reject:${Date.now()}`,
    });
    return this.milestone(repoId, milestone);
  }

  /* ---------------------------- evidence ----------------------------- */

  async runEvidence(input: {
    repoId: string;
    milestone: string;
    command: string;
    role: Role;
    cwd?: string;
    timeoutMs?: number;
  }): Promise<{
    id: string;
    exitCode: number;
    head: string;
    tree: string;
    dirty: boolean;
    output: string;
    todoFile: string;
  }> {
    const { repoId, milestone, command, role } = input;
    const ref = this.repoRef(repoId);
    this.assertActiveRepo(repoId);
    this.requireTodo(repoId, milestone); // validate early
    const cwd = input.cwd ? path.resolve(ref.abs, input.cwd) : ref.abs;
    if (!within(ref.abs, cwd)) throw new Error(`evidence cwd 必须在仓库内: ${cwd}`);

    const started = Date.now();
    const result = await runCommand(command, cwd, input.timeoutMs ?? 900_000);
    const gi = gitInfo(ref.abs);
    const tree = workingTreeOid(ref.abs);

    const recorded = withLock(this.root, `todo-${repoId}-${milestone}`, () => {
      const { abs, doc } = this.requireTodo(repoId, milestone);
      const list = parseEvidence(doc);
      const id = `E${list.length + 1}`;
      const at = isoNow();
      const fullOutput = [
        `$ ${command}`,
        `exit: ${result.code}`,
        `head: ${gi.head}`,
        `tree: ${tree}`,
        `dirty: ${gi.dirty}`,
        '',
        '--- stdout ---',
        result.stdout,
        '--- stderr ---',
        result.stderr,
      ].join('\n');

      const dir = path.join(evidenceDir(this.root), repoId, milestone);
      ensureDir(dir);
      writeAtomic(path.join(dir, `${id}-${Date.now()}.log`), fullOutput);

      const tail = truncate([result.stdout, result.stderr].filter(Boolean).join('\n'), 4000);
      const text = appendEvidenceSection(readTextRequired(abs), {
        id,
        at,
        command,
        exitCode: result.code,
        head: gi.shortHead,
        tree,
        dirty: gi.dirty,
        output: tail,
      });
      writeAtomic(abs, text);
      return { id, output: tail, todoFile: path.relative(this.root, abs) };
    });

    logEvent(this.root, {
      role,
      tool: 'evidence_run',
      repo: repoId,
      milestone,
      ok: result.code === 0,
      detail: { command, exit: result.code, ms: Date.now() - started },
    });

    return {
      id: recorded.id,
      exitCode: result.code,
      head: gi.shortHead,
      tree,
      dirty: gi.dirty,
      output: recorded.output,
      todoFile: recorded.todoFile,
    };
  }

  /* --------------------------- scope check --------------------------- */

  scopeCheck(
    repoId: string,
    milestone?: string,
    role: Role = 'todo',
    opts: { enforceAcl?: boolean } = {},
  ) {
    const enforceAcl = opts.enforceAcl ?? role === 'todo';
    const ref = this.repoRef(repoId);
    const changed = allChangedFiles(ref.abs);
    const st = this.repoState(repoId);
    const m = milestone ? st.milestones.find((x) => x.id === milestone) : st.currentMilestone;
    const todo = m ? parseTodo(path.join(ref.abs, `TODO-${m.id}.md`)) : null;
    const allowed = todo?.allowedFiles || [];
    const violations: { file: string; reason: string }[] = [];
    const outOfScope: string[] = [];
    const warnings: string[] = [];

    const repos = this.repoRefs().map((r) => ({ id: r.id, abs: r.abs }));
    if (enforceAcl) {
      for (const f of changed) {
        if (isWorkflowManaged(f)) continue; // workflow tools maintain these by design
        const abs = path.join(ref.abs, f);
        const acl = checkAcl(role, abs, this.root, repoId, ref.abs, repos);
        if (!acl.allowed) violations.push({ file: f, reason: acl.reason });
      }
    }

    if (allowed.length > 0) {
      for (const f of changed) {
        if (isWorkflowManaged(f)) continue;
        const ok = allowed.some((a) => matchGlob(f, a.replace(/^\.\//, '')));
        if (!ok) {
          outOfScope.push(f);
          warnings.push(`${f} 不在 TODO 声明的「影响文件」里`);
        }
      }
    } else if (changed.length > 0) {
      warnings.push('TODO 未声明可修改文件清单，只能按角色 ACL 判断');
    }

    return {
      repo: repoId,
      milestone: m?.id,
      changed: changed.filter((f) => !isWorkflowManaged(f)),
      allowedFiles: allowed,
      outOfScope,
      violations,
      warnings,
      pass: violations.length === 0 && !(role === 'todo' && outOfScope.length > 0),
    };
  }

  /* ----------------------------- commit ------------------------------ */

  /** The milestone being committed: explicit, accepted-but-uncommitted, or current. */
  private milestoneForCommit(repoId: string, explicit?: string): MilestoneState | null {
    const st = this.repoState(repoId);
    if (explicit) {
      const found = st.milestones.find((m) => m.id === explicit);
      if (!found) throw new Error(`${repoId} 没有里程碑 ${explicit}`);
      return found;
    }
    const accepted = st.milestones.filter((m) => m.status === 'accepted');
    if (accepted.length) return accepted[accepted.length - 1];
    return st.currentMilestone;
  }

  private assertRootCommitFiles(files: string[]): void {
    const gi = gitInfo(this.root);
    if (!gi.available) throw new Error(`伞仓不是 git 仓库: ${this.root}`);
    if (files.length === 0) throw new Error('伞仓没有可提交的改动');
    const bad = files.filter((f) => !isRootCommitAllowed(f));
    if (bad.length) {
      throw new Error(
        '伞仓提交包含不允许的路径（只允许 CLAUDE.md、docs/**、milestone/**、\n' +
          '.workflow/program.yaml、.workflow/.gitignore）:\n' +
          bad.map((f) => `- ${f}`).join('\n'),
      );
    }
    const links = gitlinkPaths(this.root);
    // Untracked nested repositories are not gitlinks yet; `git add` would turn
    // them into one (or refuse), so reject the directory by its `.git` entry.
    const nested = files.filter((f) => exists(path.join(this.root, f, '.git')));
    if (links.length || nested.length) {
      const bad = [...new Set([...links, ...nested])];
      throw new Error(
        `伞仓包含 gitlink/嵌套仓库，拒绝提交:\n${bad.map((f) => `- ${f}`).join('\n')}`,
      );
    }
  }

  requestCommit(input: { repoId: string; message: string; role: Role; milestone?: string }): {
    approval: Approval;
    diffStat: string;
    files: string[];
  } {
    if (input.repoId === ROOT_REPO_ID) {
      if (input.role !== 'main' && input.role !== 'user') {
        throw new Error(`只有 main/user 能提交伞仓；当前角色 ${input.role}`);
      }
      const gi = gitInfo(this.root);
      if (!gi.available) throw new Error(`伞仓不是 git 仓库: ${this.root}`);
      const files = allChangedFiles(this.root);
      if (files.length === 0) throw new Error('伞仓没有可提交的改动');
      this.assertRootCommitFiles(files);
      const stage = stageAll(this.root);
      if (!stage.ok) throw new Error(`git add 失败: ${stage.err}`);
      // Re-check after staging: an untracked nested repository only becomes a
      // gitlink in the index at this point.
      this.assertRootCommitFiles(allChangedFiles(this.root));
      const a = createApproval(this.root, {
        repo: ROOT_REPO_ID,
        tree_hash: workingTreeHash(this.root),
        staged_hash: stagedTreeHash(this.root),
        message: input.message,
        files,
      });
      supersedeApprovals(this.root, ROOT_REPO_ID, a.id);
      logEvent(this.root, {
        role: input.role,
        tool: 'commit_request',
        repo: ROOT_REPO_ID,
        ok: true,
        detail: { approval: a.id, files: files.length, root: true },
      });
      this.notifyEvent({
        from: input.role,
        repo: ROOT_REPO_ID,
        to: [{ role: 'user' }],
        kind: 'approval_request',
        subject: `root（伞仓文档）请求提交：${input.message}`,
        body: `${files.length} 个文件\n${diffStat(this.root)}`,
        refs: { repo: ROOT_REPO_ID, approval_id: a.id, files },
        key: `${ROOT_REPO_ID}:commit-request:${a.id}`,
      });
      return { approval: a, diffStat: diffStat(this.root), files };
    }

    const ref = this.repoRef(input.repoId);
    const files = allChangedFiles(ref.abs);
    if (files.length === 0) throw new Error('没有可提交的改动');
    const milestone = this.milestoneForCommit(input.repoId, input.milestone);
    const scope = this.scopeCheck(input.repoId, milestone?.id, input.role, {
      enforceAcl: false,
    });
    assertCommitScope(scope, input.role);
    const stage = stageAll(ref.abs);
    if (!stage.ok) throw new Error(`git add 失败: ${stage.err}`);
    const a = createApproval(this.root, {
      repo: input.repoId,
      milestone: milestone?.id,
      tree_hash: workingTreeHash(ref.abs),
      staged_hash: stagedTreeHash(ref.abs),
      message: input.message,
      files,
    });
    supersedeApprovals(this.root, input.repoId, a.id);
    logEvent(this.root, {
      role: input.role,
      tool: 'commit_request',
      repo: input.repoId,
      ok: true,
      detail: { approval: a.id, files: files.length },
    });
    this.notifyEvent({
      from: input.role,
      repo: input.repoId,
      to: [{ role: 'user' }],
      kind: 'approval_request',
      subject: `${input.repoId} 请求提交：${input.message}`,
      body: `${files.length} 个文件\n${diffStat(ref.abs)}`,
      refs: {
        repo: input.repoId,
        approval_id: a.id,
        files,
      },
      key: `${input.repoId}:commit-request:${a.id}`,
    });
    return { approval: a, diffStat: diffStat(ref.abs), files };
  }

  approve(id: string, by = 'user'): Approval {
    const a = readApproval(this.root, id);
    if (!a) throw new Error(`审批 ${id} 不存在`);
    if (a.used_at) throw new Error(`审批 ${id} 已使用`);
    const current = workingTreeHash(this.repoRef(a.repo).abs);
    if (current !== a.tree_hash) {
      throw new Error(
        `工作区内容已变化（审批时 ${a.tree_hash}，现在 ${current}）；请重新 commit_request`,
      );
    }
    a.approved_at = isoNow();
    a.approved_by = by;
    writeApproval(this.root, a);
    logEvent(this.root, {
      role: 'user',
      tool: 'approve',
      repo: a.repo,
      ok: true,
      detail: { approval: id },
    });
    // Approving is how the human handles the notification; clear it from the inbox.
    try {
      this.msgs.ackByRef({ role: 'user' }, 'approval_id', id);
    } catch {
      /* the approval is recorded; notification cleanup is best-effort */
    }
    return a;
  }

  commitApproved(input: { repoId: string; approvalId: string; role: Role; dryRun?: boolean }) {
    const ref = this.repoRef(input.repoId);
    const a = readApproval(this.root, input.approvalId);
    if (!a) throw new Error(`审批 ${input.approvalId} 不存在`);
    if (a.repo !== input.repoId) throw new Error(`审批属于 ${a.repo}，不是 ${input.repoId}`);
    if (!a.approved_at)
      throw new Error(`审批 ${a.id} 尚未由用户批准（mpt-workflow approve ${a.id}）`);
    if (a.used_at) throw new Error(`审批 ${a.id} 已在 ${a.used_at} 使用`);

    const hash = workingTreeHash(ref.abs);
    if (hash !== a.tree_hash) {
      throw new Error(
        `工作区内容已变化（审批时 ${a.tree_hash}，现在 ${hash}）；请重新 commit_request 并批准`,
      );
    }

    let files: string[];
    if (input.repoId === ROOT_REPO_ID) {
      if (input.role !== 'main' && input.role !== 'user') {
        throw new Error(`只有 main/user 能提交伞仓；当前角色 ${input.role}`);
      }
      files = allChangedFiles(this.root);
      this.assertRootCommitFiles(files);
    } else {
      const scope = this.scopeCheck(
        input.repoId,
        a.milestone ?? this.milestoneForCommit(input.repoId)?.id,
        input.role,
        { enforceAcl: false },
      );
      assertCommitScope(scope, input.role);
      files = allChangedFiles(ref.abs);
    }
    if (input.dryRun) {
      return { dryRun: true, files, message: a.message, tree_hash: hash };
    }

    const stage = stageAll(ref.abs);
    if (!stage.ok) throw new Error(`git add 失败: ${stage.err}`);
    if (input.repoId === ROOT_REPO_ID) {
      this.assertRootCommitFiles(allChangedFiles(this.root));
    }
    if (a.staged_hash) {
      const staged = stagedTreeHash(ref.abs);
      if (staged !== a.staged_hash) {
        throw new Error(
          `暂存区内容已变化（审批时 ${a.staged_hash}，现在 ${staged}）；请重新 commit_request 并批准`,
        );
      }
    }
    const res = gitCommit(ref.abs, a.message);
    if (!res.ok) throw new Error(`git commit 失败: ${res.err || res.out}`);
    const head = gitInfo(ref.abs).head;

    a.used_at = isoNow();
    writeApproval(this.root, a);
    logEvent(this.root, {
      role: input.role,
      tool: 'commit',
      repo: input.repoId,
      ok: true,
      detail: { approval: a.id, head, files: files.length },
    });
    this.notifyEvent({
      from: input.role,
      repo: input.repoId,
      to: [{ role: 'main' }, { role: 'user' }],
      kind: 'event',
      subject: `${input.repoId} 已提交 @ ${head.slice(0, 8)}`,
      body: a.message,
      refs: { repo: input.repoId, commit: head, sha: head, approval_id: a.id },
      key: `${input.repoId}:commit:${head}`,
    });
    return { ok: true, head, files, message: a.message };
  }

  approvals(): Approval[] {
    return listApprovals(this.root);
  }

  /* ----------------------------- doctor ------------------------------ */

  doctor(): DoctorFinding[] {
    const out: DoctorFinding[] = [];
    const push = (f: DoctorFinding) => out.push(f);

    // config
    if (!exists(path.join(this.root, '.workflow/program.yaml'))) {
      push({ level: 'FAIL', code: 'config', message: '缺少 .workflow/program.yaml' });
    }
    const schemaVersion = this.cfg.schema_version ?? 1;
    if (schemaVersion > 1) {
      push({
        level: 'WARN',
        code: 'schema-version',
        message: `program.yaml schema_version=${schemaVersion} 高于当前支持（1）`,
        hint: '升级 mpt-workflow；旧版本不会自动降级配置',
      });
    }
    if (this.cfg.repos.some((r) => r.id === ROOT_REPO_ID)) {
      push({
        level: 'FAIL',
        code: 'reserved-repo',
        message: `repos 不能使用保留 id '${ROOT_REPO_ID}'`,
        hint: `把该仓库改名为其他 id；'${ROOT_REPO_ID}' 专指伞仓文档`,
      });
    }
    const legacyLease = path.join(runtimeDir(this.root), 'role.json');
    if (exists(legacyLease)) {
      push({
        level: 'WARN',
        code: 'legacy-lease',
        message: '存在旧的全局角色文件 runtime/role.json',
        hint: '1.0 起角色按会话存储；可删除该文件，改用 bootstrap 或 WF_ROLE/WF_REPO',
      });
    }

    const active = this.cfg.active_repo;
    if (active && !this.cfg.repos.some((r) => r.id === active)) {
      push({
        level: 'FAIL',
        code: 'active-repo',
        message: `active_repo=${active} 不在 repos 列表`,
      });
    }
    if (!active) {
      push({
        level: 'WARN',
        code: 'active-repo',
        message: '没有激活的仓库，所有实现工作都会停滞',
        hint: 'mpt-workflow activate <repo>',
      });
    }

    for (const ref of this.repoRefs()) {
      if (!exists(ref.abs)) {
        push({
          level: 'FAIL',
          code: 'repo-missing',
          repo: ref.id,
          message: `仓库目录不存在: ${ref.abs}`,
        });
        continue;
      }
      const conf = this.repoConfig(ref.id);
      const gi = gitInfo(ref.abs);
      if (!gi.available) {
        push({
          level: 'FAIL',
          code: 'git',
          repo: ref.id,
          message: '不是 git 仓库或无法读取 HEAD',
          hint: gi.error,
        });
        continue;
      }
      if (conf.branch && gi.branch && conf.branch !== gi.branch) {
        push({
          level: 'WARN',
          code: 'branch',
          repo: ref.id,
          message: `配置分支 ${conf.branch}，当前 ${gi.branch}`,
        });
      }
      if (gi.dirty) {
        const lock = gi.changed.filter((f) => f.endsWith('Cargo.lock'));
        push({
          level: lock.length ? 'FAIL' : 'WARN',
          code: 'dirty',
          repo: ref.id,
          message: `工作区有未提交改动 ${gi.changed.length + gi.untracked.length} 个`,
          hint: gi.changed.concat(gi.untracked).slice(0, 8).join(', '),
        });
        if (lock.length) {
          push({
            level: 'FAIL',
            code: 'cargo-lock',
            repo: ref.id,
            message: 'Cargo.lock 被修改；依赖版本漂移会破坏跨仓契约',
            hint: 'git diff Cargo.lock 确认后回滚或显式锁定',
          });
        }
      }

      if (!exists(path.join(ref.abs, 'PLAN.md'))) {
        push({ level: 'WARN', code: 'plan', repo: ref.id, message: '缺少 PLAN.md' });
      }
      if (!exists(questionsFile(ref.abs))) {
        push({
          level: 'WARN',
          code: 'questions',
          repo: ref.id,
          message: '缺少 docs/agent-questions.md（CLAUDE.md 要求 agent 写这里）',
          hint: 'mpt-workflow init --adopt 会创建',
        });
      }
      if (exists(path.join(ref.abs, 'rust-toolchain.toml'))) {
        const tc = readText(path.join(ref.abs, 'rust-toolchain.toml'));
        const ch = /channel\s*=\s*"([^"]+)"/.exec(tc)?.[1];
        if (ch?.includes('nightly')) {
          push({ level: 'OK', code: 'toolchain', repo: ref.id, message: `rust-toolchain: ${ch}` });
        }
      }
      if (exists(path.join(ref.abs, 'Cargo.toml')) && !exists(path.join(ref.abs, 'Cargo.lock'))) {
        push({
          level: 'WARN',
          code: 'cargo-lock-missing',
          repo: ref.id,
          message: 'Cargo.toml 存在但没有 Cargo.lock',
        });
      }
      // questions parse health
      const qs = exists(questionsFile(ref.abs))
        ? parseQuestionsFile(questionsFile(ref.abs), ref.id)
        : [];
      const openBlocking = qs.filter((q) => q.blocking && q.status === 'open');
      if (openBlocking.length) {
        push({
          level: 'FAIL',
          code: 'blocking-question',
          repo: ref.id,
          message: `${openBlocking.length} 个阻塞问题未回答: ${openBlocking.map((q) => q.id).join(', ')}`,
        });
      }
      const st = this.repoState(ref.id);
      if (st.milestones.length === 0) {
        push({
          level: 'WARN',
          code: 'milestones',
          repo: ref.id,
          message: '没有 M（PLAN 表未解析到，也没有 TODO）',
        });
      }
      const acceptedDirty = st.milestones.filter((m) => m.status === 'accepted');
      if (acceptedDirty.length && gi.dirty) {
        push({
          level: 'WARN',
          code: 'accepted-uncommitted',
          repo: ref.id,
          message: `${acceptedDirty.map((m) => m.id).join(', ')} 已验收但工作区未提交`,
        });
      }
    }

    for (const a of this.approvals().filter((x) => !x.used_at)) {
      push({
        level: a.approved_at ? 'WARN' : 'OK',
        code: 'approval',
        repo: a.repo,
        message: a.approved_at ? `审批 ${a.id} 已批准但未使用` : `审批 ${a.id} 等待用户批准`,
        hint: `mpt-workflow approve ${a.id}`,
      });
    }

    const runtimeBytes = dirSize(runtimeDir(this.root));
    push(
      runtimeBytes > 100 * 1024 * 1024
        ? {
            level: 'WARN',
            code: 'runtime-size',
            message: `runtime 已占用 ${formatBytes(runtimeBytes)}`,
            hint: 'mpt-workflow gc --apply 清理已处理的旧消息/审批',
          }
        : {
            level: 'OK',
            code: 'runtime-size',
            message: `runtime ${formatBytes(runtimeBytes)}`,
          },
    );

    const stale = staleCliPaths(
      this.root,
      this.repoRefs().map((r) => r.abs),
    );
    if (stale.length) {
      push({
        level: 'WARN',
        code: 'stale-cli',
        message: `配置指向不存在的 CLI: ${stale.join(', ')}`,
        hint: '重新运行 mpt-workflow init --install-hooks，或先 npm run build',
      });
    }

    if (!out.some((f) => f.level === 'FAIL')) {
      push({ level: 'OK', code: 'overall', message: '没有阻断性问题' });
    }
    return out;
  }
}

/* ------------------------------ helpers ------------------------------ */

/** Map a question's from/to label (PLAN, TODO@repo, system, …) to a Role. */
function nextActor(label: string): Role {
  const [role, repo] = String(label).split('@');
  const actor = actorFromRole(role, repo);
  return actor.role === 'system' ? 'main' : actor.role;
}

export const ROOT_COMMIT_ALLOW = [
  'CLAUDE.md',
  'docs/**',
  'milestone/**',
  '.workflow/program.yaml',
  '.workflow/.gitignore',
];

export function isRootCommitAllowed(file: string): boolean {
  return ROOT_COMMIT_ALLOW.some((g) => matchGlob(file, g));
}

/**
 * Files the workflow tools themselves maintain. They are excluded from scope
 * checks and from the pre-commit ACL backstop: the TODO status line and the
 * questions board change as a normal part of the workflow.
 */
export function isMachineManagedFile(file: string): boolean {
  return /^TODO-M\d+\.md$/.test(file) || file === 'docs/agent-questions.md';
}

/** Machine-managed files plus the plan itself (derived-scope checks only). */
export function isWorkflowManaged(file: string): boolean {
  return file === 'PLAN.md' || isMachineManagedFile(file);
}

/**
 * Find absolute CLI paths in generated MCP/hook config that no longer exist.
 * This catches an evicted npx cache, a moved checkout, or a missing build.
 */
function staleCliPaths(root: string, repoDirs: string[]): string[] {
  const targets = ['.mcp.json', '.claude/settings.json', '.git/hooks/pre-commit'];
  const missing = new Set<string>();
  for (const dir of [root, ...repoDirs]) {
    for (const rel of targets) {
      const p = path.join(dir, rel);
      if (!exists(p)) continue;
      const text = readText(p);
      for (const m of text.matchAll(/["']?(\/[^"'\s]+?cli\.js)["']?/g)) {
        if (!exists(m[1])) missing.add(m[1]);
      }
    }
  }
  return [...missing];
}

function assertCommitScope(
  scope: {
    violations: { file: string; reason: string }[];
    outOfScope: string[];
  },
  role: Role,
): void {
  // The TODO file list describes implementation scope. A plan/main commit that
  // adds planning docs is not scope creep, so only enforce it for the implementer.
  const outOfScope = role === 'todo' ? scope.outOfScope : [];
  if (!scope.violations.length && !outOfScope.length) return;
  const lines = [
    ...scope.violations.map((v) => `${v.file}: ${v.reason}`),
    ...outOfScope.map((f) => `${f}: 不在当前 TODO 的「影响文件」清单内`),
  ];
  throw new Error(
    'scope 检查未通过，不能提交:\n' +
      lines.map((l) => `- ${l}`).join('\n') +
      '\n把相关文件加入 TODO 的「影响文件」，或撤销这些改动后重新 commit_request。',
  );
}

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // `detached` gives the shell its own process group, so a timeout can kill
    // the whole tree instead of leaving orphaned test/build processes behind.
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const maxBytes = 64 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let timedOut = false;

    const collect = (chunk: Buffer, into: 'out' | 'err') => {
      if (bytes >= maxBytes) return;
      bytes += chunk.length;
      if (into === 'out') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout?.on('data', (chunk: Buffer) => collect(chunk, 'out'));
    child.stderr?.on('data', (chunk: Buffer) => collect(chunk, 'err'));

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) stderr += `\n[timeout after ${timeoutMs}ms]`;
      resolve({
        code: timedOut ? 124 : typeof code === 'number' ? code : 1,
        stdout,
        stderr,
      });
    });
  });
}

function appendReview(
  text: string,
  r: {
    at: string;
    action: 'accept' | 'reject';
    by: string;
    note: string;
    head: string;
    dirty: boolean;
    evidence: string;
  },
): string {
  const header = '## 验收记录';
  const line = [
    `- ${r.at} **${r.action === 'accept' ? '通过' : '打回'}** by ${r.by} — head ${r.head}${r.dirty ? ' (dirty)' : ''}`,
    r.evidence ? `  - 依据: ${r.evidence}` : '',
    r.note ? `  - 说明: ${r.note.replace(/\n/g, ' ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const withHeader = /^##\s+验收记录/m.test(text)
    ? text
    : text.replace(/\s*$/, '\n\n') + `${header}\n`;
  return appendToSection(withHeader, /验收记录/, line);
}

export { statusLabel };
