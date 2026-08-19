/**
 * Position-aware JSON reader and surgical editor.
 *
 * We edit a file we do not own: the user's `settings.json`. The obvious
 * implementation — `JSON.parse`, mutate, `JSON.stringify` — is banned here,
 * because it silently rewrites the whole file: comments vanish, key order is
 * preserved but formatting is not, trailing commas disappear, and a two-space
 * file comes back four-space. A tool that edits your config should leave every
 * byte it did not mean to change exactly as it found it.
 *
 * So this scanner records byte offsets for every value, and edits are performed
 * as text splices at those offsets. Comments are skipped for parsing and
 * untouched for writing.
 *
 * Pure string work — no filesystem here. The caller does the reading, backing
 * up and atomic renaming.
 */

export type JsonNodeKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export interface JsonNode {
  kind: JsonNodeKind;
  /** Offset of the first character of the value. */
  start: number;
  /** Offset just past the last character of the value. */
  end: number;
  /** Object members, in source order. */
  members?: JsonMember[];
  /** Array elements, in source order. */
  items?: JsonNode[];
  /** Decoded value for primitives. */
  value?: string | number | boolean | null;
}

export interface JsonMember {
  key: string;
  /** Offset of the opening quote of the key. */
  keyStart: number;
  value: JsonNode;
}

export class JsonParseError extends Error {
  offset: number;
  constructor(message: string, offset: number) {
    super(message);
    this.offset = offset;
  }
}

/**
 * Does this text contain JSON comments outside of strings?
 *
 * Worth asking separately from parsing, because the two consumers disagree:
 * this editor tolerates comments so it never destroys something it does not
 * understand, but Claude Code's own settings parser is strict JSON and rejects
 * a commented file *in its entirety*. A user with a comment in settings.json
 * has an agent that is silently ignoring every setting in it — including any
 * hook we install. Editing such a file without saying so would leave them
 * believing the install worked.
 */
export function hasComments(text: string): boolean {
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) return true;
  }
  return false;
}

/** Parse, keeping offsets. Throws JsonParseError on malformed input. */
export function parseWithPositions(text: string): JsonNode {
  const p = new Parser(text);
  p.skipTrivia();
  const node = p.parseValue();
  p.skipTrivia();
  if (p.pos < text.length) throw new JsonParseError('unexpected trailing content', p.pos);
  return node;
}

class Parser {
  pos = 0;
  // Plain field, not a parameter property: `erasableSyntaxOnly` forbids the
  // shorthand because it emits runtime code from a type position.
  text: string;
  constructor(text: string) {
    this.text = text;
  }

  skipTrivia(): void {
    const t = this.text;
    for (;;) {
      while (this.pos < t.length && /\s/.test(t[this.pos]!)) this.pos++;
      if (t.startsWith('//', this.pos)) {
        const nl = t.indexOf('\n', this.pos);
        this.pos = nl === -1 ? t.length : nl + 1;
        continue;
      }
      if (t.startsWith('/*', this.pos)) {
        const close = t.indexOf('*/', this.pos + 2);
        this.pos = close === -1 ? t.length : close + 2;
        continue;
      }
      return;
    }
  }

  parseValue(): JsonNode {
    const t = this.text;
    const c = t[this.pos];
    if (c === '{') return this.parseObject();
    if (c === '[') return this.parseArray();
    if (c === '"') {
      const start = this.pos;
      const value = this.parseString();
      return { kind: 'string', start, end: this.pos, value };
    }
    if (t.startsWith('true', this.pos)) return this.lit('boolean', 4, true);
    if (t.startsWith('false', this.pos)) return this.lit('boolean', 5, false);
    if (t.startsWith('null', this.pos)) return this.lit('null', 4, null);

    const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(t.slice(this.pos));
    if (m) {
      const start = this.pos;
      this.pos += m[0].length;
      return { kind: 'number', start, end: this.pos, value: Number(m[0]) };
    }
    throw new JsonParseError('a value was expected', this.pos);
  }

  lit(kind: JsonNodeKind, len: number, value: boolean | null): JsonNode {
    const start = this.pos;
    this.pos += len;
    return { kind, start, end: this.pos, value };
  }

