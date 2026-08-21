import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import plaintext from 'highlight.js/lib/languages/plaintext';
import xml from 'highlight.js/lib/languages/xml';

/**
 * Tokenising for the webviews.
 *
 * This module is imported by the Svelte apps only. It must never end up in
 * `src/extension.ts`'s import graph, or highlight.js gets bundled into the
 * extension host for nothing.
 *
 * Everything here works on flat offset ranges rather than HTML strings, because
 * `{{variable}}` markers have to be layered on top of language tokens and the
 * two token sets interleave. Rendering to HTML is the last step.
 */

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('plaintext', plaintext);
hljs.registerLanguage('xml', xml);

export type TokenClass =
  | 'str'
  | 'num'
  | 'kw'
  | 'lit'
  | 'cmt'
  | 'prop'
  | 'fn'
  | 'tag'
  | 'attr'
  | 'punct'
  | 'var-ok'
  | 'var-missing'
  | 'var-secret'
  | 'var-dynamic'
  | 'path-ok'
  | 'path-missing'
  /** A search hit. Overlaid on top of everything else, so it always shows. */
  | 'match';

export interface Token {
  start: number;
  end: number;
  cls: TokenClass;
  /** Set on variable tokens: the name between the braces. */
  name?: string;
  /** Set on match tokens: its ordinal in the text, for stepping through hits. */
  index?: number;
}

/**
 * Postman's own pattern, from
 * postman-collection/lib/superstring/index.js:166. The lazy `[^{}]*?` means
 * nested `{{a{{b}}}}` is not a variable — matching Postman exactly, so what we
 * colour is what the runner will substitute.
 */
export const VARIABLE_PATTERN = '\\{\\{([^{}]*?)\\}\\}';

/**
 * Postman's rule for a path variable, from
 * postman-collection/lib/collection/url.js:41: a path *segment* starting with
 * `:`, its name running to the first `.` — so `/:id.json` binds `id` and keeps
 * the extension. Requiring the leading `/` is what keeps the colons of
 * `https://` and `localhost:3000` out of it.
 */
export const PATH_VARIABLE_PATTERN = '/:([^/.?#]+)';

/** Above this, tokenising costs more than the colour is worth. */
const LANGUAGE_LIMIT = 100_000;

const HLJS_CLASS: Record<string, TokenClass> = {
  string: 'str',
  'meta string': 'str',
  subst: 'str',
  regexp: 'str',
  'template-tag': 'str',
  'template-variable': 'str',
  number: 'num',
  literal: 'lit',
  keyword: 'kw',
  built_in: 'kw',
  type: 'kw',
  'meta keyword': 'kw',
  comment: 'cmt',
  doctag: 'cmt',
  quote: 'cmt',
  attr: 'prop',
  'attr-name': 'prop',
  property: 'prop',
  params: 'prop',
  variable: 'prop',
  attribute: 'attr',
  symbol: 'attr',
  selector: 'attr',
  title: 'fn',
  'title function_': 'fn',
  'title class_': 'fn',
  function: 'fn',
  name: 'tag',
  tag: 'tag',
  section: 'tag',
  meta: 'tag',
  punctuation: 'punct',
  operator: 'punct'
};

/** hljs only ever emits these five. */
const ENTITY: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#x27;': "'",
  '&#39;': "'"
};

function decodeEntities(html: string): string {
  return html.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (m) => ENTITY[m] ?? m);
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

/** Collapse runs of the same class that touch, so the DOM stays small. */
function coalesce(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (const token of tokens) {
    if (token.start >= token.end) { continue; }
    const last = out[out.length - 1];
    // Adjacent matches must stay separate, or two hits would count as one.
    if (
      last &&
      last.end === token.start &&
      last.cls === token.cls &&
      last.name === token.name &&
      last.index === undefined &&
      token.index === undefined
    ) {
      last.end = token.end;
    } else {
      out.push({ ...token });
    }
  }
  return out;
}

/**
 * Map every `{{name}}` in `text` to a token, asking `classify` how the name
 * resolves against the environment and collection scopes.
 */
export function variableTokens(
  text: string,
  classify: (name: string) => TokenClass = () => 'var-ok'
): Token[] {
  const re = new RegExp(VARIABLE_PATTERN, 'g');
  const out: Token[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const name = match[1];
    out.push({ start: match.index, end: match.index + match[0].length, cls: classify(name), name });
  }
  return out;
}

/**
 * Map every `:name` path variable in `text` to a token, asking `classify`
 * whether it has a value to substitute.
 *
 * Only the path is scanned: past `?` or `#` a colon is an ordinary character,
 * and postman-collection only ever expands `:name` in path segments.
 *
 * Tokens are deliberately left unnamed — the hover popover is for `{{name}}`
 * variables, which live in the environment; a path variable is edited in the
 * Params tab instead.
 */
