/**
 * Find every translation key in the source, statically.
 *
 * Running commands only reveals the branches that ran, and the branches that
 * did not run are the error paths — precisely the messages someone needs
 * translated when things are going wrong. So coverage is measured by reading
 * the source rather than by exercising it.
 *
 * This is a scanner, not a parser: it needs to tell a string from a comment
 * from a regular expression, and nothing more. The one genuinely ambiguous
 * case in JavaScript is `/`, which begins a regex or a division depending on
 * what came before it; the previous significant character settles it.
 */

export interface FoundKey {
  key: string;
  file: string;
  /** `t` for a tagged template, `tr` and `ph` for calls. */
  kind: 't' | 'tr' | 'ph';
}

const IDENT_END = /[A-Za-z0-9_$)\]]/;

interface Span {
  start: number;
  end: number;
  quote: string;
}

/** All string literals, recursing into the `${...}` holes of templates. */
function scanStrings(src: string, base = 0): Span[] {
  const out: Span[] = [];
  const holes: Array<[number, number]> = [];
  let i = 0;
  let prev = '';
  const n = src.length;

  while (i < n) {
    const c = src[i]!;
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2);
      i = j === -1 ? n : j + 2;
      continue;
    }
    if (c === '/' && !IDENT_END.test(prev || ' ')) {
      // Regex literal: skip it, minding character classes and escapes.
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const d = src[j]!;
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        else if (d === '\n') break;
        j++;
      }
      i = j + 1;
      prev = '/';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const start = i;
      let j = i + 1;
      if (c === '`') {
        let depth = 0;
        let holeStart = -1;
        while (j < n) {
          const d = src[j]!;
          if (d === '\\') {
            j += 2;
            continue;
          }
          if (depth === 0 && d === '`') break;
          if (d === '$' && src[j + 1] === '{') {
            depth++;
            if (depth === 1) holeStart = j + 2;
            j += 2;
            continue;
          }
          if (depth > 0 && d === '{') depth++;
          else if (depth > 0 && d === '}') {
            depth--;
            if (depth === 0 && holeStart >= 0) {
              holes.push([holeStart, j]);
              holeStart = -1;
            }
          }
          j++;
        }
      } else {
        while (j < n) {
          const d = src[j]!;
          if (d === '\\') {
            j += 2;
            continue;
          }
          if (d === c || d === '\n') break;
          j++;
        }
      }
      out.push({ start: start + base, end: j + 1 + base, quote: c });
      i = j + 1;
      prev = '"';
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }

  for (const [a, b] of holes) out.push(...scanStrings(src.slice(a, b), base + a));
  return out;
}

/** Decode a JavaScript string body to its runtime value. */
function unescape(js: string): string {
  let out = '';
  let i = 0;
  const simple: Record<string, string> = {
    n: '\n',
    t: '\t',
    r: '\r',
    b: '\b',
    f: '\f',
    v: '\v',
    '0': '\0',
    '\\': '\\',
    "'": "'",
    '"': '"',
    '`': '`',
    $: '$',
  };
  while (i < js.length) {
    const c = js[i]!;
    if (c !== '\\') {
      out += c;
      i++;
      continue;
    }
    const d = js[i + 1] ?? '';
    if (d === 'u') {
      if (js[i + 2] === '{') {
        const close = js.indexOf('}', i + 3);
        out += String.fromCodePoint(Number.parseInt(js.slice(i + 3, close), 16));
        i = close + 1;
      } else {
        out += String.fromCodePoint(Number.parseInt(js.slice(i + 2, i + 6), 16));
        i += 6;
      }
      continue;
    }
    out += simple[d] ?? d;
    i += 2;
  }
  return out;
}

/** `` `x ${a} y` `` → `'x {0} y'`, matching `keyOf` in i18n.ts. */
function templateKey(body: string): string {
  const inner = body.slice(1, -1);
  const parts: string[] = [];
  let lit = '';
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === '\\') {
      lit += inner.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (inner[i] === '$' && inner[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      while (j < inner.length && depth > 0) {
        if (inner[j] === '{') depth++;
        else if (inner[j] === '}') depth--;
        j++;
      }
      parts.push(lit);
      lit = '';
      i = j;
      continue;
    }
    lit += inner[i];
    i++;
  }
  parts.push(lit);
  let key = parts[0] ?? '';
  for (let k = 1; k < parts.length; k++) key += `{${k - 1}}${parts[k]}`;
  return unescape(key);
}

/** Every key requested by one source file. */
/** The four entities an attribute value can carry. */
function htmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

export function keysInSource(src: string, file = ''): FoundKey[] {
  const found: FoundKey[] = [];

  // Markup, before the script.
  //
  // The dashboard translates its own static text through `data-tr` attributes,
  // and those are HTML — not JavaScript string literals, so the scanner below
  // walked straight past them. Nine strings on the one surface that is always
  // on screen were outside the gate the project relies on, and an untranslated
  // one there would have shipped silently.
  //
  // (Written without an example value on purpose: this file is scanned too,
  // and a sample attribute in a comment becomes a key nobody can translate.)
  for (const m of src.matchAll(/\bdata-tr="([^"]*)"/g)) {
    if (m[1]) found.push({ key: htmlUnescape(m[1]), file, kind: 'tr' });
  }

  for (const span of scanStrings(src)) {
    const before = src.slice(0, span.start).trimEnd();
    const body = src.slice(span.start, span.end);
    if (span.quote === '`') {
      // A bare `t` immediately before the backtick, not `.t` or `foot`.
      if (/(^|[^A-Za-z0-9_$.])t$/.test(before)) {
        found.push({ key: templateKey(body), file, kind: 't' });
      }
    } else if (before.endsWith('tr(')) {
      found.push({ key: unescape(body.slice(1, -1)), file, kind: 'tr' });
    } else if (/(^|[^A-Za-z0-9_$.])ph\($/.test(before)) {
      // `ph` builds a phrase the renderer translates later. Its keys were
      // invisible to this scanner for a while, which meant the engine could
      // add an untranslated sentence and the coverage test would still pass —
      // exactly the failure the test exists to prevent.
      found.push({ key: unescape(body.slice(1, -1)), file, kind: 'ph' });
    }
  }
  return found;
}
