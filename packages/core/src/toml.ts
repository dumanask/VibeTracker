/**
 * A TOML 1.0 reader, written by hand.
 *
 * Why not a dependency: VibeTracker ships with zero runtime dependencies, and
 * config parsing is the one thing that must work before anything else does.
 * A parser that arrives over the network is a parser that can fail during
 * `npx`, on an air-gapped machine, or when a transitive version bumps.
 *
 * Why TOML at all: the config is meant to be edited by hand, and the single
 * feature that matters for a hand-edited file is comments. JSON has none;
 * JSON-with-comments is not a format anyone agrees on; YAML answers `no` to
 * the question "is `no` a string". TOML is boring, and boring is the point.
 *
 * The parser is deliberately strict. A config typo that silently parses into
 * something else is worse than one that refuses to load, because the second
 * kind tells you. Every error carries a line and a column.
 */

export interface TomlTable {
  [key: string]: TomlValue;
}
export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;

export class TomlError extends Error {
  line: number;
  column: number;
  constructor(message: string, line: number, column: number) {
    super(`${message} (line ${line}, column ${column})`);
    this.name = 'TomlError';
    this.line = line;
    this.column = column;
  }
}

const BARE = /[A-Za-z0-9_-]/;

/**
 * Tables are tracked by identity in four buckets because TOML's redefinition
 * rules depend on *how* a table came into existence, not on its contents: a
 * header may not be repeated, a table born from a dotted key may not later be
 * opened by a header, and an inline table is sealed the moment it closes.
 *
 * Without that bookkeeping `[server]` written twice would silently merge —
 * exactly the kind of typo that leaves someone staring at a setting that has
 * no effect and no explanation.
 */
class Parser {
  #s: string;
  #i = 0;
  #line = 1;
  #lineStart = 0;
  #root: TomlTable = Parser.#table();
  #current: TomlTable = this.#root;
  #currentPath: string[] = [];
  #headerTables = new Set<TomlTable>();
  #dottedTables = new Set<TomlTable>();
  #sealed = new Set<TomlTable>();
  #arrays = new Set<TomlValue[]>();
  /** Scope-qualified keys already assigned, for duplicate detection. */
  #assigned = new Set<string>();

  constructor(text: string) {
    // A BOM is invisible in an editor and would otherwise become part of the
    // first key name, producing an "unknown key" error nobody can see.
    this.#s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  parse(): TomlTable {
    for (;;) {
      this.#skipTrivia();
      if (this.#i >= this.#s.length) break;
      if (this.#s[this.#i] === '[') this.#header();
      else this.#assignment(this.#current, this.#currentPath.join('.'));
      this.#endOfLine();
    }
    return this.#root;
  }

  // ── position bookkeeping ──────────────────────────────────────────────
  #col(): number {
    return this.#i - this.#lineStart + 1;
  }
  #err(msg: string): TomlError {
    return new TomlError(msg, this.#line, this.#col());
  }
  #newline(): void {
    this.#line++;
    this.#lineStart = this.#i;
  }

  /** Whitespace, comments and newlines — everything with no meaning. */
  #skipTrivia(): void {
    for (;;) {
      const c = this.#s[this.#i];
      if (c === ' ' || c === '\t' || c === '\r') this.#i++;
      else if (c === '\n') {
        this.#i++;
        this.#newline();
      } else if (c === '#') {
        while (this.#i < this.#s.length && this.#s[this.#i] !== '\n') this.#i++;
      } else break;
    }
  }

  /** Spaces and tabs only — used where a newline would end the construct. */
  #skipInline(): void {
    while (this.#s[this.#i] === ' ' || this.#s[this.#i] === '\t') this.#i++;
  }

  #endOfLine(): void {
    this.#skipInline();
    if (this.#s[this.#i] === '#') {
      while (this.#i < this.#s.length && this.#s[this.#i] !== '\n') this.#i++;
    }
    const c = this.#s[this.#i];
    if (c === undefined) return;
    if (c === '\r' && this.#s[this.#i + 1] === '\n') {
      this.#i += 2;
      this.#newline();
      return;
    }
    if (c === '\n') {
      this.#i++;
      this.#newline();
      return;
    }
    throw this.#err(`unexpected character at end of line: ${JSON.stringify(c)}`);
  }