export function pathVariableTokens(
  text: string,
  classify: (name: string) => TokenClass = () => 'path-ok'
): Token[] {
  const tail = text.search(/[?#]/);
  const path = tail === -1 ? text : text.slice(0, tail);
  const re = new RegExp(PATH_VARIABLE_PATTERN, 'g');
  const out: Token[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(path)) !== null) {
    // The `/` anchors the match but is not part of the variable.
    out.push({ start: match.index + 1, end: match.index + match[0].length, cls: classify(match[1]) });
  }
  return out;
}

/**
 * Turn highlight.js output back into offset ranges.
 *
 * hljs has no public token API, but its HTML is well-formed, fully escaped and
 * uses nothing but `<span class="...">`, so scanning it is both simple and
 * safe — and keeps this module free of any DOM dependency so it can be unit
 * tested under `node --test`.
 *
 * Returns `[]` rather than guessing whenever the reconstructed text does not
 * match the input exactly: a misaligned overlay is far worse than a plain one.
 */
export function languageTokens(text: string, language: string | undefined): Token[] {
  if (!text || !language || language === 'plaintext') { return []; }
  if (text.length > LANGUAGE_LIMIT) { return []; }
  if (!hljs.getLanguage(language)) { return []; }

  let html: string;
  try {
    html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return [];
  }

  const tokens: Token[] = [];
  const stack: Array<TokenClass | undefined> = [];
  let offset = 0;
  let cursor = 0;

  while (cursor < html.length) {
    const next = html.indexOf('<', cursor);
    const literal = decodeEntities(html.slice(cursor, next === -1 ? html.length : next));
    if (literal) {
      // The innermost recognised class wins: hljs nests, e.g. literal > keyword.
      const cls = [...stack].reverse().find((c) => c !== undefined);
      if (cls) { tokens.push({ start: offset, end: offset + literal.length, cls }); }
      offset += literal.length;
    }
    if (next === -1) { break; }

    const close = html.indexOf('>', next);
    if (close === -1) { return []; }
    const tag = html.slice(next, close + 1);

    if (tag.startsWith('</')) {
      stack.pop();
    } else {
      const name = /class="hljs-([^"]*)"/.exec(tag)?.[1];
      stack.push(name ? HLJS_CLASS[name] : undefined);
    }
    cursor = close + 1;
  }

  if (offset !== text.length || stack.length) { return []; }
  return coalesce(tokens);
}

/**
 * Lay `overlay` tokens over `base`, splitting any base token they cover.
 * Used to put `{{variable}}` markers on top of language tokens.
 */
export function mergeTokens(base: Token[], overlay: Token[]): Token[] {
  if (!overlay.length) { return coalesce([...base].sort((a, b) => a.start - b.start)); }
  const holes = [...overlay].sort((a, b) => a.start - b.start);

  const kept: Token[] = [];
  for (const token of base) {
    let start = token.start;
    for (const hole of holes) {
      if (hole.end <= start || hole.start >= token.end) { continue; }
      if (hole.start > start) { kept.push({ ...token, start, end: hole.start }); }
      start = Math.max(start, hole.end);
    }
    if (start < token.end) { kept.push({ ...token, start, end: token.end }); }
  }

  return coalesce([...kept, ...holes].sort((a, b) => a.start - b.start));
}

/** Escaped HTML for a `<pre>` mirror: one `<span>` per token, plain text between. */
export function renderTokens(text: string, tokens: Token[]): string {
  let html = '';
  let cursor = 0;
  for (const token of tokens) {
    if (token.start < cursor) { continue; }
    if (token.start > cursor) { html += escapeHtml(text.slice(cursor, token.start)); }
    const named = token.name === undefined ? '' : ` data-var="${escapeHtml(token.name).replace(/"/g, '&quot;')}"`;
    const indexed = token.index === undefined ? '' : ` data-match="${token.index}"`;
    html += `<span class="tok-${token.cls}"${named}${indexed}>${escapeHtml(text.slice(token.start, token.end))}</span>`;
    cursor = token.end;
  }
  html += escapeHtml(text.slice(cursor));
  // A <pre> swallows a single trailing newline; keep the mirror as tall as the
  // textarea it sits behind.
  return html.endsWith('\n') ? `${html}\n` : html;
}

/** One-shot: language tokens with variables layered on top. */
export function highlight(
  text: string,
  language: string | undefined,
  classify?: (name: string) => TokenClass
): string {
  return renderTokens(text, mergeTokens(languageTokens(text, language), variableTokens(text, classify)));
}

/** Body-editor language hints (`RAW_LANGUAGES`) to a registered hljs language. */
export function bodyLanguage(hint: string | undefined): string {
  switch (hint) {
    case 'json': return 'json';
    case 'javascript': return 'javascript';
    case 'html':
    case 'xml': return 'xml';
    default: return 'plaintext';
  }
}

/** A response `content-type` to a registered hljs language. */
export function contentTypeLanguage(contentType: string): string {
  const type = contentType.toLowerCase();
  if (/json/.test(type)) { return 'json'; }
  if (/(html|xml|xhtml|svg)/.test(type)) { return 'xml'; }
  if (/javascript|ecmascript/.test(type)) { return 'javascript'; }
  return 'plaintext';
}
