import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const PORT = 7791;
const BASE = `http://127.0.0.1:${PORT}`;

async function serverUp(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/status`);
    return r.ok;
  } catch {
    return false;
  }
}

test('dashboard renders from the live API', async (t) => {
  if (!(await serverUp())) {
    t.skip(`web server not running on ${PORT}`);
    return;
  }
  const html = fs.readFileSync(
    path.resolve(process.cwd(), 'src/web/public/index.html'),
    'utf8',
  );

  const errors: Error[] = [];
  const dom = new JSDOM(html, {
    url: BASE + '/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = ((input: string | URL, init?: RequestInit) =>
        fetch(new URL(String(input), BASE), init)) as typeof window.fetch;
      window.matchMedia = ((q: string) => ({
        matches: false,
        media: q,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {
          return false;
        },
      })) as unknown as typeof window.matchMedia;
      window.addEventListener('error', (e) => {
        errors.push((e as ErrorEvent).error || new Error(String(e)));
      });
    },
  });

  await new Promise((r) => setTimeout(r, 1500));

  const doc = dom.window.document;
  assert.equal(errors.length, 0, 'no runtime errors: ' + errors.map((e) => e.message).join('; '));

  const hero = doc.querySelector('#hero-num')?.textContent;
  assert.ok(hero && hero !== '–', 'hero number rendered');

  const repos = doc.querySelectorAll('#repos .repo');
  assert.ok(repos.length > 0, 'repo cards rendered');

  const ms = doc.querySelectorAll('#repos .ms');
  assert.ok(ms.length >= 4, 'milestone chips rendered');

  const tiles = doc.querySelectorAll('#tiles .tile');
  assert.equal(tiles.length, 4, 'four stat tiles');

  const next = doc.querySelectorAll('#next .row-item');
  assert.ok(next.length > 0, 'next actions rendered');

  // clicking a milestone opens the detail panel
  (ms[0] as HTMLElement).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.ok(doc.querySelector('#repos details.ms-detail'), 'milestone detail opens');

  dom.window.close();
});