  parseString(): string {
    const t = this.text;
    if (t[this.pos] !== '"') throw new JsonParseError('expected a string', this.pos);
    let i = this.pos + 1;
    let out = '';
    while (i < t.length) {
      const ch = t[i]!;
      if (ch === '"') {
        this.pos = i + 1;
        return out;
      }
      if (ch === '\\') {
        const esc = t[i + 1];
        if (esc === 'u') {
          out += String.fromCharCode(parseInt(t.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        const map: Record<string, string> = {
          '"': '"',
          '\\': '\\',
          '/': '/',
          b: '\b',
          f: '\f',
          n: '\n',
          r: '\r',
          t: '\t',
        };
        out += map[esc ?? ''] ?? esc ?? '';
        i += 2;
        continue;
      }
      out += ch;
      i++;
    }
    throw new JsonParseError('unterminated string', this.pos);
  }

  parseObject(): JsonNode {
    const start = this.pos;
    this.pos++; // {
    const members: JsonMember[] = [];
    this.skipTrivia();
    if (this.text[this.pos] === '}') {
      this.pos++;
      return { kind: 'object', start, end: this.pos, members };
    }
    for (;;) {
      this.skipTrivia();
      const keyStart = this.pos;
      const key = this.parseString();
      this.skipTrivia();
      if (this.text[this.pos] !== ':') throw new JsonParseError('expected ":"', this.pos);
      this.pos++;
      this.skipTrivia();
      members.push({ key, keyStart, value: this.parseValue() });
      this.skipTrivia();
      const ch = this.text[this.pos];
      if (ch === ',') {
        this.pos++;
        this.skipTrivia();
        // Tolerate a trailing comma rather than destroying the file over it.
        if (this.text[this.pos] === '}') {
          this.pos++;
          return { kind: 'object', start, end: this.pos, members };
        }
        continue;
      }
      if (ch === '}') {
        this.pos++;
        return { kind: 'object', start, end: this.pos, members };
      }
      throw new JsonParseError('expected "," or "}"', this.pos);
    }
  }

  parseArray(): JsonNode {
    const start = this.pos;
    this.pos++; // [
    const items: JsonNode[] = [];
    this.skipTrivia();
    if (this.text[this.pos] === ']') {
      this.pos++;
      return { kind: 'array', start, end: this.pos, items };
    }
    for (;;) {
      this.skipTrivia();
      items.push(this.parseValue());
      this.skipTrivia();
      const ch = this.text[this.pos];
      if (ch === ',') {
        this.pos++;
        this.skipTrivia();
        if (this.text[this.pos] === ']') {
          this.pos++;
          return { kind: 'array', start, end: this.pos, items };
        }
        continue;
      }
      if (ch === ']') {
        this.pos++;
        return { kind: 'array', start, end: this.pos, items };
      }
      throw new JsonParseError('expected "," or "]"', this.pos);
    }
  }
}

// ── navigation ────────────────────────────────────────────────────────────

export function member(node: JsonNode | undefined, key: string): JsonMember | undefined {
  return node?.members?.find((m) => m.key === key);
}

export function child(node: JsonNode | undefined, key: string): JsonNode | undefined {
  return member(node, key)?.value;
}

// ── editing ───────────────────────────────────────────────────────────────

export interface Splice {
  start: number;
  end: number;
  text: string;
}

/** Apply splices right-to-left so earlier offsets stay valid. */
export function applySplices(text: string, splices: Splice[]): string {
  const sorted = [...splices].sort((a, b) => b.start - a.start);
  let out = text;
  for (const s of sorted) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  return out;
}

/**
 * The file's own indentation, so an inserted block looks like it belongs.
 * Falls back to two spaces, which is what everything writes these days.
 */
export function detectIndent(text: string): string {
  const m = /\n([ \t]+)\S/.exec(text);
  const unit = m?.[1] ?? '  ';
  // A deeply indented first hit is not the unit; take the smallest run seen.
  let smallest = unit;
  for (const hit of text.matchAll(/\n([ \t]+)\S/g)) {
    const s = hit[1]!;
    if (s.length < smallest.length) smallest = s;
  }
  return smallest;
}

/** Column of a node's line start, so nested inserts line up. */
export function indentOf(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const m = /^[ \t]*/.exec(text.slice(lineStart, offset));
  return m?.[0] ?? '';
}

/**
 * Splice that appends a member to an object, or an element to an array.
 * Handles the empty-container case (`{}` / `[]`) and preserves the closing
 * bracket's own indentation.
 */
export function appendInto(text: string, container: JsonNode, rendered: string): Splice {
  const isObject = container.kind === 'object';
  const children: Array<{ start: number; end: number }> = isObject
    ? (container.members ?? []).map((m) => ({ start: m.keyStart, end: m.value.end }))
    : (container.items ?? []).map((i) => ({ start: i.start, end: i.end }));

  const closeIndent = indentOf(text, container.end - 1);
  const innerIndent = closeIndent + detectIndent(text);
  const body = rendered
    .split('\n')
    .map((l, i) => (i === 0 ? innerIndent + l : innerIndent + l))
    .join('\n');

  if (children.length === 0) {
    // `{}` becomes `{\n  <body>\n}` with the caller's indentation.
    return {
      start: container.start + 1,
      end: container.end - 1,
      text: `\n${body}\n${closeIndent}`,
    };
  }
  const last = children[children.length - 1]!;
  return { start: last.end, end: last.end, text: `,\n${body}` };
}

/** Splice that removes one element from an array, including its separator. */
export function removeElement(text: string, array: JsonNode, index: number): Splice | null {
  const items = array.items ?? [];
  const target = items[index];
  if (!target) return null;

  if (items.length === 1) {
    return { start: array.start + 1, end: array.end - 1, text: '' };
  }
  if (index === items.length - 1) {
    // Swallow the comma that precedes it, plus the whitespace between.
    const prev = items[index - 1]!;
    return { start: prev.end, end: target.end, text: '' };
  }
  // Swallow the comma that follows it.
  const next = items[index + 1]!;
  return { start: target.start, end: next.start, text: '' };
}

/** Splice that removes one member from an object, including its separator. */
export function removeMember(text: string, obj: JsonNode, key: string): Splice | null {
  const members = obj.members ?? [];
  const i = members.findIndex((m) => m.key === key);
  if (i === -1) return null;
  const target = members[i]!;

  if (members.length === 1) {
    return { start: obj.start + 1, end: obj.end - 1, text: '' };
  }
  if (i === members.length - 1) {
    const prev = members[i - 1]!;
    return { start: prev.value.end, end: target.value.end, text: '' };
  }
  const next = members[i + 1]!;
  return { start: target.keyStart, end: next.keyStart, text: '' };
}

/** Render a value the way the surrounding file is written. */
export function render(value: unknown, indent: string, depth = 0): string {
  const pad = indent.repeat(depth);
  const padIn = indent.repeat(depth + 1);
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((v) => padIn + render(v, indent, depth + 1));
    return `[\n${items.join(',\n')}\n${pad}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return '{}';
  const body = entries.map(([k, v]) => `${padIn}${JSON.stringify(k)}: ${render(v, indent, depth + 1)}`);
  return `{\n${body.join(',\n')}\n${pad}}`;
}
