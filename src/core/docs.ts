import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, exists, readText, writeAtomic } from './fsutil.js';
import {
  appendToSection,
  fenceEnd,
  fenceStart,
  inlineCode,
  outsideFences,
  section,
  splitFrontMatter,
} from './markdown.js';
import type { MilestoneStatus, TodoDoc } from './types.js';

const STATUS_MAP: Record<string, MilestoneStatus> = {
  草稿: 'planned',
  待实现: 'todo_ready',
  实现中: 'implementing',
  待验收: 'review',
  已验收: 'accepted',
  已打回: 'rejected',
  已提交: 'committed',
  planned: 'planned',
  todo_ready: 'todo_ready',
  implementing: 'implementing',
  review: 'review',
  accepted: 'accepted',
  rejected: 'rejected',
  committed: 'committed',
};

const STATUS_LABEL: Record<MilestoneStatus, string> = {
  planned: '草稿',
  todo_ready: '待实现',
  implementing: '实现中',
  review: '待验收',
  accepted: '已验收',
  rejected: '已打回',
  committed: '已提交',
};

export function parseStatus(raw: string | undefined): MilestoneStatus {
  if (!raw) return 'planned';
  const s = raw.trim();
  // Hand-written status lines often carry emphasis and parenthetical notes,
  // e.g. "**已验收（文档评审通过；提交后回填受验 SHA）**". Match the label inside.
  const labels: [string, MilestoneStatus][] = [
    ['已验收', 'accepted'],
    ['已打回', 'rejected'],
    ['已提交', 'committed'],
    ['待验收', 'review'],
    ['实现中', 'implementing'],
    ['待实现', 'todo_ready'],
    ['草稿', 'planned'],
    ['accepted', 'accepted'],
    ['rejected', 'rejected'],
    ['committed', 'committed'],
    ['review', 'review'],
    ['implementing', 'implementing'],
    ['todo_ready', 'todo_ready'],
    ['planned', 'planned'],
  ];
  for (const [k, v] of labels) if (s.includes(k)) return v;
  return STATUS_MAP[s] || 'planned';
}

export function statusLabel(s: MilestoneStatus): string {
  return STATUS_LABEL[s];
}

export function listTodoFiles(repoAbs: string): string[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(repoAbs);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^TODO-M\d+\.md$/.test(n))
    .sort((a, b) => {
      const na = Number(/M(\d+)/.exec(a)?.[1] || 0);
      const nb = Number(/M(\d+)/.exec(b)?.[1] || 0);
      return na - nb;
    });
}

function parseFileList(raw: string): string[] {
  const text = raw.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map((x) => String(x).trim()).filter(Boolean);
    }
  } catch {
    /* fall back to comma/newline list */
  }
  return text
    .split(/[,\n]/)
    .map((s) =>
      s
        .trim()
        .replace(/^['"`]|['"`]$/g, '')
        .trim(),
    )
    .filter(Boolean);
}

function collectFilesUnder(body: string, marker: RegExp): string[] {
  const lines = body.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!marker.test(lines[i])) continue;
    out.push(...inlineCode(lines[i]));
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (/^#{1,6}\s+/.test(line)) break;
      if (/^-\s+\*\*/.test(line)) break; // next bold bullet
      if (line.trim() === '') continue;
      if (/^\s*[-*]\s+/.test(line) || /^\s+/.test(line)) {
        out.push(...inlineCode(line));
        continue;
      }
      break;
    }
  }
  return out;
}

function collectCheckboxes(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*-\s*\[\s?\]\s*(.+)$/.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}

