import type { Token } from './highlight';

/**
 * Searching what came back.
 *
 * A response is the one part of this editor the user did not write, so finding
 * the one header, cookie or field they care about is a search problem rather
 * than a reading problem. Everything here works on plain strings and offset
 * ranges — the same currency as `highlight.ts`, so a match can be layered over
 * syntax colouring instead of competing with it — and holds no DOM or Svelte
 * dependency, which keeps it unit testable under `node --test`.
 *
 * Like the tree filter this is deliberately literal: what you type is what is
 * looked for, substring, case-insensitively. The one piece of cleverness is an
 * opt-in regular expression mode, because "which of these 400 fields is a
 * timestamp" is a question a substring cannot ask.
 *
 * Webview-only, like `highlight.ts`: it must never reach `src/extension.ts`.
 */

export interface Range {
  start: number;
  end: number;
}

export interface Matcher {
  /** Exactly what the user typed, for showing back to them. */
  readonly text: string;
  /** Every match in `subject`, in order and non-overlapping. */
  ranges(subject: string): Range[];
  /** Does any of these fields contain a match? Absent fields never match. */
  test(...fields: Array<string | undefined>): boolean;
}

export interface SearchOptions {
  /** Treat the query as a regular expression rather than literal text. */
  regex?: boolean;
  caseSensitive?: boolean;
}

/**
 * A compiled query. `invalid` only happens in regex mode, and carries the
 * engine's own message: a half-typed `[a-` is a normal thing to have in the box
 * for a keystroke or two, and telling the user beats silently matching nothing.
 */
export type Search =
  | { kind: 'empty' }
  | { kind: 'ready'; matcher: Matcher }
  | { kind: 'invalid'; message: string };

/**
 * Ceiling on matches reported for one string. A `.` over a megabyte of JSON is
 * a million spans and a hung webview; nobody navigates a million matches, so
 * counting stops here and the UI says the count is a floor.
 */
export const MATCH_LIMIT = 2000;

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildMatcher(text: string, pattern: RegExp): Matcher {
  return {
    text,
    ranges(subject: string): Range[] {
      const out: Range[] = [];
      if (!subject) { return out; }
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(subject)) !== null) {
        // A pattern that can match nothing (`a*`, `^`) would never advance.
        if (match[0].length === 0) { pattern.lastIndex++; continue; }
        out.push({ start: match.index, end: match.index + match[0].length });
        if (out.length >= MATCH_LIMIT) { break; }
      }
      return out;
    },
    test(...fields: Array<string | undefined>): boolean {
      for (const field of fields) {
        if (!field) { continue; }
        pattern.lastIndex = 0;
        if (pattern.test(field)) { return true; }
      }
      return false;
    }
  };
}

/** `''` is not an error, it is how "no search" is spelled. */
export function compileSearch(text: string | undefined, options: SearchOptions = {}): Search {
  const source = text ?? '';
  if (!source) { return { kind: 'empty' }; }

  const flags = options.caseSensitive ? 'g' : 'gi';
  try {
    return {
      kind: 'ready',
      matcher: buildMatcher(source, new RegExp(options.regex ? source : escapeRegExp(source), flags))
    };
  } catch (err) {
    return { kind: 'invalid', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Matches as highlight tokens, numbered so the view can step through them.
 *
 * Meant to be the *overlay* argument to `mergeTokens`: a match splits whatever
 * syntax token it lands in, so the marker always wins over the colouring.
 */
export function matchTokens(subject: string, matcher: Matcher | undefined): Token[] {
  if (!matcher) { return []; }
  return matcher.ranges(subject).map((range, index) => ({
    start: range.start,
    end: range.end,
    cls: 'match' as const,
    index
  }));
}

/**
 * The text a JSON leaf is displayed as.
 *
 * Search and the tree render from this one function on purpose: matching the
 * value as it appears on screen is the only way a filter cannot hide a row that
 * visibly contains what was typed — and it lets `"42"` find the string where
 * `42` finds the number.
 */
export function jsonLeafText(value: unknown): string {
  if (typeof value === 'string') { return `"${value}"`; }
  if (value === null) { return 'null'; }
  if (value === undefined) { return 'undefined'; }
  return String(value);
}

/**
 * Does this node match, or does anything under it?
 *
 * Used to prune the tree, so a hit deep in a payload keeps its ancestors: a
 * path is how you know what you found. Array indices are positions rather than
 * data and are not searched — otherwise `1` would match most of any array.
 */
export function jsonMatches(matcher: Matcher, value: unknown, name?: string): boolean {
  if (name !== undefined && matcher.test(name)) { return true; }
  if (Array.isArray(value)) {
    return value.some((child) => jsonMatches(matcher, child));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([key, child]) =>
      jsonMatches(matcher, child, key)
    );
  }
  return matcher.test(jsonLeafText(value));
}