  // ── [table] and [[array of tables]] ───────────────────────────────────
  #header(): void {
    const startLine = this.#line;
    this.#i++;
    const isArray = this.#s[this.#i] === '[';
    if (isArray) this.#i++;
    const path = this.#keyPath();
    this.#skipInline();
    if (this.#s[this.#i] !== ']') throw this.#err("a table header must close with ']'");
    this.#i++;
    if (isArray) {
      if (this.#s[this.#i] !== ']') throw this.#err("an array of tables must close with ']]'");
      this.#i++;
    }

    let t = this.#root;
    for (let k = 0; k < path.length - 1; k++) t = this.#descend(t, path[k]!, startLine);
    const last = path[path.length - 1]!;
    // The final segment never goes through `#descend`, so a one-segment header
    // -- `[__proto__]` exactly -- would otherwise walk straight past the guard.
    this.#checkKey(last, startLine);

    if (isArray) {
      let arr = t[last];
      if (arr === undefined) {
        arr = [];
        this.#arrays.add(arr as TomlValue[]);
        t[last] = arr;
      } else if (!Array.isArray(arr) || !this.#arrays.has(arr)) {
        throw this.#err(`"${path.join('.')}" is not an array of tables`);
      }
      const entry: TomlTable = Parser.#table();
      this.#headerTables.add(entry);
      (arr as TomlValue[]).push(entry);
      this.#current = entry;
    } else {
      const existing = t[last];
      if (existing === undefined) {
        const entry: TomlTable = Parser.#table();
        this.#headerTables.add(entry);
        t[last] = entry;
        this.#current = entry;
      } else if (
        isTable(existing) &&
        !this.#headerTables.has(existing) &&
        !this.#dottedTables.has(existing) &&
        !this.#sealed.has(existing)
      ) {
        // Created implicitly by a deeper header — this is its definition.
        this.#headerTables.add(existing);
        this.#current = existing;
      } else {
        throw this.#err(`"${path.join('.')}" is defined a second time`);
      }
    }
    this.#currentPath = path;
  }

  /**
   * Keys a config file is not allowed to name.
   *
   * A TOML document is data from a file the user edits, and the parser was
   * writing its keys straight onto plain objects. `[__proto__]` therefore
   * walked into `Object.prototype` and every assignment under it landed on
   * every object in the process. Measured, not theorised:
   * `loadConfigText('[__proto__]
bad = true')` returned ok, its own result
   * had no such key, and `({}).bad` was `true` afterwards.
   *
   * Two defences rather than one, because either alone is a single line from
   * being wrong. Tables are made with a null prototype so there is nothing
   * underneath to reach, and these three names are refused outright so a
   * document that tries says so instead of quietly doing nothing.
   */
  static readonly #FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

  /** A table with no prototype, so a key can never reach through it. */
  static #table(): TomlTable {
    return Object.create(null) as TomlTable;
  }