export function parseTodo(fileAbs: string): TodoDoc | null {
  if (!exists(fileAbs)) return null;
  const raw = readText(fileAbs);
  const fm = splitFrontMatter(raw);
  const body = fm.body;

  const heading = /^#\s+TODO-(M\d+)\s*[:：]?\s*(.*)$/m.exec(body);
  const fileId = /TODO-(M\d+)\.md$/.exec(fileAbs)?.[1];
  const id = String(fm.data.id || heading?.[1] || fileId || '').trim();
  if (!id) return null;

  const title = heading?.[2]?.trim() || String(fm.data.title || id);

  const statusFromFm = fm.data.status ? String(fm.data.status) : undefined;
  const statusFromLine = /状态[：:]\s*([^\n　|]*)/.exec(body)?.[1]?.trim();
  const statusRaw = statusFromFm || statusFromLine || '草稿';

  const shaFromFm = fm.data.sha ? String(fm.data.sha) : undefined;
  // Prefer an explicit hex SHA anywhere on a "受验" line over placeholder text.
  const shaCandidates = [
    ...[...body.matchAll(/受验[^\n]*?`([0-9a-f]{7,40})`/g)].map((m) => m[1]),
    ...[...body.matchAll(/受验\s*SHA[：:]\s*([0-9a-f]{7,40})\b/gi)].map((m) => m[1]),
  ];
  const sha = shaFromFm || shaCandidates[shaCandidates.length - 1];

  const planRef =
    (fm.data.plan ? String(fm.data.plan) : undefined) ||
    /对应\s*PLAN[：:]\s*([^\n　|]+)/.exec(body)?.[1]?.trim();

  const phase =
    (fm.data.phase ? String(fm.data.phase) : undefined) ||
    /程序阶段[：:]\s*`?([Pp]\d+)`?/.exec(body)?.[1];

  const allowed = new Set<string>();
  for (const f of collectFilesUnder(body, /\*\*影响文件\*\*/)) allowed.add(f);
  for (const f of collectFilesUnder(body, /\*\*允许的既有文件改动\*\*/)) allowed.add(f);
  for (const c of collectFilesUnder(body, /\*\*改什么\*\*/)) {
    // "改什么" often lists plain prose; only keep path-looking inline code.
    if (c.includes('/') || /\.[a-z]{2,4}$/.test(c)) allowed.add(c);
  }
  if (Array.isArray(fm.data.files)) {
    for (const f of fm.data.files as unknown[]) if (typeof f === 'string') allowed.add(f);
  }
  // Robust marker: <!-- files: ["src/a.ts", "src/b.ts"] -->
  for (const m of body.matchAll(/<!--\s*files\s*:\s*([\s\S]*?)-->/gi)) {
    for (const f of parseFileList(m[1])) allowed.add(f);
  }

  const acceptanceText = section(body, /验收标准/) || '';
  const acceptance = collectCheckboxes(acceptanceText).length
    ? collectCheckboxes(acceptanceText)
    : collectCheckboxes(body);

  return {
    id,
    file: fileAbs,
    title,
    status: parseStatus(statusRaw),
    statusRaw,
    planRef,
    phase,
    sha,
    allowedFiles: [...allowed],
    acceptance,
    body,
    frontMatter: fm.data,
  };
}

export interface PlanDoc {
  file: string;
  title: string;
  version?: string;
  statusRaw?: string;
  phase?: string;
  milestoneIds: string[];
  milestoneTitles: Record<string, string>;
}

export function parsePlan(repoAbs: string): PlanDoc | null {
  const file = path.join(repoAbs, 'PLAN.md');
  if (!exists(file)) return null;
  const raw = readText(file);
  const fm = splitFrontMatter(raw);
  const body = fm.body;

  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || 'PLAN';
  const version = /版本[：:]\s*([^\s　|]+)/.exec(body)?.[1];
  const statusRaw = /状态[：:]\s*([^\s　|]+)/.exec(body)?.[1];
  const phase = /程序阶段[：:]\s*`?([Pp]\d+)`?/.exec(body)?.[1];

  const ids: string[] = [];
  const titles: Record<string, string> = {};
  for (const line of body.split('\n')) {
    // table rows: | M1 | name | ...
    const row = /^\|\s*(M\d+)\s*\|\s*([^|]+)\|/.exec(line);
    if (row) {
      if (!ids.includes(row[1])) ids.push(row[1]);
      titles[row[1]] = row[2].trim();
      continue;
    }
    // headings: ### M1 — name
    const head = /^#{2,4}\s+(M\d+)\s*[—\-–:：]?\s*(.*)$/.exec(line);
    if (head) {
      if (!ids.includes(head[1])) ids.push(head[1]);
      if (!titles[head[1]]) titles[head[1]] = head[2].trim();
    }
  }

  return {
    file,
    title,
    version,
    statusRaw,
    phase,
    milestoneIds: ids,
    milestoneTitles: titles,
  };
}

