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

/**
 * Append `block` to the section introduced by `headingPattern`, inserting before
 * the next heading of the same or higher level. Falls back to appending at the
 * end of the document when the section does not exist.
 *
 * Appending to the section rather than to EOF keeps later sections (for example
 * `## 验收记录`) from swallowing new entries after a rework loop.
 */
export function appendToSection(text: string, headingPattern: RegExp, block: string): string {
  const lines = text.split('\n');
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (m && headingPattern.test(m[2])) {
      start = i;
      level = m[1].length;
      break;
    }
  }

  const blockLines = block.replace(/\s+$/, '').split('\n');
  if (start === -1) {
    return text.replace(/\s*$/, '\n\n') + blockLines.join('\n') + '\n';
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }

  // Insert at the end of the section, before its trailing blank lines.
  let insertAt = end;
  while (insertAt > start + 1 && lines[insertAt - 1].trim() === '') insertAt--;

  const out = [...lines.slice(0, insertAt), '', ...blockLines, '', ...lines.slice(insertAt)];
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}
