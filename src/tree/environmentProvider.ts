import * as vscode from 'vscode';
import type { CollectionStore, EnvironmentEntry } from '../collections/store';

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

export type EnvTreeNode =
  | { kind: 'environment'; entry: EnvironmentEntry; active: boolean }
  | { kind: 'variable'; entry: EnvironmentEntry; variable: EnvVariable };

/** Long values are unreadable in a tree row and hide the start of the value. */
const MAX_VALUE = 60;

function summarize(value: string): string {
  const single = value.replace(/\s+/g, ' ').trim();
  return single.length > MAX_VALUE ? `${single.slice(0, MAX_VALUE - 1)}…` : single;
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

  getTreeItem(element: EnvTreeNode): vscode.TreeItem {
    return element.kind === 'environment'
      ? this.environmentItem(element)
      : this.variableItem(element);
  }

  private environmentItem(element: EnvTreeNode & { kind: 'environment' }): vscode.TreeItem {
    const { entry, active } = element;
    const count = (entry.json.values ?? []).length;

    const item = new vscode.TreeItem(
      entry.name,
      active ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
    );
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
        (active ? 'Active — variables resolve from here.' : 'Click to make this the active environment.')
    );
    item.command = {
      // Clicking toggles: selecting the active one runs without an environment,
      // which is otherwise buried in the QuickPick.
      command: 'restclient.selectEnvironment',
      title: active ? 'Deactivate' : 'Set as active environment',
      arguments: [active ? '' : entry.id]
    };
    return item;
  }

  private variableItem(element: EnvTreeNode & { kind: 'variable' }): vscode.TreeItem {
    const { variable } = element;
    const item = new vscode.TreeItem(variable.key, vscode.TreeItemCollapsibleState.None);

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

  async getChildren(element?: EnvTreeNode): Promise<EnvTreeNode[]> {
    if (!element) {
      const activeId = this.activeEnvironmentId();
      return this.store.environments.map((entry) => ({
        kind: 'environment' as const,
        entry,
        active: entry.id === activeId
      }));
    }
    if (element.kind !== 'environment') { return []; }

    // Whether a secret has a stored value can only be answered by the keychain.
    const stored = await this.store.storedSecretKeys(element.entry.id);
    return (element.entry.json.values ?? []).map((v: any) => {
      const secret = v?.type === 'secret';
      const value = typeof v?.value === 'string' ? v.value : String(v?.value ?? '');
      return {
        kind: 'variable' as const,
        entry: element.entry,
        variable: {
          key: String(v?.key ?? ''),
          value,
          type: String(v?.type ?? 'default'),
          enabled: v?.enabled !== false,
          secret,
          hasStoredSecret: secret && stored.has(String(v?.key ?? '')),
          plaintextInFile: secret && value !== ''
        }
      };
    });
  }
}
