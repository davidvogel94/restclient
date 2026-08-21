import * as vscode from 'vscode';
import type {
  BrokenEntry,
  CollectionStore,
  EnvironmentEntry,
  MissingEntry,
  UnsupportedEntry
} from '../collections/store';
import type { JsonProblem } from '../collections/problems';
import {
  brokenFileItem,
  discoveredNote,
  missingFileItem,
  problemItem,
  unsupportedFileItem
} from './brokenFile';
import { filterVariables, matches, parseFilter, type Filter } from './filter';

/**
 * The Environments view.
 *
 * Environments used to be reachable only through a QuickPick and a webview
 * panel, which made "what is set where" invisible. Here each environment lists
 * its variables inline, so the common jobs — see the active one, check a value,
 * fix a value, spot a secret still sitting in the file — are all one click.
 */

export interface EnvVariable {
  key: string;
  value: string;
  type: string;
  enabled: boolean;
  secret: boolean;
  hasStoredSecret: boolean;
  plaintextInFile: boolean;
}

/** A variable as the file declares it, before the keychain is consulted. */
type DeclaredVariable = Omit<EnvVariable, 'hasStoredSecret' | 'plaintextInFile'>;

export type EnvTreeNode =
  | { kind: 'environment'; entry: EnvironmentEntry; active: boolean }
  | { kind: 'variable'; entry: EnvironmentEntry; variable: EnvVariable }
  // An environment file that would not parse, and one row per problem with it.
  | { kind: 'broken'; entry: BrokenEntry }
  | { kind: 'problem'; entry: BrokenEntry; problem: JsonProblem }
  // A file listed here that this extension cannot read as an environment.
  | { kind: 'unsupported'; entry: UnsupportedEntry }
  // A file `restclient.environments` names that is not on disk.
  | { kind: 'missing'; entry: MissingEntry };

/** Long values are unreadable in a tree row and hide the start of the value. */
const MAX_VALUE = 60;

function summarize(value: string): string {
  const single = value.replace(/\s+/g, ' ').trim();
  return single.length > MAX_VALUE ? `${single.slice(0, MAX_VALUE - 1)}…` : single;
}

/**
 * What the environment file says, in the shape the rows and the filter both
 * want. Whether a secret has a value is a question only the keychain can
 * answer, so that part is added later, per environment the user actually opens.
 */
function declaredVariables(entry: EnvironmentEntry): DeclaredVariable[] {
  return (entry.json.values ?? []).map((v: any) => ({
    key: String(v?.key ?? ''),
    value: typeof v?.value === 'string' ? v.value : String(v?.value ?? ''),
    type: String(v?.type ?? 'default'),
    enabled: v?.enabled !== false,
    secret: v?.type === 'secret'
  }));
}

/**
 * Stable identities for the rows, so the tree can be told to reveal one.
 *
 * `getChildren` rebuilds its nodes on every refresh, and `reveal` is handed a
 * node built from whatever the store holds now. The id is what lets VS Code
 * recognise the two as the same row; the file path identifies an environment
 * even when two of them declare the same `id` internally.
 *
 * The `#filtered` suffix is what lets a filter open the environments it matched:
 * VS Code keeps the expansion it already gave a row id and ignores the state the
 * provider now asks for, so filtered rows have to be different rows.
 */
function environmentRowId(entry: EnvironmentEntry, filtered: boolean): string {
  return `environment:${entry.uri.toString()}${filtered ? '#filtered' : ''}`;
}

function variableRowId(entry: EnvironmentEntry, key: string, filtered: boolean): string {
  return `variable:${entry.uri.toString()}:${key}${filtered ? '#filtered' : ''}`;
}

