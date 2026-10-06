// SPDX-License-Identifier: AGPL-3.0-only
type Scalar = string | number | boolean | null;
export type Metadata = Record<string, Scalar | Scalar[]>;
export interface MarkdownDocument { metadata: Metadata; body: string }
const KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
function scalar(value: unknown): value is Scalar {
  return value === null || typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value));
}
function validValue(value: unknown): value is Scalar | Scalar[] {
  return scalar(value) || (Array.isArray(value) && value.every(scalar));
}
function parseValue(raw: string): Scalar | Scalar[] {
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(text)) throw new SyntaxError('Invalid quoted string');
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (/^(?:["\[{-]|true$|false$|null$|\d)/.test(text)) {
    try { const value: unknown = JSON.parse(text); if (validValue(value)) return value; }
    catch { /* Bare dates and ordinary text are strings; structural YAML remains unsupported. */ }
    if (/^["\[\{]/.test(text)) throw new SyntaxError('Expected JSON string or scalar array');
  }
  if (/^[|>&*!%@`]/.test(text) || /:\s|\s#/.test(text) || text === '~' || text === '-' || text === '?') {
    throw new SyntaxError('Unsupported YAML syntax; quote the value');
  }
  return text;
}
/** Flat YAML subset: scalars and JSON scalar arrays. Markdown body is kept verbatim. */
export function parseMarkdown(source: string): MarkdownDocument {
  const metadata: Metadata = Object.create(null);
  const start = /^(?:\uFEFF)?---\r?\n/.exec(source);
  if (!start) return { metadata, body: source };
  const rest = source.slice(start[0].length);
  const end = /^---(?:\r?\n|$)/m.exec(rest);
  if (!end) throw new SyntaxError('Unterminated frontmatter');
  for (const line of rest.slice(0, end.index).split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
    if (!match) throw new SyntaxError('Only flat frontmatter is supported');
    const key = match[1]!;
    if (Object.hasOwn(metadata, key)) throw new SyntaxError(`Duplicate metadata key: ${key}`);
    metadata[key] = parseValue(match[2] ?? '');
  }
  return { metadata, body: rest.slice(end.index + end[0].length) };
}
export function serializeMarkdown(document: MarkdownDocument): string {
  if (typeof document.body !== 'string' || !document.metadata || typeof document.metadata !== 'object' ||
      Array.isArray(document.metadata)) throw new TypeError('Invalid Markdown document');
  const lines = Object.entries(document.metadata).map(([key, value]) => {
    if (!KEY.test(key) || !validValue(value)) throw new TypeError(`Invalid metadata: ${key}`);
    return `${key}: ${JSON.stringify(value)}`;
  });
  // Always emit a header so a body's leading --- cannot become metadata on the next read.
  return `---\n${lines.length ? lines.join('\n') + '\n' : ''}---\n${document.body}`;
}
