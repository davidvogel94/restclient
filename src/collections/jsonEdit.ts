import * as jsonc from 'jsonc-parser';

export type JsonPath = Array<string | number>;

export interface JsonEdit {
  path: JsonPath;
  /** `undefined` removes the property or array element. */
  value: unknown;
}

export interface FormatStyle {
  insertSpaces: boolean;
  tabSize: number;
  eol: '\n' | '\r\n';
}

/**
 * Work out how a file is already formatted so edits blend in.
 *
 * Postman exports use tabs; hand-edited files and other tools often use two or
 * four spaces. Guessing wrong would reformat lines we never touched and bury
 * the real change in diff noise.
 */
export function detectFormat(text: string): FormatStyle {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';

  // Look at the first indented line only — nested levels multiply the unit.
  for (const line of text.split(/\r?\n/)) {
    const match = /^([ \t]+)\S/.exec(line);
    if (!match) { continue; }
    const indent = match[1];
    if (indent.startsWith('\t')) { return { insertSpaces: false, tabSize: 1, eol }; }
    return { insertSpaces: true, tabSize: indent.length, eol };
  }

  return { insertSpaces: false, tabSize: 1, eol };
}

/**
 * Apply edits to JSON text, preserving the formatting of everything untouched.
 *
 * jsonc-parser rewrites only the spans that changed, which is the whole point:
 * a collection file stays byte-identical outside the edited value, so git diffs
 * show the actual change and merges behave.
 */
export function applyJsonEdits(text: string, edits: JsonEdit[]): string {
  const format = detectFormat(text);
  const options: jsonc.ModificationOptions = {
    formattingOptions: {
      insertSpaces: format.insertSpaces,
      tabSize: format.tabSize,
      eol: format.eol
    }
  };

  let result = text;
  for (const edit of edits) {
    // Each modify() must see the text produced by the previous one, otherwise
    // offsets computed against stale text corrupt the document.
    const modifications = jsonc.modify(result, edit.path, edit.value, options);
    result = jsonc.applyEdits(result, modifications);
  }
  return result;
}

/** Parse leniently, tolerating trailing commas and comments. */
export function parseJson<T = unknown>(text: string): T {
  const errors: jsonc.ParseError[] = [];
  const value = jsonc.parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) {
    const first = errors[0];
    throw new Error(
      `Invalid JSON at offset ${first.offset}: ${jsonc.printParseErrorCode(first.error)}`
    );
  }
  return value as T;
}

/**
 * Build the edit that inserts `value` at the end of the array at `arrayPath`.
 * jsonc-parser treats index -1 as an append.
 */
export function appendTo(arrayPath: JsonPath, value: unknown): JsonEdit {
  return { path: [...arrayPath, -1], value };
}

/** Build the edit that removes the array element or property at `path`. */
export function removeAt(path: JsonPath): JsonEdit {
  return { path, value: undefined };
}

/**
 * Reorder an array element, expressed as a whole-array replacement.
 *
 * Moving a single element with per-index edits would need N modifications whose
 * offsets invalidate each other, so replacing the array in one edit is both
 * simpler and safer. Formatting outside the array is still preserved.
 */
export function reorder<T>(items: T[], from: number, to: number): T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to > from ? to - 1 : to, 0, moved);
  return next;
}

export interface Replacement {
  startOffset: number;
  endOffset: number;
  text: string;
}

/**
 * Reduce a whole-document rewrite to the smallest span that actually differs.
 *
 * Handing VS Code a full-document replacement would work, but it disturbs the
 * cursor and makes every edit look total in the editor's own diff decorations.
 * Trimming the common prefix and suffix gives a tight, honest edit range.
 * Returns undefined when the texts are identical.
 */
export function minimalReplacement(oldText: string, newText: string): Replacement | undefined {
  if (oldText === newText) { return undefined; }

  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) { prefix++; }

  let suffix = 0;
  const maxSuffix = Math.min(oldText.length - prefix, newText.length - prefix);
  while (
    suffix < maxSuffix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix++;
  }

  return {
    startOffset: prefix,
    endOffset: oldText.length - suffix,
    text: newText.slice(prefix, newText.length - suffix)
  };
}
