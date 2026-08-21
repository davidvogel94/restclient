import * as vscode from 'vscode';
import type {
  BrokenEntry,
  CollectionEntry,
  CollectionStore,
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
import type { ItemNode } from '../collections/model';
import { childArrayPath, locate, moveItem } from '../collections/structure';
import { countRequests, filterItems, matches, parseFilter, type Filter } from './filter';
import { runDetail, runHint } from '../shared/runSummary';
import type { ActiveRuns } from '../runner/runService';
import type { LastRun } from '../panels/runResults';

/** Must be `application/vnd.code.tree.<lowercased view id>`. */
const SELF_MIME = 'application/vnd.code.tree.restclientcollections';

export type TreeNode =
  | { kind: 'collection'; entry: CollectionEntry }
  | { kind: 'item'; entry: CollectionEntry; node: ItemNode }
  // A tracked file that would not parse still gets a row, with one child per
  // problem. `treeNodeArg` rejects both kinds, so no command that expects a
  // loaded collection can be handed one of these by a menu.
  | { kind: 'broken'; entry: BrokenEntry }
  | { kind: 'problem'; entry: BrokenEntry; problem: JsonProblem }
  // A file in a Postman format too old to edit. Rejected by `treeNodeArg` too:
  // there is no loaded collection behind it either.
  | { kind: 'unsupported'; entry: UnsupportedEntry }
  // A file `restclient.collections` names that is not on disk. There is no file
  // at all behind this one, so it is rejected by `treeNodeArg` as well.
  | { kind: 'missing'; entry: MissingEntry };

/** A row with things under it: a collection, or a folder in one. */
type Container = Extract<TreeNode, { kind: 'collection' | 'item' }>;

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

/**
 * A stable identity for a row, so the tree can be told to reveal one.
 *
 * `getChildren` builds fresh node objects on every refresh, and `reveal` is
 * handed a node built from whatever the store holds now — neither is the object
 * VS Code is currently rendering. An explicit id is what ties the two
 * together; without it VS Code falls back to matching on the label, which
 * cannot tell two identically named siblings apart.
 *
 * Broken files and their problems are never reveal targets, so they keep the
 * label-derived handles VS Code generates for a row with no id.
 *
 * Filtered rows get their own ids. A filter opens every container it leaves
 * standing, and VS Code only honours a collapsible state for a row it has not
 * already drawn — same id, same expansion, whatever the provider now says. The
 * suffix makes filtering-on and filtering-off two different sets of rows, which
 * is what lets the matches appear already open.
 */
function nodeId(element: Container, filtered: boolean): string {
  const base = element.kind === 'collection'
    ? `collection:${element.entry.uri.toString()}`
    : `item:${element.entry.uri.toString()}:${element.node.id}`;
  return filtered ? `${base}#filtered` : base;
}

/** The folder holding an item, or `undefined` when it sits at the root. */
function parentOf(nodes: ItemNode[], id: string): ItemNode | undefined {
  for (const node of nodes) {
    if (node.children.some((child) => child.id === id)) { return node; }
    const deeper = parentOf(node.children, id);
    if (deeper) { return deeper; }
  }
  return undefined;
}

/**
 * Where the tree gets each request's last result from.
 *
 * Declared here rather than taken as the request editor's manager: the tree
 * needs two facts about a run and nothing else, and stating that as an
 * interface keeps the dependency pointing one way — and lets a test supply
 * results without opening a webview.
 */
export interface RequestResults {
  readonly onDidChangeResults: vscode.Event<void>;
  lastRun(collectionUri: vscode.Uri, itemId: string): LastRun | undefined;
}

const collapsibleState = (open: boolean): vscode.TreeItemCollapsibleState =>
  open ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;

/**
 * What a container row is, as the menus see it.
 *
 * The `Expanded`/`Collapsed` part is what puts one of the Expand All and
 * Collapse All buttons on the row and not the other, so it has to say which way
 * the row is currently drawn. A row it is withheld from keeps the bare name and
 * so gets neither button — either because there is nothing under it to open, or
 * because everything under it is a request, and opening a single level is what
 * the twistie already does.
 *
 * `Running` is what swaps Run All for Stop. Every other menu entry allows for
 * it, so a run does not empty the row's context menu while it lasts.
 */
const containerContext = (
  kind: 'collection' | 'folder',
  open: boolean,
  toggleable: boolean,
  running: boolean
): string =>
  `${kind}${toggleable ? (open ? 'Expanded' : 'Collapsed') : ''}${running ? 'Running' : ''}`;

/** Failing test names are listed in the tooltip, up to a point. */
const MAX_LISTED_FAILURES = 5;

/**
 * What clicking a collection or folder row does.
 *
 * Its own command rather than `restclient.openOverview`, which the row menu
 * also carries: a click has to be told apart from a menu entry, because only a
 * click opens or shuts the row, and only then when the row was already the
 * selected one.
 */
const ROW_CLICK = (element: Container): vscode.Command => ({
  command: 'restclient.clickRow',
  title: 'Open Overview',
  arguments: [element]
});

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

  constructor(
    private readonly store: CollectionStore,
    /** Omitted by callers that only need the shape of the tree, e.g. tests. */
    private readonly results?: RequestResults,
    /**
     * Runs in flight, which is a different question from results: a container
     * knows nothing of its own, and between two requests of a Run All there is
     * a moment when no single request is running and the run certainly is.
     */
    private readonly runs?: ActiveRuns
  ) {
    store.onDidChange(() => this._onDidChangeTreeData.fire(undefined));
    results?.onDidChangeResults(() => this._onDidChangeTreeData.fire(undefined));
    runs?.onDidChangeRuns(() => this._onDidChangeTreeData.fire(undefined));
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
    // Filtering redraws every row as a new one, and what a row should show is
    // now a different question — a folder the user shut is a folder a match may
    // be hiding in. So the remembered states go, and the defaults answer again.
    this.open.clear();
    this.redraws.clear();
    this.refresh();
  }

  /** The collections a row survives for: a name match, or a match inside. */
  private visibleCollections(): CollectionEntry[] {
    const filter = this.filter;
    if (!filter) { return this.store.collections; }
    return this.store.collections.filter(
      (entry) => matches(filter, entry.name) || filterItems(entry.materialized.tree, filter).length > 0
    );
  }

  /** A collection's items as the tree shows them now. */
  private visibleItems(entry: CollectionEntry): ItemNode[] {
    const filter = this.filter;
    if (!filter || matches(filter, entry.name)) { return entry.materialized.tree; }
    return filterItems(entry.materialized.tree, filter);
  }

  private visibleBrokenFiles(): BrokenEntry[] {
    const filter = this.filter;
    const broken = this.store.brokenFiles('collection');
    return filter ? broken.filter((entry) => matches(filter, entry.name)) : broken;
  }

  private visibleMissingFiles(): MissingEntry[] {
    const filter = this.filter;
    const missing = this.store.missingFiles('collection');
    return filter ? missing.filter((entry) => matches(filter, entry.name)) : missing;
  }

  /** The line above the tree, which is the only report of what is hidden. */
  filterSummary(): string | undefined {
    const filter = this.filter;
    if (!filter) { return undefined; }

    const collections = this.visibleCollections();
    const broken = this.visibleBrokenFiles().length + this.visibleMissingFiles().length;
    if (!collections.length && !broken) {
      return `Nothing matches "${filter.text}".`;
    }

    const requests = collections.reduce((total, entry) => total + countRequests(this.visibleItems(entry)), 0);
    const parts = [
      `${requests} request${requests === 1 ? '' : 's'}`,
      `${collections.length} collection${collections.length === 1 ? '' : 's'}`
    ];
    return `Filtered by "${filter.text}" — ${parts[0]} in ${parts[1]}.`;
  }

  /**
   * Would the filter hide this row?
   *
   * Asked before a reveal. Everything that creates or renames an item then
   * selects it, and a new request called something else entirely is the normal
   * case — so the filter gives way rather than leave the user hunting for a row
   * that was created and never shown.
   */
  hides(element: TreeNode): boolean {
    if (!this.filter) { return false; }
    if (element.kind === 'collection') {
      return !this.visibleCollections().some((entry) => entry.uri.toString() === element.entry.uri.toString());
    }
    if (element.kind !== 'item') { return false; }

    const contains = (nodes: ItemNode[]): boolean =>
      nodes.some((node) => node.id === element.node.id || contains(node.children));
    return !contains(this.visibleItems(element.entry));
  }

  // --- expansion ----------------------------------------------------------

  /**
   * Whether each container row is open, and how many times it has been made to
   * change its mind.
   *
   * The tree is the only thing that knows a row's real state, and it will not
   * say — so the provider keeps its own answer, which the expand and collapse
   * buttons set and the tree's own events keep honest. The count is what makes
   * a programmatic collapse take: VS Code keeps the expansion it has already
   * given a row id, whatever the provider now says, so a state the user asked
   * for only lands if the id changes with it.
   *
   * Keys ignore the filter — this is about a folder, not about a drawing of it.
   */
  private readonly open = new Map<string, boolean>();
  private readonly redraws = new Map<string, number>();

  /** Open by default: a collection, and anything a filter has matched inside. */
  private isOpen(element: Container): boolean {
    return this.open.get(nodeId(element, false)) ?? (element.kind === 'collection' || Boolean(this.filter));
  }

  /** The row id, which carries the redraw count so a new state can take. */
  private rowId(element: Container): string {
    const redraws = this.redraws.get(nodeId(element, false)) ?? 0;
    return `${nodeId(element, Boolean(this.filter))}${redraws ? `#r${redraws}` : ''}`;
  }

  /** Every container under a row, at any depth, the row itself first. */
  private containersFrom(element: Container): Container[] {
    const found: Container[] = [element];
    const walk = (nodes: ItemNode[]): void => {
      for (const node of nodes) {
        if (!node.isFolder) { continue; }
        found.push({ kind: 'item', entry: element.entry, node });
        walk(node.children);
      }
    };
    walk(element.kind === 'collection' ? this.visibleItems(element.entry) : element.node.children);
    return found;
  }

  /**
   * Draw a row and everything under it open or shut — what the expand and
   * collapse buttons do.
   *
   * All the way down, not one level: opening a collection to be shown a list of
   * shut folders is a button that has not answered the question it was pressed
   * for, and shutting one folder of the several a search left standing does not
   * put the tree away.
   *
   * Every affected row needs a new id for its new state to be honoured — VS
   * Code keeps the expansion it has already given an id, whatever the provider
   * now says — so the redraw has to come from above them. It comes from the
   * root: firing at a particular element only works for an element VS Code is
   * holding, and every node object here is rebuilt on each `getChildren`, so
   * the parent handed to the event is never the one the tree has. That is
   * silently ignored rather than refused, which is why aiming at the parent
   * appeared to work for a collection — whose parent is `undefined`, the whole
   * tree — and did nothing at all for a folder. Redrawing the root is cheap,
   * and every row not being toggled keeps its id, and so its state.
   */
  setExpansion(element: Container, open: boolean): void {
    for (const container of this.containersFrom(element)) { this.drawRow(container, open); }
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Whether a row is currently drawn open. */
  isExpanded(element: Container): boolean {
    return this.isOpen(element);
  }

  /**
   * Draw one row open or shut, leaving everything under it as it is.
   *
   * One level, unlike the buttons: this is for a click on the row, which should
   * do what the twistie next to it does. Nothing below needs saying — every row
   * carries its own state under its own id, so the rows inside come back the
   * way the user left them.
   */
  setRowExpansion(element: Container, open: boolean): void {
    if (this.isOpen(element) === open) { return; }
    this.drawRow(element, open);
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Remember a row's state, and give it the new id that state needs. */
  private drawRow(element: Container, open: boolean): void {
    const key = nodeId(element, false);
    this.open.set(key, open);
    this.redraws.set(key, (this.redraws.get(key) ?? 0) + 1);
  }

  /**
   * Record an expansion the tree did itself — a twistie, an arrow key, a click.
   *
   * The row is redrawn under the same id, which is not asking for a state
   * change: the state is already what it is, and what has to catch up is the
   * button, which now offers the wrong one of expand and collapse.
   */
  noteExpansion(element: TreeNode, open: boolean): void {
    if (element.kind !== 'collection' && element.kind !== 'item') { return; }
    const key = nodeId(element, false);
    if (this.open.get(key) === open) { return; }
    this.open.set(key, open);
    this._onDidChangeTreeData.fire(element);
  }

  // --- rows ---------------------------------------------------------------

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.kind === 'broken') { return brokenFileItem(element.entry, 'collectionBroken'); }
    if (element.kind === 'problem') { return problemItem(element.entry, element.problem); }
    if (element.kind === 'unsupported') {
      return unsupportedFileItem(element.entry, 'collectionUnsupported');
    }
    if (element.kind === 'missing') { return missingFileItem(element.entry, 'collectionMissing'); }

    if (element.kind === 'collection') {
      const open = this.isOpen(element);
      const item = new vscode.TreeItem(element.entry.name, collapsibleState(open));
      item.id = this.rowId(element);
      item.contextValue = containerContext(
        'collection',
        open,
        this.visibleItems(element.entry).length > 0,
        this.runs?.runningIn(element.entry.uri) ?? false
      );
      item.iconPath = new vscode.ThemeIcon('folder-library');
      item.resourceUri = element.entry.uri;
      item.tooltip = new vscode.MarkdownString(
        `**${element.entry.name}**\n\n\`${vscode.workspace.asRelativePath(element.entry.uri)}\`` +
          discoveredNote(element.entry.source, 'restclient.collections')
      );
      // A container is a thing in its own right — the auth, variables and
      // scripts everything under it inherits — so clicking it opens its tab as
      // well as expanding the row.
      item.command = ROW_CLICK(element);
      return item;
    }

    const { node } = element;
    if (node.isFolder) {
      // Filtered folders open by default: a match two folders down is not a
      // match the user should have to go clicking for.
      const open = this.isOpen(element);
      const item = new vscode.TreeItem(node.name, collapsibleState(open));
      item.id = this.rowId(element);
      // A folder holding only requests is left without the buttons: All would
      // mean one level, which is the twistie's job, and a button that duplicates
      // the twistie is a button in the way of the name.
      item.contextValue = containerContext(
        'folder',
        open,
        node.children.some((child) => child.isFolder),
        this.runs?.runningIn(element.entry.uri, node.id) ?? false
      );
      item.iconPath = new vscode.ThemeIcon('folder');
      item.command = ROW_CLICK(element);
      return item;
    }

    const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
    item.id = nodeId(element, Boolean(this.filter));
    item.iconPath = new vscode.ThemeIcon(
      'arrow-right',
      new vscode.ThemeColor(METHOD_COLOR[node.method ?? 'GET'] ?? 'charts.foreground')
    );

    // What came back last time, if anything: the method alone stops being the
    // interesting fact about a request the moment you have run it.
    const last = this.results?.lastRun(element.entry.uri, node.id);
    // In flight, so the row offers Stop where Run was. Its own result says so,
    // not the run: a Run All is in flight for every request it will reach, and
    // only one of them is being sent.
    item.contextValue = last?.running ? 'requestRunning' : 'request';
    const hint = runHint(last?.summary, last?.running === true);
    item.description = [node.method, hint].filter(Boolean).join(' · ');
    item.tooltip = this.requestTooltip(node, last);
    item.command = {
      command: 'restclient.openRequest',
      title: 'Open Request',
      arguments: [element]
    };
    return item;
  }

  /**
   * The row's tooltip: the request, then the story of its last run.
   *
   * A failing test's name is the one thing the row itself has no room for and
   * the one thing you need to know, so it goes here in full.
   */
  private requestTooltip(node: ItemNode, last: LastRun | undefined): vscode.MarkdownString | string {
    const heading = `${node.method} ${node.name}`;
    if (!last) { return heading; }

    const lines = last.running
      ? ['Running…']
      : last.summary
        ? runDetail(last.summary, last.failures.slice(0, MAX_LISTED_FAILURES))
        : [];
    if (!lines.length) { return heading; }

    const more = last.failures.length - MAX_LISTED_FAILURES;
    if (more > 0) { lines.push(`…and ${more} more`); }

    // A markdown list, so each line stays a line: a tooltip collapses newlines.
    return new vscode.MarkdownString(
      [`**${heading}**`, '', ...lines.map((line) => `- ${line}`)].join('\n')
    );
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      // Unusable files last: they are the exception, and a file that breaks or
      // needs converting should not reshuffle the collections above it.
      return [
        ...this.visibleCollections().map((entry) => ({ kind: 'collection' as const, entry })),
        ...this.visibleBrokenFiles().map((entry) => ({ kind: 'broken' as const, entry })),
        ...this.store
          .unsupportedFiles('collection')
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
    if (element.kind === 'problem') { return []; }
    if (element.kind === 'collection') {
      return this.visibleItems(element.entry).map((node) => ({ kind: 'item' as const, entry: element.entry, node }));
    }
    // Already pruned: a filtered node carries only the children it survived for.
    return element.node.children.map((node) => ({ kind: 'item' as const, entry: element.entry, node }));
  }

  /**
   * Required for `reveal`: VS Code expands a row's ancestors before selecting
   * it, and only the provider knows what they are.
   */
  getParent(element: TreeNode): TreeNode | undefined {
    if (element.kind === 'problem') { return { kind: 'broken', entry: element.entry }; }
    if (element.kind !== 'item') { return undefined; }
    const folder = parentOf(element.entry.materialized.tree, element.node.id);
    return folder
      ? { kind: 'item', entry: element.entry, node: folder }
      : { kind: 'collection', entry: element.entry };
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

    // A file this extension cannot load cannot be edited into, and its row is
    // only there to be fixed, converted, or found.
    if (
      target?.kind === 'broken' ||
      target?.kind === 'problem' ||
      target?.kind === 'unsupported' ||
      target?.kind === 'missing'
    ) {
      return;
    }

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
      // The real sibling count, not the row's: a filtered folder lists only its
      // matches, and appending after those would land the item mid-folder.
      const folder = entry.materialized.index.get(target.node.id);
      index = (folder ?? target.node).children.length;
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