  #checkKey(key: string, line: number): void {
    if (Parser.#FORBIDDEN.has(key)) {
      throw new TomlError(`"${key}" cannot be used as a key`, line, 1);
    }
  }

  /** Walk into (or create) an intermediate table named by a header path. */
  #descend(t: TomlTable, key: string, line: number): TomlTable {
    this.#checkKey(key, line);
    const v = t[key];
    if (v === undefined) {
      const made: TomlTable = Parser.#table();
      t[key] = made;
      return made;
    }
    if (Array.isArray(v) && this.#arrays.has(v)) {
      const last = v[v.length - 1];
      if (isTable(last)) return last;
    }
    if (isTable(v)) {
      if (this.#sealed.has(v)) {
        throw new TomlError(`"${key}" is an inline table and cannot be extended`, line, 1);
      }
      return v;
    }
    throw new TomlError(`"${key}" is not a table`, line, 1);
  }

  // ── key = value ───────────────────────────────────────────────────────
  #assignment(table: TomlTable, scope: string): void {
    const path = this.#keyPath();
    this.#skipInline();
    if (this.#s[this.#i] !== '=') throw this.#err("anahtardan sonra '=' bekleniyor");
    this.#i++;
    this.#skipInline();
    const value = this.#value();

    let t = table;
    for (let k = 0; k < path.length - 1; k++) {
      const key = path[k]!;
      this.#checkKey(key, this.#line);
      const v = t[key];
      if (v === undefined) {
        const made: TomlTable = Parser.#table();
        this.#dottedTables.add(made);
        t[key] = made;
        t = made;
      } else if (
        isTable(v) &&
        (this.#dottedTables.has(v) || this.#headerTables.has(v)) &&
        !this.#sealed.has(v)
      ) {
        t = v;
      } else {
        throw this.#err(`"${path.slice(0, k + 1).join('.')}" is already a different value`);
      }
    }
    const last = path[path.length - 1]!;
    this.#checkKey(last, this.#line);
    const id = `${scope} ${path.join('.')}`;
    if (Object.hasOwn(t, last) || this.#assigned.has(id)) {
      throw this.#err(`"${path.join('.')}" is assigned twice`);
    }
    this.#assigned.add(id);
    t[last] = value;
  }

  #keyPath(): string[] {
    const path: string[] = [];
    for (;;) {
      this.#skipInline();
      const c = this.#s[this.#i];
      if (c === '"') path.push(this.#basicString(false));
      else if (c === "'") path.push(this.#literalString(false));
      else {
        const start = this.#i;
        while (this.#i < this.#s.length && BARE.test(this.#s[this.#i]!)) this.#i++;
        if (this.#i === start) throw this.#err('a key name was expected');
        path.push(this.#s.slice(start, this.#i));
      }
      this.#skipInline();
      if (this.#s[this.#i] === '.') {
        this.#i++;
        continue;
      }
      return path;
    }
  }

  // ── values ────────────────────────────────────────────────────────────
  #value(): TomlValue {
    const c = this.#s[this.#i];
    if (c === '"') return this.#basicString(true);
    if (c === "'") return this.#literalString(true);
    if (c === '[') return this.#array();
    if (c === '{') return this.#inlineTable();
    if (this.#s.startsWith('true', this.#i)) return (this.#i += 4), true;
    if (this.#s.startsWith('false', this.#i)) return (this.#i += 5), false;
    return this.#number();
  }

  #basicString(allowMulti: boolean): string {
    if (allowMulti && this.#s.startsWith('"""', this.#i)) return this.#multiline('"""', true);
    this.#i++;
    let out = '';
    for (;;) {
      const c = this.#s[this.#i];
      if (c === undefined || c === '\n') throw this.#err('unterminated string');
      if (c === '"') {
        this.#i++;
        return out;
      }
      if (c === '\\') {
        out += this.#escape();
        continue;
      }
      out += c;
      this.#i++;
    }
  }

  #escape(): string {
    this.#i++;
    const c = this.#s[this.#i++];
    switch (c) {
      case 'b':
        return '\b';
      case 't':
        return '\t';
      case 'n':
        return '\n';
      case 'f':
        return '\f';
      case 'r':
        return '\r';
      case '"':
        return '"';
      case '\\':
        return '\\';
      case 'u':
        return this.#codepoint(4);
      case 'U':
        return this.#codepoint(8);
      default:
        throw this.#err(`unknown escape sequence: \\${c ?? ''}`);
    }
  }

  #codepoint(len: number): string {
    const hex = this.#s.slice(this.#i, this.#i + len);
    if (hex.length !== len || !/^[0-9A-Fa-f]+$/.test(hex)) {
      throw this.#err('invalid unicode escape');
    }
    this.#i += len;
    return String.fromCodePoint(Number.parseInt(hex, 16));
  }

  #literalString(allowMulti: boolean): string {
    if (allowMulti && this.#s.startsWith("'''", this.#i)) return this.#multiline("'''", false);
    this.#i++;
    const end = this.#s.indexOf("'", this.#i);
    const nl = this.#s.indexOf('\n', this.#i);
    if (end === -1 || (nl !== -1 && nl < end)) throw this.#err('unterminated string');
    const out = this.#s.slice(this.#i, end);
    this.#i = end + 1;
    return out;
  }

  #multiline(delim: string, basic: boolean): string {
    this.#i += 3;
    // A newline immediately after the opening delimiter is not content.
    if (this.#s[this.#i] === '\r' && this.#s[this.#i + 1] === '\n') {
      this.#i += 2;
      this.#newline();
    } else if (this.#s[this.#i] === '\n') {
      this.#i++;
      this.#newline();
    }
    let out = '';
    for (;;) {
      if (this.#i >= this.#s.length) throw this.#err('unterminated multi-line string');
      if (this.#s.startsWith(delim, this.#i)) {
        this.#i += 3;
        // Up to two further delimiter characters belong to the content.
        let extra = 0;
        while (extra < 2 && this.#s[this.#i] === delim[0]) {
          out += delim[0]!;
          this.#i++;
          extra++;
        }
        return out;
      }
      const c = this.#s[this.#i];
      if (basic && c === '\\') {
        const next = this.#s[this.#i + 1];
        if (next === '\n' || next === '\r' || next === ' ' || next === '\t') {
          // Line-ending backslash: swallow the newline and following blanks.
          let j = this.#i + 1;
          while (this.#s[j] === ' ' || this.#s[j] === '\t' || this.#s[j] === '\r') j++;
          if (this.#s[j] !== '\n') {
            throw this.#err('extra characters after a line-ending backslash');
          }
          j++;
          this.#newline();
          while (this.#s[j] === ' ' || this.#s[j] === '\t' || this.#s[j] === '\r' || this.#s[j] === '\n') {
            if (this.#s[j] === '\n') this.#newline();
            j++;
          }
          this.#i = j;
          continue;
        }
        out += this.#escape();
        continue;
      }
      if (c === '\n') this.#newline();
      out += c;
      this.#i++;
    }
  }

  #array(): TomlValue[] {
    this.#i++;
    const out: TomlValue[] = [];
    for (;;) {
      this.#skipTrivia();
      if (this.#s[this.#i] === ']') {
        this.#i++;
        return out;
      }
      if (this.#i >= this.#s.length) throw this.#err('unterminated array');
      out.push(this.#value());
      this.#skipTrivia();
      if (this.#s[this.#i] === ',') {
        this.#i++;
        continue;
      }
      if (this.#s[this.#i] === ']') {
        this.#i++;
        return out;
      }
      throw this.#err("dizide ',' veya ']' bekleniyor");
    }
  }

  #inlineTable(): TomlTable {
    this.#i++;
    const t: TomlTable = Parser.#table();
    const scope = `inline@${this.#i}`;
    this.#skipInline();
    if (this.#s[this.#i] === '}') {
      this.#i++;
      this.#sealed.add(t);
      return t;
    }
    for (;;) {
      this.#skipInline();
      this.#assignment(t, scope);
      this.#skipInline();
      const c = this.#s[this.#i];
      if (c === ',') {
        this.#i++;
        continue;
      }
      if (c === '}') {
        this.#i++;
        this.#sealed.add(t);
        return t;
      }
      throw this.#err("expected ',' or '}' in an inline table");
    }
  }

  #number(): number {
    const start = this.#i;
    if (this.#s[this.#i] === '+' || this.#s[this.#i] === '-') this.#i++;
    if (this.#s.startsWith('inf', this.#i)) {
      this.#i += 3;
      return this.#s[start] === '-' ? -Infinity : Infinity;
    }
    if (this.#s.startsWith('nan', this.#i)) {
      this.#i += 3;
      return NaN;
    }
    const radix =
      this.#s[this.#i] === '0'
        ? ({ x: 16, o: 8, b: 2 } as Record<string, number>)[this.#s[this.#i + 1] ?? '']
        : undefined;
    if (radix) {
      this.#i += 2;
      const from = this.#i;
      while (this.#i < this.#s.length && /[0-9A-Fa-f_]/.test(this.#s[this.#i]!)) this.#i++;
      const digits = this.#s.slice(from, this.#i).replace(/_/g, '');
      const n = Number.parseInt(digits, radix);
      if (!digits || Number.isNaN(n)) throw this.#err('invalid number');
      return this.#s[start] === '-' ? -n : n;
    }
    while (this.#i < this.#s.length && /[0-9_.eE+-]/.test(this.#s[this.#i]!)) {
      // An exponent sign belongs to the number; any other sign ends it.
      const c = this.#s[this.#i];
      if ((c === '+' || c === '-') && !/[eE]/.test(this.#s[this.#i - 1] ?? '')) break;
      this.#i++;
    }
    const text = this.#s.slice(start, this.#i).replace(/_/g, '');
    if (!/^[+-]?[0-9]/.test(text)) {
      throw this.#err(`expected a value, found "${text || this.#s[this.#i] || ''}"`);
    }
    const n = Number(text);
    if (Number.isNaN(n)) throw this.#err(`invalid number: ${text}`);
    return n;
  }
}

function isTable(v: TomlValue | undefined): v is TomlTable {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseToml(text: string): TomlTable {
  return new Parser(text).parse();
}

// ── writing ─────────────────────────────────────────────────────────────

/**
 * Render one value. Used only for the handful of settings `vt init` writes
 * into its commented template — the config file is authored as text so that
 * its comments, which are the reason for choosing TOML, survive.
 */
export function tomlValue(v: TomlValue): string {
  if (typeof v === 'string') return tomlString(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return Number.isNaN(v) ? 'nan' : v > 0 ? 'inf' : '-inf';
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(', ')}]`;
  const pairs = Object.entries(v).map(([k, val]) => `${tomlKey(k)} = ${tomlValue(val)}`);
  return `{ ${pairs.join(', ')} }`;
}

export function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k);
}

function tomlString(s: string): string {
  // Windows paths are the common case and read far better as literal strings
  // than as a wall of doubled backslashes.
  if (!s.includes("'") && !/[\n\r\t]/.test(s)) return `'${s}'`;
  return `"${s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;
}
