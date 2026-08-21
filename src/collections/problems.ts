import * as jsonc from 'jsonc-parser';

/**
 * Locating what is wrong with a tracked file that will not parse.
 *
 * A file the user is working on can be broken at any moment — a bad merge, a
 * hand edit, a truncated download. Dropping it from the tree, which is what
 * happens when a read simply fails, hides both the file and the reason. These
 * problems are what the tree shows instead, so the file stays visible and the
 * fix is one click away.
 *
 * Kept free of runtime `vscode` imports so it can be unit tested without the
 * editor; positions are therefore plain numbers rather than a `Position`.
 */

export interface JsonProblem {
  message: string;
  /** Absent when the file could not be read at all, so there is no position. */
  offset?: number;
  length?: number;
  /** 1-based, the way an editor's status bar counts. */
  line?: number;
  column?: number;
}

/**
 * Readable text for `jsonc-parser`'s error codes.
 *
 * Its own names are internal ("CloseBraceExpected"); these are what the tree
 * row says, so they read as a sentence about the file.
 */
const MESSAGES: Record<string, string> = {
  InvalidSymbol: 'Invalid symbol',
  InvalidNumberFormat: 'Invalid number',
  PropertyNameExpected: 'Expected a property name',
  ValueExpected: 'Expected a value',
  ColonExpected: "Expected ':'",
  CommaExpected: "Expected ','",
  CloseBraceExpected: "Expected '}'",
  CloseBracketExpected: "Expected ']'",
  EndOfFileExpected: 'Expected end of file',
  InvalidCommentToken: 'JSON does not allow comments',
  UnexpectedEndOfComment: 'Unterminated comment',
  UnexpectedEndOfString: 'Unterminated string',
  UnexpectedEndOfNumber: 'Unterminated number',
  InvalidUnicode: 'Invalid unicode escape',
  InvalidEscapeCharacter: 'Invalid escape character',
  InvalidCharacter: 'Invalid character'
};

/**
 * The line and column an offset falls on, both 1-based.
 *
 * Counts `\n`, which also covers CRLF: the `\r` belongs to the line it ends,
 * so a position after it lands on the next line exactly as an editor shows it.
 */
export function positionAt(text: string, offset: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: clamped - lineStart + 1 };
}

/**
 * Everything wrong with a would-be JSON document, in file order.
 *
 * `jsonc-parser` recovers rather than stopping at the first error, so a file
 * with three unclosed braces reports three problems instead of sending the
 * user back for another round. Comments and trailing commas are refused here
 * even though the parser tolerates them by default: these files are read back
 * by `JSON.parse` and by Postman, neither of which accepts either.
 */
export function jsonProblems(text: string): JsonProblem[] {
  const errors: jsonc.ParseError[] = [];
  jsonc.parse(text, errors, { disallowComments: true, allowTrailingComma: false });

  return errors.map((e) => {
    const code = jsonc.printParseErrorCode(e.error);
    const { line, column } = positionAt(text, e.offset);
    return { message: MESSAGES[code] ?? code, offset: e.offset, length: e.length, line, column };
  });
}
