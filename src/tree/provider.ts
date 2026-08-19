import * as vscode from 'vscode';
import type { CollectionEntry, CollectionStore } from '../collections/store';
import type { ItemNode } from '../collections/model';
import { childArrayPath, locate, moveItem } from '../collections/structure';

/** Must be `application/vnd.code.tree.<lowercased view id>`. */
const SELF_MIME = 'application/vnd.code.tree.restclientcollections';

export type TreeNode =
  | { kind: 'collection'; entry: CollectionEntry }
  | { kind: 'item'; entry: CollectionEntry; node: ItemNode };

/** Colour requests by method the way every API client does. */
const METHOD_COLOR: Record<string, string> = {
  GET: 'charts.green',
  POST: 'charts.yellow',
  PUT: 'charts.blue',
  PATCH: 'charts.purple',
  DELETE: 'charts.red',
  HEAD: 'charts.foreground',
  OPTIONS: 'charts.foreground'
};

export class CollectionTreeProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.TreeDragAndDropController<TreeNode>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  // The self-drag type is added to dragMimeTypes automatically, but it must be
  // listed here for the tree to accept its own items. 'files' additionally lets
  // a user drag a .postman_collection.json onto the tree to import it.
  readonly dropMimeTypes = [SELF_MIME, 'files'];
  readonly dragMimeTypes: string[] = [SELF_MIME];

  constructor(private readonly store: CollectionStore) {
    store.onDidChange(() => this._onDidChangeTreeData.fire(undefined));
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.kind === 'collection') {
      const item = new vscode.TreeItem(element.entry.name, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = 'collection';
      item.iconPath = new vscode.ThemeIcon('folder-library');
      item.resourceUri = element.entry.uri;
      item.tooltip = new vscode.MarkdownString(
        `**${element.entry.name}**\n\n\`${vscode.workspace.asRelativePath(element.entry.uri)}\``
      );
      return item;
    }

    const { node } = element;
    if (node.isFolder) {
      const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = 'folder';
      item.iconPath = new vscode.ThemeIcon('folder');
      return item;
    }

    const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'request';
    item.description = node.method;
    item.iconPath = new vscode.ThemeIcon(
      'arrow-right',
      new vscode.ThemeColor(METHOD_COLOR[node.method ?? 'GET'] ?? 'charts.foreground')
    );
    item.tooltip = `${node.method} ${node.name}`;
    item.command = {
      command: 'restclient.openRequest',
      title: 'Open Request',
      arguments: [element]
    };
    return item;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      return this.store.collections.map((entry) => ({ kind: 'collection' as const, entry }));
    }
    if (element.kind === 'collection') {
      return element.entry.materialized.tree.map((node) => ({ kind: 'item' as const, entry: element.entry, node }));
    }
    return element.node.children.map((node) => ({ kind: 'item' as const, entry: element.entry, node }));
  }

  handleDrag(
    source: readonly TreeNode[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): void {
    // Only items move; a whole collection is a file, not a tree position.
    const items = source.filter((n) => n.kind === 'item');
    if (!items.length) { return; }
    dataTransfer.set(
      SELF_MIME,
      new vscode.DataTransferItem(
        items.map((n) => ({
          collection: (n as Extract<TreeNode, { kind: 'item' }>).entry.uri.toString(),
          itemId: (n as Extract<TreeNode, { kind: 'item' }>).node.id
        }))
      )
    );
  }

  async handleDrop(
    target: TreeNode | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const moved = dataTransfer.get(SELF_MIME);
    if (moved) { return this.handleMove(moved.value, target); }

    const files = dataTransfer.get('files');
    const dropped = files?.value as Array<{ uri?: vscode.Uri }> | undefined;
    if (!dropped?.length) { return; }

    for (const file of dropped) {
      if (!file?.uri) { continue; }
      await vscode.commands.executeCommand('restclient.import', file.uri);
    }
  }

  private async handleMove(
    payload: Array<{ collection: string; itemId: string }>,
    target: TreeNode | undefined
  ): Promise<void> {
    if (!Array.isArray(payload) || !payload.length) { return; }
    const { collection: collectionUri, itemId } = payload[0];

    const entry = this.store.collections.find((c) => c.uri.toString() === collectionUri);
    const source = entry?.materialized.index.get(itemId);
    if (!entry || !source) { return; }

    // Moving between files would mean rewriting two documents; keep it in one.
    if (target && target.entry.uri.toString() !== entry.uri.toString()) {
      void vscode.window.showWarningMessage('Requests can only be reordered within their own collection.');
      return;
    }

    let arrayPath: (string | number)[];
    let index: number;

    if (!target || target.kind === 'collection') {
      // Dropped on the collection row or empty space: append to the root.
      arrayPath = childArrayPath(undefined);
      index = (entry.materialized.json.item ?? []).length;
    } else if (target.node.isFolder) {
      arrayPath = childArrayPath(target.node);
      index = target.node.children.length;
    } else {
      // Dropped on a request: land immediately before it.
      const located = locate(target.node);
      arrayPath = located.arrayPath;
      index = located.index;
    }

    const edits = moveItem(entry.materialized.json, source, arrayPath, index);
    if (!edits.length) { return; }
    await this.store.editCollection(entry.uri, edits);
  }
}
