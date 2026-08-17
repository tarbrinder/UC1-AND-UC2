/// <reference types="node" />
// ─── Repo scanner: field-routing regexes + name-matching .includes() ─────────
// Finds every place in src/ that ROUTES ON A NAME — a regex tested against a field/spec/label/key,
// or a string containment check on one — and reports the ones that are not word-bounded.
// Node-only (fs); never imported by app code.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { leftUnboundedWords } from './wordBoundary.ts';

export const SRC_ROOT = fileURLToPath(new URL('../../', import.meta.url));   // …/rfq-form/src/
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Identifiers/properties that mean "this value is a NAME being routed on", not free text.
 *  Deliberately singular: `names`/`keys`/`labels` are almost always arrays, and Array#includes is
 *  exact membership, not containment. */
const NAMEY = /(^|[^a-z])(field|fieldname|name|label|key|spec|attr|attribute|title|question)($|[^a-z])/i;
/** Free-text receivers — matching inside them is content search, not name routing. */
const FREE_TEXT = /(^|[^a-z])(desc|description|text|blob|body|prompt|transcript|message|content|url|path|href)($|[^a-z])/i;

export interface RegexFinding {
  file: string; line: number; pattern: string; routedOn: string; unbounded: string[]; symbol?: string;
}
export interface IncludesFinding {
  file: string; line: number; expr: string; kind: 'literal' | 'containment';
}

