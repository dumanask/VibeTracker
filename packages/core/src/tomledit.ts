/**
 * Narrow, comment-preserving edits to a TOML document.
 *
 * TOML was chosen over JSON precisely so the config could carry comments, so
 * writing a setting by parsing to a value tree and re-serialising would throw
 * away the reason the format was picked. This edits the *text*: it finds the
 * lines that define a key and replaces exactly those, leaving every comment,
 * blank line and bit of hand-formatting where the user put it.
 *
 * The scope is deliberately small — set string and string-array keys inside a
 * named table. It is not a general TOML writer, and it should not become one;
 * the reader in `toml.ts` is the component that has to understand everything.
 */

export type TomlEditValue = string | string[] | boolean;

/** Serialise one value. Only the shapes this module claims to support. */
function serialize(v: TomlEditValue): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return quote(v);
  if (v.length === 0) return '[]';
  return `[${v.map(quote).join(', ')}]`;
}

function quote(s: string): string {
  // Basic strings, with the escapes TOML requires. Project ids and paths are
  // the realistic inputs here, and a Windows path is full of backslashes.
  const body = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${body}"`;
}

/** `[section]` or `[section.sub]`, ignoring surrounding whitespace. */
function headerName(line: string): string | null {
  const m = /^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/.exec(line);
  return m?.[1] ?? null;
}

function keyOnLine(line: string): string | null {
  const m = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
  return m?.[1] ?? null;
}

/**
 * How many lines this key's value occupies.
 *
 * An array may be written across several lines, and replacing only the first
 * of them would leave the remaining elements behind as syntax errors. Bracket
 * depth is counted outside of strings so a `]` inside a quoted path does not
 * end the value early.
 */
function valueSpan(lines: string[], start: number): number {
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    let inString = false;
    let escaped = false;
    for (const ch of lines[i] ?? '') {
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '#') break; // comment runs to end of line
      else if (ch === '[') depth++;
      else if (ch === ']') depth--;
    }
    if (depth <= 0) return i - start + 1;
  }
  return lines.length - start;
}

/**
 * Set keys inside `[section]`, creating the section if it is missing.
 *
 * Keys already present are replaced where they stand, so a commented setting
 * keeps its comment above it. New keys are appended to the end of the
 * section's own lines rather than the end of the file, so they land under the
 * header they belong to instead of silently joining the next table.
 */
export function setTomlValues(
  text: string,
  section: string,
  values: Record<string, TomlEditValue>,
): string {
  const keys = Object.keys(values);
  if (keys.length === 0) return text;

  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);

  let sectionStart = -1;
  let sectionEnd = lines.length; // exclusive
  for (let i = 0; i < lines.length; i++) {
    const name = headerName(lines[i] ?? '');
    if (name === null) continue;
    if (sectionStart === -1 && name === section) {
      sectionStart = i;
    } else if (sectionStart !== -1) {
      sectionEnd = i;
      break;
    }
  }

  if (sectionStart === -1) {
    const body = keys.map((k) => `${k} = ${serialize(values[k] as TomlEditValue)}`);
    const prefix = text.length > 0 && !text.endsWith('\n') ? [''] : [];
    // A blank line before the header keeps the file readable when it is
    // appended to something that did not end with one.
    const tail = [...prefix, '', `[${section}]`, ...body, ''];
    return (text.endsWith('\n') ? text.slice(0, -1) : text) + newline + tail.join(newline);
  }

  const remaining = new Set(keys);
  const out = lines.slice(0, sectionStart + 1);
  let i = sectionStart + 1;
  while (i < sectionEnd) {
    const key = keyOnLine(lines[i] ?? '');
    const span = key === null ? 1 : valueSpan(lines, i);
    if (key !== null && remaining.has(key)) {
      out.push(`${key} = ${serialize(values[key] as TomlEditValue)}`);
      remaining.delete(key);
    } else {
      for (let j = 0; j < span; j++) out.push(lines[i + j] ?? '');
    }
    i += span;
  }

  // Anything not already present goes after the last non-blank line of the
  // section, so trailing blank separators stay between tables.
  if (remaining.size > 0) {
    let insertAt = out.length;
    while (insertAt > sectionStart + 1 && (out[insertAt - 1] ?? '').trim() === '') insertAt--;
    const added = [...remaining].map((k) => `${k} = ${serialize(values[k] as TomlEditValue)}`);
    out.splice(insertAt, 0, ...added);
  }

  return [...out, ...lines.slice(sectionEnd)].join(newline);
}
