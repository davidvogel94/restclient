import * as vscode from 'vscode';
import { parseEntry, serializeEntry } from './paths';

/**
 * Which Postman files this workspace works on.
 *
 * Collections and environments are edited *in place*, wherever the user keeps
 * them — nothing is copied into the extension's own storage. The list lives in
 * settings rather than hidden workspace state so it can be read, hand-edited
 * and committed alongside the collections it points at.
 */

export const COLLECTIONS_SETTING = 'collections';
export const ENVIRONMENTS_SETTING = 'environments';
const SECTION = 'restclient';

export type RegistryKind = 'collection' | 'environment';

function settingFor(kind: RegistryKind): string {
  return kind === 'collection' ? COLLECTIONS_SETTING : ENVIRONMENTS_SETTING;
}

export class FileRegistry {
  constructor(private readonly workspaceFolder: vscode.WorkspaceFolder | undefined) {}

  private resolve(entry: string): vscode.Uri | undefined {
    const parsed = parseEntry(entry);
    if (parsed.kind === 'absolute') { return vscode.Uri.file(parsed.fsPath); }
    if (parsed.kind === 'relative' && this.workspaceFolder) {
      // Joined onto the folder Uri, not its fsPath, so a remote workspace keeps
      // its scheme.
      return vscode.Uri.joinPath(this.workspaceFolder.uri, ...parsed.segments);
    }
    return undefined;
  }

  private serialize(uri: vscode.Uri): string {
    return serializeEntry(uri.fsPath, this.workspaceFolder?.uri.fsPath);
  }

  private raw(kind: RegistryKind): string[] {
    const configured = vscode.workspace
      .getConfiguration(SECTION, this.workspaceFolder?.uri)
      .get<string[]>(settingFor(kind), []);
    return Array.isArray(configured) ? configured.filter((e) => typeof e === 'string') : [];
  }

  list(kind: RegistryKind): vscode.Uri[] {
    const seen = new Set<string>();
    const out: vscode.Uri[] = [];
    for (const entry of this.raw(kind)) {
      const uri = this.resolve(entry);
      if (!uri || seen.has(uri.fsPath)) { continue; }
      seen.add(uri.fsPath);
      out.push(uri);
    }
    return out;
  }

  has(kind: RegistryKind, uri: vscode.Uri): boolean {
    return this.list(kind).some((u) => u.fsPath === uri.fsPath);
  }

  async add(kind: RegistryKind, uri: vscode.Uri): Promise<void> {
    if (this.has(kind, uri)) { return; }
    await this.write(kind, [...this.raw(kind), this.serialize(uri)]);
  }

  async remove(kind: RegistryKind, uri: vscode.Uri): Promise<void> {
    const next = this.raw(kind).filter((entry) => this.resolve(entry)?.fsPath !== uri.fsPath);
    if (next.length === this.raw(kind).length) { return; }
    await this.write(kind, next);
  }

  private async write(kind: RegistryKind, value: string[]): Promise<void> {
    // Workspace scope keeps the list next to the collections it names; without a
    // folder open there is nowhere workspace-scoped to put it.
    const target = this.workspaceFolder
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await vscode.workspace
      .getConfiguration(SECTION, this.workspaceFolder?.uri)
      .update(settingFor(kind), value, target);
  }

  /** True when a configuration change could have altered either list. */
  static affects(e: vscode.ConfigurationChangeEvent): boolean {
    return (
      e.affectsConfiguration(`${SECTION}.${COLLECTIONS_SETTING}`) ||
      e.affectsConfiguration(`${SECTION}.${ENVIRONMENTS_SETTING}`)
    );
  }
}
