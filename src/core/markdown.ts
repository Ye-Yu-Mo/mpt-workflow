import YAML from 'yaml';

export interface FrontMatter {
  data: Record<string, unknown>;
  body: string;
  hasFrontMatter: boolean;
}

export function splitFrontMatter(text: string): FrontMatter {
  if (!text.startsWith('---')) return { data: {}, body: text, hasFrontMatter: false };
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') return { data: {}, body: text, hasFrontMatter: false };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return { data: {}, body: text, hasFrontMatter: false };
  const raw = lines.slice(1, end).join('\n');
  let data: Record<string, unknown> = {};
  try {
    const parsed = YAML.parse(raw);
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
  } catch {
    data = {};
  }
  return {
    data,
    body: lines.slice(end + 1).join('\n'),
    hasFrontMatter: true,
  };
}

/** Get a markdown section body between a heading and the next same-or-higher heading. */
export function section(text: string, headingPattern: RegExp): string | null {
  const lines = text.split('\n');
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (m && headingPattern.test(m[2])) {
      start = i + 1;
      level = m[1].length;
      break;
    }
  }
  if (start === -1) return null;
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i]);
    if (m && m[1].length <= level) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

/** Extract all inline-code spans (`...`) from a chunk of markdown. */
export function inlineCode(text: string): string[] {
  const out: string[] = [];
  const re = /`([^`\n]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1].trim());
  return out;
}

/** Normalize a fenced code block marker out of a string; returns trimmed text. */
export function stripQuotes(s: string): string {
  return s.replace(/^>\s?/gm, '').trim();
}
