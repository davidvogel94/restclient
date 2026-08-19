/**
 * Re-laying-out a response body so its structure is visible.
 *
 * The "pretty" view is about shape first and colour second: a minified payload
 * has to come back indented and broken across lines before highlighting it is
 * worth anything. Formatting is best-effort — anything that will not parse is
 * returned untouched rather than mangled.
 */

const INDENT = '  ';

export function formatJson(text: string, indent: string = INDENT): string {
  try {
    return JSON.stringify(JSON.parse(text), null, indent);
  } catch {
    return text;
  }
}

type XmlToken =
  | { kind: 'open'; text: string; name: string }
  | { kind: 'close'; text: string; name: string }
  | { kind: 'standalone'; text: string }
  | { kind: 'text'; text: string };

/**
 * Scan rather than split on `/<[^>]*>/`: comments and CDATA sections may
 * legitimately contain `>`, and a regex split corrupts them.
 */
function tokenizeXml(src: string): XmlToken[] {
  const out: XmlToken[] = [];
  let i = 0;

  while (i < src.length) {
    if (src[i] !== '<') {
      const next = src.indexOf('<', i);
      const end = next === -1 ? src.length : next;
      const text = src.slice(i, end).trim();
      if (text) { out.push({ kind: 'text', text }); }
      i = end;
      continue;
    }

    let end: number;
    if (src.startsWith('<!--', i)) {
      end = src.indexOf('-->', i);
      end = end === -1 ? src.length : end + 3;
    } else if (src.startsWith('<![CDATA[', i)) {
      end = src.indexOf(']]>', i);
      end = end === -1 ? src.length : end + 3;
    } else {
      end = src.indexOf('>', i);
      end = end === -1 ? src.length : end + 1;
    }

    const tag = src.slice(i, end);
    i = end;

    // Declarations, comments, doctypes and CDATA neither open nor close a level.
    if (/^<[!?]/.test(tag)) { out.push({ kind: 'standalone', text: tag }); continue; }
    if (tag.endsWith('/>')) { out.push({ kind: 'standalone', text: tag }); continue; }
    if (tag.startsWith('</')) {
      out.push({ kind: 'close', text: tag, name: tagName(tag) });
      continue;
    }
    out.push({ kind: 'open', text: tag, name: tagName(tag) });
  }

  return out;
}

function tagName(tag: string): string {
  return /^<\/?\s*([^\s/>]+)/.exec(tag)?.[1] ?? '';
}

export function formatXml(text: string, indent: string = INDENT): string {
  const tokens = tokenizeXml(text);
  // Nothing that looks like markup — leave it alone rather than emit one long line.
  if (!tokens.some((t) => t.kind === 'open' || t.kind === 'standalone')) { return text; }

  const lines: string[] = [];
  let depth = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.kind === 'close') {
      depth = Math.max(0, depth - 1);
      lines.push(indent.repeat(depth) + token.text);
      continue;
    }

    if (token.kind === 'open') {
      // `<name>value</name>` stays on one line; splitting it adds noise, not structure.
      const value = tokens[i + 1];
      const closer = tokens[i + 2];
      if (value?.kind === 'text' && closer?.kind === 'close' && closer.name === token.name) {
        lines.push(indent.repeat(depth) + token.text + value.text + closer.text);
        i += 2;
        continue;
      }
      lines.push(indent.repeat(depth) + token.text);
      depth++;
      continue;
    }

    lines.push(indent.repeat(depth) + token.text);
  }

  return lines.join('\n');
}

/** Format a body for the "pretty" view, given a resolved highlight language. */
export function formatBody(text: string, language: string | undefined): string {
  if (!text.trim()) { return text; }
  switch (language) {
    case 'json': return formatJson(text);
    case 'xml': return formatXml(text);
    default: {
      // An unhelpful or missing content-type is common; if it parses as JSON,
      // the user still wants to see it laid out.
      const formatted = formatJson(text);
      return formatted === text ? text : formatted;
    }
  }
}