// ── source hygiene: blank out comments and string/template literals so their contents are never
//    scanned. Regex literals are recognised (and PRESERVED) so a `/['"]/` cannot open a fake string.
export function stripNoise(src: string): string {
  const out = src.split('');
  const blank = (from: number, to: number) => { for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = ' '; };
  let i = 0;
  let prevSig = '';
  const REGEX_OK_BEFORE = /[([{,;:=!&|?+\-*%~^<>]/;
  const KEYWORD_BEFORE = /\b(return|typeof|case|in|of|new|do|else|yield|await|delete|void)$/;
  while (i < src.length) {
    const c = src[i], c2 = src[i + 1];
    if (c === '/' && c2 === '/') { const e = src.indexOf('\n', i); const end = e === -1 ? src.length : e; blank(i, end); i = end; continue; }
    if (c === '/' && c2 === '*') { const e = src.indexOf('*/', i + 2); const end = e === -1 ? src.length : e + 2; blank(i, end); i = end; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length) { if (src[j] === '\\') { j += 2; continue; } if (src[j] === c) break; j++; }
      blank(i, Math.min(j + 1, src.length)); i = j + 1; prevSig = '"'; continue;
    }
    if (c === '/') {
      const before = src.slice(0, i).replace(/\s+$/, '');
      const isRegex = before === '' || REGEX_OK_BEFORE.test(before.slice(-1)) || KEYWORD_BEFORE.test(before);
      if (isRegex) {
        let j = i + 1, inClass = false, closed = false;
        while (j < src.length) {
          const d = src[j];
          if (d === '\\') { j += 2; continue; }
          if (d === '\n') break;
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) { closed = true; break; }
          j++;
        }
        if (closed) { i = j + 1; prevSig = '/'; continue; }   // preserved verbatim
      }
    }
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  void prevSig;
  return out.join('');
}

export function listSourceFiles(root = SRC_ROOT): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(entry)) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

const lineOf = (txt: string, idx: number): number => txt.slice(0, idx).split('\n').length;
const RE_BODY = String.raw`((?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n[])+)`;

/** A regex literal is "field routing" when it is tested against a name-ish expression. */
function routesOnName(arg: string): boolean {
  return NAMEY.test(arg) && !FREE_TEXT.test(arg);
}

export function scanFieldRoutingRegexes(files = listSourceFiles()): RegexFinding[] {
  const findings: RegexFinding[] = [];
  const add = (file: string, line: number, source: string, flags: string, routedOn: string, symbol?: string) => {
    let re: RegExp;
    try { re = new RegExp(source, flags); } catch { return; }
    const unbounded = leftUnboundedWords(re);
    if (unbounded.length) findings.push({ file: relative(REPO_ROOT, file), line, pattern: `/${source}/${flags}`, routedOn: routedOn.trim().replace(/\s+/g, ' ').slice(0, 48), unbounded, symbol });
  };
  for (const file of files) {
    const txt = stripNoise(readFileSync(file, 'utf8'));
    // (a) /re/.test(x) · /re/.exec(x)
    for (const m of txt.matchAll(new RegExp(String.raw`\/${RE_BODY}\/([gimsuyv]*)\s*\.\s*(?:test|exec)\s*\(([^)]{0,90})`, 'g'))) {
      if (!routesOnName(m[3])) continue;
      add(file, lineOf(txt, m.index), m[1], m[2], m[3]);
    }
    // (b) x.match(/re/)
    for (const m of txt.matchAll(new RegExp(String.raw`([A-Za-z_$][\w$.()[\]]{0,40})\s*\.\s*match\s*\(\s*\/${RE_BODY}\/([gimsuyv]*)`, 'g'))) {
      if (!routesOnName(m[1])) continue;
      add(file, lineOf(txt, m.index), m[2], m[3], m[1]);
    }
    // (c) const NAME = /re/ … later NAME.test(x)
    for (const m of txt.matchAll(new RegExp(String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\/${RE_BODY}\/([gimsuyv]*)`, 'g'))) {
      const [, symbol, source, flags] = m;
      const uses = [...txt.matchAll(new RegExp(String.raw`\b${symbol}\s*\.\s*(?:test|exec)\s*\(([^)]{0,90})`, 'g'))].map((u) => u[1]);
      const routed = uses.find(routesOnName);
      if (!routed) continue;
      add(file, lineOf(txt, m.index), source, flags, routed, symbol);
    }
  }
  return findings;
}

/** String-ish receivers: a normaliser call, an explicit lowercase, or a name-ish identifier. */
const STRINGY = /(^|[^a-z])(norm|nk|lc|titleCase|normVal|String)\s*\(|\.toLowerCase\(\)|^[a-z][\w$]*$/i;

export function scanNameIncludes(files = listSourceFiles()): IncludesFinding[] {
  const findings: IncludesFinding[] = [];
  const EXPR = String.raw`[A-Za-z_$][\w$]*(?:\s*\([^()]{0,60}\))?(?:\s*\.\s*[A-Za-z_$][\w$]*(?:\s*\([^()]{0,60}\))?)*`;
  for (const file of files) {
    const txt = stripNoise(readFileSync(file, 'utf8'));
    // (a) name.includes('literal') — the n8n title.includes('seller') shape
    for (const m of txt.matchAll(new RegExp(String.raw`(${EXPR})\s*\.includes\(\s*(['"\`])([^'"\`]{2,60})\2\s*\)`, 'g'))) {
      const [, recv, , lit] = m;
      if (!routesOnName(recv)) continue;
      if (!/^[a-z][a-z0-9]{2,}$/i.test(lit)) continue;         // a delimiter-bearing literal (a URL path) is not word matching
      findings.push({ file: relative(REPO_ROOT, file), line: lineOf(txt, m.index), expr: `${recv}.includes('${lit}')`, kind: 'literal' });
    }
    // (b) a.includes(b) where both sides are strings and one is a name — unbounded by construction
    for (const m of txt.matchAll(new RegExp(String.raw`(${EXPR})\s*\.includes\(\s*(${EXPR})\s*\)`, 'g'))) {
      const [, recv, arg] = m;
      if (/^[A-Z0-9_]+$/.test(recv.split('.')[0])) continue;   // SCREAMING const ⇒ an array, exact membership
      if (!STRINGY.test(recv)) continue;
      if (!(routesOnName(recv) || routesOnName(arg))) continue;
      if (FREE_TEXT.test(recv) || FREE_TEXT.test(arg)) continue;
      findings.push({ file: relative(REPO_ROOT, file), line: lineOf(txt, m.index), expr: `${recv}.includes(${arg})`, kind: 'containment' });
    }
  }
  return findings;
}

/** Line-number-free key, so the baseline survives edits above the finding. */
export const regexKey = (f: RegexFinding): string => `${f.file} :: ${f.pattern} :: ${f.unbounded.join('|')}`;
export const includesKey = (f: IncludesFinding): string => `${f.file} :: ${f.expr}`;

/** Read one declaration out of a file that this test is NOT allowed to edit, so the guard is pinned
 *  to the real shipped source instead of a copy of it. Throws loudly when the anchor disappears —
 *  a guard that silently stops guarding is worse than no guard. */
export function extractRegexLiteral(file: string, anchor: RegExp, label: string): RegExp {
  const txt = stripNoise(readFileSync(join(REPO_ROOT, file), 'utf8'));
  const m = txt.match(anchor);
  if (!m) throw new Error(`[substring guard] could not find ${label} in ${file} — the anchor moved. Update the anchor; do not delete the test.`);
  const body = m[1], flags = m[2] ?? '';
  return new RegExp(body, flags);
}
