import path from 'node:path';
import { ensureDir, exists, readText, readTextRequired, today, writeAtomic } from './fsutil.js';
import type { Question, QuestionStatus, Role } from './types.js';

const HEADING_RE = /^##\s+(Q-[\w-]+)\s*(?:\[([a-z_]+)\])?\s*to:\s*([^\s]+)\s*$/;
const FIELD_RE = /^-\s+([A-Za-z_]+)\s*[:：]\s*(.*)$/;

/** Shared agent-facing explanation of the question lifecycle. */
export const QUESTION_STATUS_HELP =
  '问题状态：open=待回答；answered=已回答（提问方必须应用结论并 close）；applied/closed=已处理；canceled=作废。只 answer 不 close，问题会一直未闭合。';

export function questionsFile(repoAbs: string): string {
  return path.join(repoAbs, 'docs', 'agent-questions.md');
}

function deriveStatus(
  explicit: string | undefined,
  answer: string,
  resolution: string,
): QuestionStatus {
  if (explicit) {
    const s = explicit.toLowerCase();
    if (['open', 'answered', 'applied', 'closed', 'canceled'].includes(s)) {
      return s as QuestionStatus;
    }
  }
  if (resolution.trim()) return 'applied';
  if (answer.trim()) return 'answered';
  return 'open';
}

export function parseQuestionsFile(fileAbs: string, repo?: string): Question[] {
  if (!exists(fileAbs)) return [];
  const text = readText(fileAbs);
  const lines = text.split('\n');
  const heads: { idx: number; id: string; status?: string; to: string }[] = [];
  lines.forEach((line, idx) => {
    const m = HEADING_RE.exec(line);
    if (m) heads.push({ idx, id: m[1], status: m[2], to: m[3] });
  });

  const out: Question[] = [];
  for (let h = 0; h < heads.length; h++) {
    const start = heads[h].idx;
    const end = h + 1 < heads.length ? heads[h + 1].idx : lines.length;
    const block = lines.slice(start + 1, end);
    const fields: Record<string, string[]> = {};
    let cur: string | null = null;
    for (const line of block) {
      const fm = FIELD_RE.exec(line);
      if (fm) {
        cur = fm[1].toLowerCase();
        fields[cur] = [fm[2]];
        continue;
      }
      if (/^#{1,6}\s+/.test(line)) break;
      if (cur) {
        if (/^(\s{2,}|\t)/.test(line) || line.trim() === '') {
          fields[cur].push(line.replace(/^\s{1,2}/, ''));
        }
      }
    }
    const get = (k: string) => (fields[k] || []).join('\n').trim();
    const answer = get('answer');
    const resolution = get('resolution');
    const blockingRaw = get('blocking') || 'no';
    const optionLines = fields.options || [];
    const options = optionLines
      .map((l) => /^\s*-\s*([A-Za-z0-9]+)\s*[:：]\s*(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ id: m[1], text: m[2].trim() }));

    out.push({
      id: heads[h].id,
      status: deriveStatus(heads[h].status, answer, resolution),
      to: heads[h].to,
      from: get('from') || '?',
      blocking: /^\s*yes/i.test(blockingRaw),
      blockingRaw,
      date: get('date') || undefined,
      context: get('context'),
      options,
      recommendation: get('recommendation') || undefined,
      answer: answer || undefined,
      resolution: resolution || undefined,
      file: fileAbs,
      lineStart: start + 1,
      lineEnd: end,
      repo,
    });
  }
  return out;
}

export interface NewQuestion {
  id?: string;
  to: string;
  from: Role | string;
  blocking: boolean;
  blockingNote?: string;
  context: string;
  options?: { id: string; text: string }[];
  recommendation?: string;
}

export function nextQuestionId(existing: { id: string }[]): string {
  let max = 0;
  for (const q of existing) {
    const n = Number(/Q-(\d+)/.exec(q.id)?.[1] || 0);
    if (n > max) max = n;
  }
  return `Q-${String(max + 1).padStart(3, '0')}`;
}

function indentContinuation(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length === 1) return lines;
  return [lines[0], ...lines.slice(1).map((l) => '  ' + l)];
}

export function renderQuestion(q: NewQuestion & { id: string }): string {
  const out: string[] = [];
  out.push(`## ${q.id} [open] to: ${q.to}`);
  out.push(`- from: ${q.from}`);
  out.push(`- date: ${today()}`);
  out.push(
    `- blocking: ${q.blocking ? 'yes' : 'no'}${q.blockingNote ? `（${q.blockingNote}）` : ''}`,
  );
  out.push(...indentContinuation('- context: ' + q.context));
  if (q.options?.length) {
    out.push('- options:');
    for (const o of q.options) out.push(`  - ${o.id}: ${o.text}`);
  }
  if (q.recommendation) {
    out.push(...indentContinuation('- recommendation: ' + q.recommendation));
  }
  out.push('- answer:');
  out.push('- resolution:');
  out.push('');
  return out.join('\n');
}

