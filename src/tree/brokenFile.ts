import * as vscode from 'vscode';
import type { BrokenEntry, MissingEntry, UnsupportedEntry } from '../collections/store';
import type { JsonProblem } from '../collections/problems';

/**
 * The rows a tracked file gets when it cannot be worked on.
 *
 * Shared by both views because the trouble is the same one: the Collections
 * and Environments panes differ in what a working file *means*, not in what an
 * unusable one looks like.
 *
 * Two kinds of unusable, and they read differently on purpose. A file that will
 * not parse is an error with positions to jump to. A file in an old Postman
 * format is a warning with an offer attached — nothing is wrong with it, it
 * just needs converting first.
 */

const errorIcon = () => new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'));

/**
 * The tooltip line that says a row is here because the scan found it.
 *
 * Only in the tooltip. With the scan on, most rows are discovered, so a badge
 * on the row itself would mark almost everything and distinguish nothing — but
 * the fact still matters the moment someone wonders why a collection is listed,
 * or where to go to stop working on it.
 */
export function discoveredNote(source: 'registered' | 'discovered', setting: string): string {
  if (source === 'registered') { return ''; }
  return '\n\nFound by the workspace scan \u2014 not listed in `' + setting + '`.';
}

/** `Ln 5, Col 12`, matching the editor's own status bar. */
export function problemPosition(problem: JsonProblem): string | undefined {
  return problem.line === undefined ? undefined : `Ln ${problem.line}, Col ${problem.column}`;
}

/** The file itself: named, expanded, and carrying every problem underneath. */
export function brokenFileItem(entry: BrokenEntry, contextValue: string): vscode.TreeItem {
  const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.Expanded);
  item.contextValue = contextValue;
  item.iconPath = errorIcon();
  item.description = 'invalid JSON';

  const lines = entry.problems.map((p) => {
    const at = problemPosition(p);
    return `- ${p.message}${at ? ` (${at})` : ''}`;
  });
  item.tooltip = new vscode.MarkdownString(
    [
      `**${entry.name}** could not be parsed.`,
      '',
      `\`${vscode.workspace.asRelativePath(entry.uri)}\``,
      '',
      ...lines
    ].join('\n')
  );
  return item;
}

/**
 * A file in a format that has to be converted before it can be edited.
 *
 * The row *is* the action: clicking it offers the conversion, which is the only
 * thing anyone wants from this row. No children, because there is one thing
 * wrong and the description already says it.
 */
export function unsupportedFileItem(entry: UnsupportedEntry, contextValue: string): vscode.TreeItem {
  const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.None);
  item.contextValue = contextValue;
  // A warning, not an error: the file is fine, this extension just cannot read
  // it as it stands.
  item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
  item.description = entry.reason;
  item.resourceUri = entry.uri;

  const location = `\`${vscode.workspace.asRelativePath(entry.uri)}\``;
  item.tooltip = new vscode.MarkdownString(
    entry.convertFrom
      ? [
          `**${entry.name}** is a Postman v${entry.convertFrom} collection.`,
          '',
          location,
          '',
          'Editing requires the v2.1.0 format. Click to convert it.'
        ].join('\n')
      : [`**${entry.name}** is ${entry.reason}.`, '', location].join('\n')
  );

  if (entry.convertFrom) {
    item.command = {
      command: 'restclient.convertCollection',
      title: 'Convert to v2.1.0',
      arguments: [entry.uri, entry.convertFrom]
    };
  }
  return item;
}

/**
 * One problem, which opens the file at exactly the offending token.
 *
 * `vscode.open` rather than a command of our own: it already takes the
 * selection to reveal, and the point of the row is to land the cursor on the
 * character that has to change. A problem with no position — the file could
 * not be read at all — gets no click action, because there is nowhere to go.
 */
export function problemItem(entry: BrokenEntry, problem: JsonProblem): vscode.TreeItem {
  const item = new vscode.TreeItem(problem.message, vscode.TreeItemCollapsibleState.None);
  item.contextValue = 'problem';
  item.iconPath = errorIcon();

  const at = problemPosition(problem);
  item.description = at;
  item.tooltip = at
    ? `${problem.message} — ${vscode.workspace.asRelativePath(entry.uri)}:${problem.line}:${problem.column}`
    : problem.message;

  if (problem.line === undefined || problem.column === undefined) { return item; }

  // Positions are 1-based for display and 0-based for the editor. The end
  // column may overshoot a short line; VS Code clamps it to the line end.
  const line = problem.line - 1;
  const column = problem.column - 1;
  const selection = new vscode.Range(line, column, line, column + (problem.length ?? 0));
  item.command = {
    command: 'vscode.open',
    title: 'Go to Problem',
    arguments: [entry.uri, { selection, preview: false }]
  };
  return item;
}

/**
 * A row for a listed file that is not on disk.
 *
 * Silence was the old behaviour and it was the wrong one: a path in
 * `restclient.collections` that no longer resolves — renamed file, half-done
 * checkout, a setting copied from another repo — produced an empty pane and no
 * account of why. The row exists to name the entry that has to change.
 *
 * Clicking it opens the setting rather than the file, because there is no file:
 * the thing to edit is the list. Dropping the entry is on the context menu, and
 * is the other honest answer.
 */
export function missingFileItem(entry: MissingEntry, contextValue: string): vscode.TreeItem {
  const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.None);
  item.contextValue = contextValue;
  item.iconPath = errorIcon();
  item.description = 'file not found';

  const setting = entry.kind === 'collection' ? 'restclient.collections' : 'restclient.environments';
  item.tooltip = new vscode.MarkdownString(
    [
      `**${entry.name}** is listed but is not on disk.`,
      '',
      `\`${entry.setting}\``,
      '',
      `Fix the path in \`${setting}\`, or stop working on it to drop the entry.`
    ].join('\n')
  );
  item.command = {
    command: 'restclient.openSettings',
    title: 'Open Setting',
    arguments: [setting]
  };
  return item;
}