export interface EvidenceEntry {
  id: string;
  at: string;
  command: string;
  exitCode: number;
  head: string;
  tree: string;
  dirty: boolean;
  outputTail: string;
}

/** Tracked evidence log: one JSON object per line. */
export function evidenceFilePath(repoAbs: string, milestone: string): string {
  return path.join(repoAbs, 'docs', 'evidence', `${milestone}.jsonl`);
}

export function parseEvidenceFile(repoAbs: string, milestone: string): EvidenceEntry[] {
  const file = evidenceFilePath(repoAbs, milestone);
  if (!exists(file)) return [];
  const out: EvidenceEntry[] = [];
  for (const line of readText(file).split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      const id = String(r.id ?? '');
      if (!/^E\d+$/.test(id)) continue;
      out.push({
        id,
        at: String(r.at ?? ''),
        command: String(r.command ?? ''),
        exitCode: Number(r.exit ?? r.exitCode ?? -1),
        head: String(r.head ?? ''),
        tree: String(r.tree ?? ''),
        dirty: Boolean(r.dirty),
        outputTail: String(r.output ?? r.outputTail ?? ''),
      });
    } catch {
      /* ignore a corrupt line */
    }
  }
  return out;
}

export function appendEvidenceFile(
  repoAbs: string,
  milestone: string,
  entry: EvidenceEntry,
): string {
  const file = evidenceFilePath(repoAbs, milestone);
  ensureDir(path.dirname(file));
  const prev = exists(file) ? readText(file).replace(/\s*$/, '\n') : '';
  const line = JSON.stringify({
    id: entry.id,
    at: entry.at,
    command: entry.command,
    exit: entry.exitCode,
    head: entry.head,
    tree: entry.tree,
    dirty: entry.dirty,
    output: entry.outputTail,
  });
  writeAtomic(file, `${prev}${line}\n`);
  return file;
}