export function appendQuestion(fileAbs: string, q: NewQuestion & { id: string }): string {
  ensureDir(path.dirname(fileAbs));
  const prev = exists(fileAbs) ? readTextRequired(fileAbs) : defaultQuestionsHeader();
  const next = prev.replace(/\s*$/, '\n\n') + renderQuestion(q);
  writeAtomic(fileAbs, next);
  return fileAbs;
}

export function defaultQuestionsHeader(): string {
  return `# Agent Questions

> 协议：见 \`CLAUDE.md\` 与伞仓 \`docs/template/AGENT-QUESTIONS.md\`。
> \`to: main\` 由用户转发主 agent；\`to: PLAN\` 由本仓 PLAN agent 回答后提醒用户转发 TODO agent。
> 规则：blocking: yes 必须停；回答必须回写 PLAN/TODO/decisions，不能只留在问答文件。
> ${QUESTION_STATUS_HELP}

`;
}

/** Return the raw line range of a question (heading included). */
function locate(text: string, id: string): { start: number; end: number } | null {
  const lines = text.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]);
    if (!m) continue;
    if (start === -1 && m[1] === id) {
      start = i;
      continue;
    }
    if (start !== -1) return { start, end: i };
  }
  return start === -1 ? null : { start, end: lines.length };
}

function replaceField(lines: string[], key: string, value: string): string[] {
  const out: string[] = [];
  let i = 0;
  let found = false;
  while (i < lines.length) {
    const m = FIELD_RE.exec(lines[i]);
    if (m && m[1].toLowerCase() === key) {
      found = true;
      const first = value.split('\n')[0];
      out.push(`- ${key}:${first ? ' ' + first : ''}`);
      const rest = value.split('\n').slice(1);
      for (const line of rest) out.push(line ? `  ${line}` : '');
      i++;
      // skip old continuation lines
      while (i < lines.length) {
        if (FIELD_RE.test(lines[i])) break;
        if (/^#{1,6}\s+/.test(lines[i])) break;
        if (lines[i].trim() === '') {
          // blank line: stop if next non-blank is a new field/heading
          let j = i + 1;
          while (j < lines.length && lines[j].trim() === '') j++;
          if (j >= lines.length || FIELD_RE.test(lines[j]) || /^#{1,6}\s+/.test(lines[j])) {
            i = j;
            break;
          }
        }
        i++;
      }
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  if (!found) {
    // insert before the trailing blank line
    const tail: string[] = [];
    while (out.length && out[out.length - 1].trim() === '') tail.push(out.pop() as string);
    out.push(`- ${key}:${value ? ' ' + value.split('\n')[0] : ''}`);
    for (const line of value.split('\n').slice(1)) out.push(line ? `  ${line}` : '');
    out.push(...tail);
  }
  return out;
}

export function updateQuestion(
  fileAbs: string,
  id: string,
  patch: {
    status?: QuestionStatus;
    answer?: string;
    resolution?: string;
  },
): boolean {
  if (!exists(fileAbs)) return false;
  const text = readTextRequired(fileAbs);
  const range = locate(text, id);
  if (!range) return false;
  const lines = text.split('\n');
  let block = lines.slice(range.start, range.end);

  if (patch.status) {
    const heading = HEADING_RE.exec(block[0]);
    const to = heading?.[3] || '';
    const qid = heading?.[1] || id;
    block[0] = `## ${qid} [${patch.status}] to: ${to}`;
  }
  if (patch.answer !== undefined) block = replaceField(block, 'answer', patch.answer);
  if (patch.resolution !== undefined) block = replaceField(block, 'resolution', patch.resolution);

  const next = [...lines.slice(0, range.start), ...block, ...lines.slice(range.end)].join('\n');
  writeAtomic(fileAbs, next);
  return true;
}

export function findQuestionInFiles(
  files: { abs: string; repo?: string }[],
  id: string,
): Question | null {
  for (const f of files) {
    const q = parseQuestionsFile(f.abs, f.repo).find((x) => x.id === id);
    if (q) return q;
  }
  return null;
}

export function questionSummary(q: Question): string {
  const block = q.blocking ? ' [blocking]' : '';
  const who = `${q.from} → ${q.to}`;
  return `${q.id} [${q.status}]${block} ${who}: ${firstLine(q.context)}`;
}

function firstLine(s: string): string {
  return (s.split('\n')[0] || '').slice(0, 140);
}
