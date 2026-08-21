import * as vscode from 'vscode';
import { isInsideAny, parseEntry, rootFor, serializeEntry } from './paths';

/**
 * Where imported collections and environments are copied to.
 *
 * Asked once and remembered, because the answer is a property of the repository
 * rather than of the import: the second collection belongs next to the first,
 * and picking a folder every time is a question with only one answer.
 *
 * The folder has to be inside one of the workspace folders. That is not
 * tidiness — the runner refuses to read files outside them, so a collection
 * kept elsewhere could not read its own request bodies or attachments. Adding
 * the folder to the workspace is what makes it a legitimate destination, and is
 * the supported way to work on collections that live outside the repo.
 */

export const IMPORT_LOCATION_SETTING = 'importLocation';
const SECTION = 'restclient';

export class ImportTarget {
  constructor(
    /** Read, not captured: a folder can be added to a live workspace. */
    private readonly folders: () => readonly vscode.WorkspaceFolder[],
    /** Injectable so prompt-and-remember can be tested without a dialog. */
    private readonly pick: () => Thenable<vscode.Uri | undefined> = () => defaultPick(folders()[0])
  ) {}

  /**
   * The configured folder, if there is one and it is still usable.
   *
   * Each workspace folder can name its own, so the first one that has an answer
   * wins — which in a single-folder workspace is the only one there is, and in
   * a multi-root one is the folder the user put first.
   */
  configured(): vscode.Uri | undefined {
    for (const folder of this.folders()) {
      const found = configuredImportFolder(folder);
      if (found) { return found; }
    }
    return undefined;
  }

  /**
   * The folder to copy into, asking only if there is no answer on file.
   *
   * `undefined` means the user cancelled, or there is no workspace to copy into
   * — the callers already have something to say about the latter.
   */
  async resolve(options: { reask?: boolean } = {}): Promise<vscode.Uri | undefined> {
    const folders = this.folders();
    if (!folders.length) { return undefined; }

    if (!options.reask) {
      const configured = this.configured();
      if (configured) {
        await this.ensure(configured);
        return configured;
      }
    }

    const picked = await this.pick();
    if (!picked) { return undefined; }

    if (!isInsideAny(picked.fsPath, folders.map((f) => f.uri.fsPath))) {
      void vscode.window.showErrorMessage(
        'Imports have to land inside a workspace folder — requests can only read files from one. ' +
          'Add that folder to the workspace first.'
      );
      return undefined;
    }

    await this.remember(picked);
    await this.ensure(picked);
    return picked;
  }

  private async ensure(folder: vscode.Uri): Promise<void> {
    // A no-op when it already exists, which is the usual case.
    await vscode.workspace.fs.createDirectory(folder);
  }

  /**
   * Write the choice down against the workspace folder that contains it.
   *
   * Per-folder, because the setting is per-folder: each root keeps its own
   * imports, and recording folder B's choice in folder A's settings would make
   * the scan widen the wrong tree.
   */
  private async remember(folder: vscode.Uri): Promise<void> {
    const folders = this.folders();
    const root = rootFor(folder.fsPath, folders.map((f) => f.uri.fsPath));
    const owner = folders.find((f) => f.uri.fsPath === root);
    if (!owner) { return; }

    // `serializeEntry` writes the workspace root itself as an absolute path,
    // since an entry naming a *file* cannot be empty. A folder can be the root,
    // and recording it absolute would bake this machine's checkout into a
    // setting that gets committed.
    const value =
      folder.fsPath === owner.uri.fsPath ? '.' : serializeEntry(folder.fsPath, owner.uri.fsPath);
    const target =
      folders.length > 1
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : vscode.ConfigurationTarget.Workspace;
    await vscode.workspace
      .getConfiguration(SECTION, owner.uri)
      .update(IMPORT_LOCATION_SETTING, value, target);
  }
}

function defaultPick(workspaceFolder: vscode.WorkspaceFolder | undefined): Thenable<vscode.Uri | undefined> {
  return vscode.window
    .showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      defaultUri: workspaceFolder?.uri,
      openLabel: 'Import Here',
      title: 'Where should imported Postman files be kept?'
    })
    .then((picked) => picked?.[0]);
}

/**
 * The configured folder for one workspace folder, without the prompting half.
 *
 * The workspace scan needs the same answer — the JSON in that folder is scanned
 * whatever it is named — but must never ask for it: a scan happens on startup
 * and on every settings change, and neither is a moment to open a dialog.
 */
export function configuredImportFolder(
  workspaceFolder: vscode.WorkspaceFolder | undefined
): vscode.Uri | undefined {
  if (!workspaceFolder) { return undefined; }
  const entry = String(
    vscode.workspace
      .getConfiguration(SECTION, workspaceFolder.uri)
      .get<string>(IMPORT_LOCATION_SETTING, '') ?? ''
  ).trim();
  if (!entry) { return undefined; }

  const parsed = parseEntry(entry);
  if (parsed.kind === 'relative') {
    return vscode.Uri.joinPath(workspaceFolder.uri, ...parsed.segments);
  }
  // An absolute setting is honoured only if it is still inside this folder: it
  // may have been configured against a different checkout.
  if (parsed.kind === 'absolute' && isInsideAny(parsed.fsPath, [workspaceFolder.uri.fsPath])) {
    return vscode.Uri.file(parsed.fsPath);
  }
  return undefined;
}
