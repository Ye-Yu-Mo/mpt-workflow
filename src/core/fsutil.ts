import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

export function readText(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

export function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Atomic write: write to temp file in the same dir, then rename. */
export function writeAtomic(p: string, content: string): void {
  ensureDir(path.dirname(p));
  const tmp = path.join(
    path.dirname(p),
    `.${path.basename(p)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, p);
}

export function writeIfMissing(p: string, content: string): boolean {
  if (exists(p)) return false;
  writeAtomic(p, content);
  return true;
}

export function appendLine(p: string, line: string): void {
  ensureDir(path.dirname(p));
  fs.appendFileSync(p, line.endsWith('\n') ? line : line + '\n', 'utf8');
}

export function relTo(root: string, p: string): string {
  const r = path.relative(root, p);
  return r.split(path.sep).join('/');
}

export function within(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function slugDate(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Truncate text to a maximum length, keeping head and tail. */
export function truncate(text: string, max = 6000): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.75));
  const tail = text.slice(-Math.floor(max * 0.2));
  return `${head}\n... [truncated ${text.length - head.length - tail.length} chars] ...\n${tail}`;
}