export class EnvironmentTreeProvider implements vscode.TreeDataProvider<EnvTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<EnvTreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly store: CollectionStore,
    private readonly activeEnvironmentId: () => string | undefined
  ) {
    store.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  // --- filtering ----------------------------------------------------------

  private filter?: Filter;

  /** What the filter box currently holds, or `undefined` when unfiltered. */
  get filterText(): string | undefined {
    return this.filter?.text;
  }

  setFilter(text: string | undefined): void {
    this.filter = parseFilter(text);
    this.refresh();
  }

  /** An environment survives for its own name, or for a variable inside it. */
  private visibleEnvironments(): EnvironmentEntry[] {
    const filter = this.filter;
    if (!filter) { return this.store.environments; }
    return this.store.environments.filter(
      (entry) =>
        matches(filter, entry.name) || filterVariables(declaredVariables(entry), filter).length > 0
    );
  }

  /**
   * An environment's variables as the tree shows them now.
   *
   * A name match keeps every variable: naming the environment is how you ask to
   * see it, and showing two of its ten variables would be a worse answer.
   */
  private visibleVariables(entry: EnvironmentEntry): DeclaredVariable[] {
    const declared = declaredVariables(entry);
    const filter = this.filter;
    if (!filter || matches(filter, entry.name)) { return declared; }
    return filterVariables(declared, filter);
  }

  private visibleBrokenFiles(): BrokenEntry[] {
    const filter = this.filter;
    const broken = this.store.brokenFiles('environment');
    return filter ? broken.filter((entry) => matches(filter, entry.name)) : broken;
  }

  private visibleMissingFiles(): MissingEntry[] {
    const filter = this.filter;
    const missing = this.store.missingFiles('environment');
    return filter ? missing.filter((entry) => matches(filter, entry.name)) : missing;
  }

  /** The line above the tree, which is the only report of what is hidden. */
  filterSummary(): string | undefined {
    const filter = this.filter;
    if (!filter) { return undefined; }

    const environments = this.visibleEnvironments();
    if (!environments.length && !this.visibleBrokenFiles().length && !this.visibleMissingFiles().length) {
      return `Nothing matches "${filter.text}".`;
    }

    const variables = environments.reduce((total, entry) => total + this.visibleVariables(entry).length, 0);
    return (
      `Filtered by "${filter.text}" — ${variables} variable${variables === 1 ? '' : 's'} in ` +
      `${environments.length} environment${environments.length === 1 ? '' : 's'}.`
    );
  }

  /** Would the filter hide this row? Asked before a reveal — see the tree's. */
  hides(element: EnvTreeNode): boolean {
    if (!this.filter) { return false; }
    if (element.kind === 'environment') {
      return !this.visibleEnvironments().some((entry) => entry.uri.toString() === element.entry.uri.toString());
    }
    if (element.kind !== 'variable') { return false; }
    return !this.visibleVariables(element.entry).some((v) => v.key === element.variable.key);
  }

  // --- rows ---------------------------------------------------------------

  getTreeItem(element: EnvTreeNode): vscode.TreeItem {
    switch (element.kind) {
      case 'environment':
        return this.environmentItem(element);
      case 'broken':
        return brokenFileItem(element.entry, 'environmentBroken');
      case 'problem':
        return problemItem(element.entry, element.problem);
      case 'unsupported':
        return unsupportedFileItem(element.entry, 'environmentUnsupported');
      case 'missing':
        return missingFileItem(element.entry, 'environmentMissing');
      default:
        return this.variableItem(element);
    }
  }

  private environmentItem(element: EnvTreeNode & { kind: 'environment' }): vscode.TreeItem {
    const { entry, active } = element;
    const count = (entry.json.values ?? []).length;

    const item = new vscode.TreeItem(
      entry.name,
      active || this.filter
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
    );
    item.id = environmentRowId(entry, Boolean(this.filter));
    // The context value drives which inline actions appear, so active and
    // inactive environments are distinct values rather than one with a flag.
    item.contextValue = active ? 'environmentActive' : 'environment';
    item.iconPath = new vscode.ThemeIcon(
      active ? 'pass-filled' : 'circle-large-outline',
      active ? new vscode.ThemeColor('charts.green') : undefined
    );
    item.description = active
      ? `active · ${count} variable${count === 1 ? '' : 's'}`
      : `${count} variable${count === 1 ? '' : 's'}`;
    item.resourceUri = entry.uri;
    item.tooltip = new vscode.MarkdownString(
      `**${entry.name}**\n\n\`${vscode.workspace.asRelativePath(entry.uri)}\`\n\n` +
        (active
          ? 'Active — variables resolve from here. Use $(circle-slash) to run without an environment.'
          : 'Click to make this the active environment.') +
        discoveredNote(entry.source, 'restclient.environments')
    );
    item.tooltip.supportThemeIcons = true;
    // Clicking an inactive row activates it. The active row deliberately has no
    // click action — deactivating is the inline $(circle-slash), so a stray
    // click on the current environment cannot silently unset it.
    if (!active) {
      item.command = {
        command: 'restclient.setActiveEnvironment',
        title: 'Set as Active Environment',
        arguments: [entry.id]
      };
    }
    return item;
  }

  private variableItem(element: EnvTreeNode & { kind: 'variable' }): vscode.TreeItem {
    const { variable } = element;
    const item = new vscode.TreeItem(variable.key, vscode.TreeItemCollapsibleState.None);
    item.id = variableRowId(element.entry, variable.key, Boolean(this.filter));

    if (variable.secret) {
      item.contextValue = variable.plaintextInFile ? 'variablePlaintextSecret' : 'variableSecret';
      item.description = variable.plaintextInFile
        ? '•••• plaintext in file'
        : variable.hasStoredSecret
          ? '•••• in keychain'
          : 'no value set';
      item.iconPath = new vscode.ThemeIcon(
        variable.plaintextInFile ? 'warning' : 'lock',
        variable.plaintextInFile ? new vscode.ThemeColor('editorWarning.foreground') : undefined
      );
    } else {
      item.contextValue = 'variable';
      item.description = summarize(variable.value) || '(empty)';
      item.iconPath = new vscode.ThemeIcon('symbol-key');
    }

    if (!variable.enabled) {
      item.description = `${item.description} · disabled`;
      item.iconPath = new vscode.ThemeIcon('circle-slash');
    }

    item.tooltip = new vscode.MarkdownString(
      `\`{{${variable.key}}}\` — ${element.entry.name}\n\n` +
        (variable.secret
          ? variable.plaintextInFile
            ? '⚠ Secret stored as plaintext in the environment file.'
            : variable.hasStoredSecret
              ? 'Secret held in the OS keychain.'
              : 'Secret with no value stored yet.'
          : `\`\`\`\n${variable.value || '(empty)'}\n\`\`\``) +
        (variable.enabled ? '' : '\n\nDisabled — this will not resolve.')
    );

    if (!variable.secret) {
      item.command = {
        command: 'restclient.editVariable',
        title: 'Edit value',
        arguments: [element]
      };
    }
    return item;
  }

  /**
   * Required for `reveal`: a variable row only exists once its environment has
   * been expanded, and only the provider knows which environment that is.
   */
  getParent(element: EnvTreeNode): EnvTreeNode | undefined {
    if (element.kind === 'variable') { return this.environmentNode(element.entry); }
    if (element.kind === 'problem') { return { kind: 'broken', entry: element.entry }; }
    return undefined;
  }

  /** The row for an environment, with the active flag `getChildren` would give it. */
  environmentNode(entry: EnvironmentEntry): EnvTreeNode & { kind: 'environment' } {
    return { kind: 'environment', entry, active: entry.id === this.activeEnvironmentId() };
  }

  /**
   * The row for one variable, exactly as `getChildren` builds it.
   *
   * Reveal needs the real node rather than a stand-in: only the keychain can
   * say whether a secret has a value, so the variable's shape is not something
   * a caller holding a key and an environment can reconstruct.
   */
  async variableNode(entry: EnvironmentEntry, key: string): Promise<EnvTreeNode | undefined> {
    const rows = await this.getChildren(this.environmentNode(entry));
    return rows.find((row) => row.kind === 'variable' && row.variable.key === key);
  }

  async getChildren(element?: EnvTreeNode): Promise<EnvTreeNode[]> {
    if (!element) {
      const activeId = this.activeEnvironmentId();
      return [
        ...this.visibleEnvironments().map((entry) => ({
          kind: 'environment' as const,
          entry,
          active: entry.id === activeId
        })),
        ...this.visibleBrokenFiles().map((entry) => ({ kind: 'broken' as const, entry })),
        ...this.store
          .unsupportedFiles('environment')
          .map((entry) => ({ kind: 'unsupported' as const, entry })),
        ...this.visibleMissingFiles().map((entry) => ({ kind: 'missing' as const, entry }))
      ];
    }
    if (element.kind === 'unsupported' || element.kind === 'missing') { return []; }
    if (element.kind === 'broken') {
      return element.entry.problems.map((problem) => ({
        kind: 'problem' as const,
        entry: element.entry,
        problem
      }));
    }
    if (element.kind !== 'environment') { return []; }

    // Whether a secret has a stored value can only be answered by the keychain.
    const stored = await this.store.storedSecretKeys(element.entry.id);
    return this.visibleVariables(element.entry).map((declared) => ({
      kind: 'variable' as const,
      entry: element.entry,
      variable: {
        ...declared,
        hasStoredSecret: declared.secret && stored.has(declared.key),
        plaintextInFile: declared.secret && declared.value !== ''
      }
    }));
  }
}