export function parseEvidence(todo: TodoDoc): EvidenceEntry[] {
  const text = section(todo.body, /证据记录/);
  if (!text) return [];
  const lines = text.split('\n');
  const outside = outsideFences(text);
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (outside[i] && /^###\s+/.test(lines[i])) {
      if (current) blocks.push(current);
      current = [lines[i]];
    } else if (current) {
      current.push(lines[i]);
    }
  }
  if (current) blocks.push(current);

  const out: EvidenceEntry[] = [];
  for (const block of blocks) {
    // Metadata lives before the fenced output; never parse the log itself for
    // `command`/`exit`/`head` — a test printing those strings must not count
    // as evidence.
    let fenceAt = block.findIndex((line) => fenceStart(line) !== null);
    if (fenceAt === -1) fenceAt = block.length;
    const header = block.slice(0, fenceAt).join('\n');
    const title = block[0].replace(/^###\s+/, '');
    const id = /^(E\d+)/.exec(title)?.[1] || '';
    const at = /—\s*([0-9T:.\-Z]+)/.exec(title)?.[1] || '';
    const cmd = /^-\s*command[：:]\s*`([^`]*)`\s*$/m.exec(header)?.[1] || '';
    const exit = Number(/^-\s*exit[：:]\s*(-?\d+)\s*$/m.exec(header)?.[1] ?? NaN);
    const head = /^-\s*head[：:]\s*`?([0-9a-f]{7,40})`?\s*$/m.exec(header)?.[1] || '';
    const tree = /^-\s*tree[：:]\s*`?([0-9a-f]{7,40})`?\s*$/m.exec(header)?.[1] || '';
    const dirty = /^-\s*dirty[：:]\s*(true|false)\s*$/m.exec(header)?.[1] === 'true';
    out.push({
      id,
      at,
      command: cmd,
      exitCode: Number.isFinite(exit) ? exit : -1,
      head,
      tree,
      dirty,
      outputTail: fencedBody(block, fenceAt),
    });
  }
  return out;
}

/** Body of the first fenced block starting at `at`, without the delimiters. */
function fencedBody(lines: string[], at: number): string {
  if (at >= lines.length) return '';
  const fence = fenceStart(lines[at]);
  if (!fence) return '';
  const body: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (fenceEnd(lines[i], fence)) break;
    body.push(lines[i]);
  }
  return body.join('\n').trim();
}

/** Rewrite the status marker in a TODO doc, preserving the existing style. */
export function setTodoStatus(text: string, status: MilestoneStatus): string {
  const label = STATUS_LABEL[status];
  const fm = splitFrontMatter(text);
  if (fm.hasFrontMatter) {
    const re = /^status:.*$/m;
    let body = text;
    if (re.test(body)) {
      body = body.replace(re, `status: ${status}`);
    } else {
      body = body.replace(/^---\n/, `---\nstatus: ${status}\n`);
    }
    return body;
  }
  if (/状态[：:]/.test(text)) {
    return text.replace(/(状态[：:]\s*)([^\n　|]+)/, `$1${label}`);
  }
  // No marker: add one right after the title.
  return text.replace(/^(#\s+TODO-M\d+[^\n]*\n)/, `$1\n> 状态：${label}\n`);
}

/** Tick `- [ ]` items inside `## 验收标准` when the milestone is accepted. */
export function markAcceptanceDone(text: string): string {
  const lines = text.split('\n');
  let active = false;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (h) {
      if (active && h[1].length <= level) active = false;
      if (/验收标准/.test(h[2])) {
        active = true;
        level = h[1].length;
      }
      continue;
    }
    if (active) lines[i] = lines[i].replace(/^(\s*[-*]\s*)\[\s?\]/, '$1[x]');
  }
  return lines.join('\n');
}

export function setTodoSha(text: string, sha: string): string {
  if (/受验\s*SHA[：:]/.test(text)) {
    return text.replace(/(受验\s*SHA[：:]\s*)([^\n　|]+)/, `$1${sha}`);
  }
  if (/^---$/m.test(text)) {
    return text.replace(/^---\n/, `---\nsha: ${sha}\n`);
  }
  return text.replace(/^(#\s+TODO-M\d+[^\n]*\n)/, `$1\n> 受验 SHA：${sha}\n`);
}

export function appendEvidenceSection(
  text: string,
  entry: {
    id: string;
    at: string;
    command: string;
    exitCode: number;
    head: string;
    tree: string;
    dirty: boolean;
    output: string;
  },
): string {
  const header = '## 证据记录';
  const output = entry.output.trim() || '(no output)';
  // A fence longer than any backtick run in the output keeps logs that contain
  // fenced Markdown (or `###` headings) from closing the block early.
  let longest = 0;
  for (const line of output.split('\n')) {
    const m = /^\s*(`{3,})/.exec(line);
    if (m) longest = Math.max(longest, m[1].length);
  }
  const fence = '`'.repeat(Math.max(3, longest + 1));
  // The command is agent-supplied: collapse CR/LF (and backticks) so it cannot
  // inject a second `- exit:`/`- head:` metadata line into the record.
  const commandLine = entry.command.replace(/[\r\n]+/g, ' ⏎ ').replace(/`/g, "'");
  const block = [
    `### ${entry.id} — ${entry.at}`,
    `- command: \`${commandLine}\``,
    `- exit: ${entry.exitCode}`,
    `- head: \`${entry.head}\``,
    `- tree: \`${entry.tree}\``,
    `- dirty: ${entry.dirty}`,
    '',
    `${fence}text`,
    output,
    fence,
    '',
  ].join('\n');

  if (text.includes(header)) {
    return appendToSection(text, /证据记录/, block);
  }
  const withHeader = text.replace(/\s*$/, '\n\n') + `${header}\n`;
  return appendToSection(withHeader, /证据记录/, block);
}
