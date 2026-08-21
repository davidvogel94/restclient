<script lang="ts">
  import type {
    FromGroupWebview,
    GroupResult,
    ToGroupWebview
  } from '../../src/panels/collectionPanel';
  import { contentRequests, type GroupView } from '../../src/collections/view';
  import type { EnvironmentSummary, KeyValue } from '../../src/panels/protocol';
  import type { GroupUpdate } from '../../src/collections/edits';
  import { highlight } from '../../src/shared/highlight';
  import { runDetail, testTally } from '../../src/shared/runSummary';
  import KeyValueTable from '../request/KeyValueTable.svelte';
  import HighlightedField from '../shared/HighlightedField.svelte';
  import VariablePopover from '../shared/VariablePopover.svelte';
  import { buildResolver, type VarHover } from '../shared/vars';
  import { filterEntries, parseFilter } from '../../src/tree/filter';

  declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
  const vscode = acquireVsCodeApi();
  const post = (msg: FromGroupWebview) => vscode.postMessage(msg);
  const save = (update: GroupUpdate) => post({ type: 'update', update });

  let view = $state<GroupView | undefined>(undefined);
  let file = $state('');
  let authTypes = $state<readonly string[]>([]);
  let authFields = $state<Record<string, string[]>>({});
  let environments = $state<EnvironmentSummary[]>([]);
  let collectionVariables = $state<KeyValue[]>([]);
  let scriptsAllowed = $state(true);
  let variablesResolve = $state(true);

  let results = $state<GroupResult[]>([]);
  let queued = $state<string[]>([]);
  let running = $state(false);
  let saveError = $state<string | undefined>(undefined);
  let runError = $state<string | undefined>(undefined);

  let tab = $state('contents');

  /**
   * Whether this tab's content is one editor, and so should be stretched to the
   * pane rather than left at its own height.
   *
   * The overview is always a full-height editor tab: on the script and
   * description tabs — where the tab *is* a single field — a field left at its
   * `min-height` is a small box adrift at the top of the window with a resize
   * handle and a screenful of nothing under it. The tabs that hold a table or
   * the contents tree keep their natural heights and scroll.
   */
  const paneFills = $derived(tab === 'pre' || tab === 'tests' || tab === 'about');

  /**
   * Writing to the file triggers a reload, which pushes a fresh `init` back.
   * Landing that mid-edit would wipe what is being typed, so it is parked until
   * focus leaves the control — the same bargain the request editor makes.
   */
  let focusCount = $state(0);
  let pending = $state<GroupView | undefined>(undefined);

  function onfocuschange(focused: boolean) {
    focusCount = Math.max(0, focusCount + (focused ? 1 : -1));
    if (focusCount === 0 && pending) {
      view = pending;
      pending = undefined;
    }
  }

  const activeEnvId = $derived(environments.find((e) => e.active)?.id ?? '');
  const resolver = $derived(buildResolver(environments, collectionVariables));

  /** The inline variable editor; see the request editor for the hover dance. */
  let hover = $state<VarHover | undefined>(undefined);
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  function onvar(hit: VarHover | undefined) {
    clearTimeout(closeTimer);
    if (hit) { hover = hit; }
    else { closeTimer = setTimeout(() => (hover = undefined), 220); }
  }

  const byItem = $derived(new Map(results.map((r) => [r.itemId, r])));
  const queuedSet = $derived(new Set(queued));

  /**
   * Narrowing the contents list, on the same terms as the Collections pane:
   * whitespace-separated words, all of which must appear in a row's name,
   * method or URL. A collection with two hundred requests in it is a list you
   * scroll past rather than read, and the point of this page is seeing a
   * request next to what its last run did.
   *
   * No debounce: the list is a few hundred short rows, not a megabyte of
   * highlighted body, so it can keep up with typing.
   */
  let filterText = $state('');
  let filterBox = $state<HTMLInputElement | undefined>(undefined);
  const filter = $derived(parseFilter(filterText));

  /** The tree as drawn: everything, or only what the filter leaves. */
  const contents = $derived.by(() => {
    const all = view?.contents ?? [];
    return filter ? filterEntries(all, filter) : all;
  });

  /** Requests the filter left visible — the number worth reporting back. */
  const shownRequests = $derived(contentRequests(contents).length);

  /**
   * Which folders are shut. Everything starts open — a folder you have to click
   * to discover is a folder whose failures you do not see — so this only ever
   * holds the ones deliberately closed.
   */
  let shut = $state<Record<string, boolean>>({});

  function toggle(itemId: string) {
    shut = { ...shut, [itemId]: !shut[itemId] };
  }

  function setAll(closed: boolean) {
    const next: Record<string, boolean> = {};
    const walk = (entries: GroupView['contents']) => {
      for (const entry of entries) {
        if (entry.kind !== 'folder') { continue; }
        next[entry.itemId] = closed;
        walk(entry.children);
      }
    };
    walk(view?.contents ?? []);
    shut = next;
  }

  const anyShut = $derived(Object.values(shut).some(Boolean));

  /** One drawn line of the contents tree. */
  interface Row {
    kind: 'request' | 'folder';
    itemId: string;
    name: string;
    depth: number;
    /** Empty for a folder. */
    method: string;
    url: string;
    /** The requests this row stands for: itself, or everything beneath it. */
    requests: string[];
  }

  /**
   * Every request under each folder, taken from the *unfiltered* tree.
   *
   * A folder's play button runs the folder, not the rows a filter happens to
   * have left on screen, so its count and its roll-up have to describe the whole
   * folder — otherwise a filter would quietly turn "3 requests, 1 failed" into
   * "1 request, ok" while the button still runs all three.
   */
  const folderRequests = $derived.by(() => {
    const out = new Map<string, string[]>();
    const walk = (entries: GroupView['contents']) => {
      for (const entry of entries) {
        if (entry.kind !== 'folder') { continue; }
        out.set(entry.itemId, contentRequests(entry.children).map((r) => r.itemId));
        walk(entry.children);
      }
    };
    walk(view?.contents ?? []);
    return out;
  });

  /**
   * The tree as the rows currently visible, rather than a recursive component.
   *
   * Flattening here is what lets the whole thing stay one `<table>`, so the
   * status and test columns line up down the page however deep a row sits.
   */
  const rows = $derived.by(() => {
    const out: Row[] = [];
    const walk = (entries: GroupView['contents'], depth: number) => {
      for (const entry of entries) {
        if (entry.kind === 'request') {
          out.push({
            kind: 'request',
            itemId: entry.itemId,
            name: entry.name,
            depth,
            method: entry.method,
            url: entry.url,
            requests: [entry.itemId]
          });
          continue;
        }
        out.push({
          kind: 'folder',
          itemId: entry.itemId,
          name: entry.name,
          depth,
          method: '',
          url: '',
          requests: folderRequests.get(entry.itemId) ?? []
        });
        // A filter that left a folder standing did so for what is inside it, so
        // being collapsed does not get to hide that.
        if (filter || !shut[entry.itemId]) { walk(entry.children, depth + 1); }
      }
    };
    walk(contents, 0);
    return out;
  });

  /** How the whole group last did, which is the point of a list this long. */
  const totals = $derived.by(() => {
    let ran = 0;
    let failedRequests = 0;
    let passed = 0;
    let failed = 0;
    for (const result of results) {
      const summary = result.summary;
      if (!summary) { continue; }
      ran++;
      passed += summary.passed;
      failed += summary.failed;
      const bad = summary.failure !== undefined || summary.failed > 0 ||
        (summary.code !== undefined && summary.code >= 400);
      if (bad) { failedRequests++; }
    }
    return { ran, failedRequests, passed, failed };
  });

  /**
   * What a folder row says about its contents.
   *
   * A shut folder must not hide a failure, so the roll-up is what the row shows
   * whether it is open or not.
   */
  function rollup(ids: string[]) {
    let ran = 0;
    let bad = 0;
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    let running = 0;

    for (const id of ids) {
      const result = byItem.get(id);
      if (!result) { continue; }
      if (result.running) { running++; }
      const summary = result.summary;
      if (!summary) { continue; }
      ran++;
      passed += summary.passed;
      failed += summary.failed;
      skipped += summary.skipped;
      if (
        summary.failure !== undefined ||
        summary.failed > 0 ||
        (summary.code !== undefined && summary.code >= 400)
      ) {
        bad++;
      }
    }

    return { ran, bad, passed, failed, skipped, running };
  }

  /** Auth params for the selected type, padded out to the full field list. */
  const authRows = $derived.by<KeyValue[]>(() => {
    if (!view) { return []; }
    const fields = authFields[view.auth.type] ?? [];
    if (!fields.length) { return view.auth.params; }
    const existing = new Map(view.auth.params.map((p) => [p.key, p.value]));
    return fields.map((key) => ({ key, value: existing.get(key) ?? '' }));
  });

  function statusClass(code: number): string {
    if (code >= 200 && code < 300) { return 'ok'; }
    if (code >= 300 && code < 400) { return 'warn'; }
    return 'bad';
  }

  /** The tooltip behind a row: the status in full, then the failing tests. */
  function detail(result: GroupResult | undefined): string {
    if (!result) { return 'Not run in this window.'; }
    if (result.running) { return 'Running…'; }
    if (!result.summary) { return 'Not run in this window.'; }
    return runDetail(result.summary, result.failures).join('\n');
  }

  /**
   * Open a request's editor, from anywhere on its row.
   *
   * A drag across a URL to copy it ends in a click, and the request columns are
   * the one place on this page with text worth copying — so a click that leaves
   * a selection behind is taken as the end of that drag, not as opening a tab.
   */
  function openRequest(itemId: string) {
    if (window.getSelection()?.toString()) { return; }
    post({ type: 'openRequest', itemId });
  }

  /** Run everything, or — while a run is going — stop it. */
  function runAll() {
    if (running) { return post({ type: 'cancel' }); }
    runError = undefined;
    post({ type: 'runAll' });
  }

  function apply(next: GroupView) {
    if (focusCount > 0) { pending = next; }
    else { view = next; }
  }

  /**
   * A webview panel has no find widget of its own, so Ctrl/Cmd+F is free — and
   * the request editor already spends it on its search. Here it lands in the
   * contents filter, which means switching to the tab that has one.
   */
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key.toLowerCase() !== 'f' || event.altKey) { return; }
    if (!event.ctrlKey && !event.metaKey) { return; }
    event.preventDefault();
    tab = 'contents';
    // The box only exists once that tab has drawn.
    setTimeout(() => { filterBox?.focus(); filterBox?.select(); }, 0);
  });

  window.addEventListener('message', (event: MessageEvent<ToGroupWebview>) => {
    const msg = event.data;
    switch (msg.type) {
      case 'init':
        apply(msg.view);
        file = msg.file;
        authTypes = msg.authTypes;
        authFields = msg.authFields;
        environments = msg.environments;
        collectionVariables = msg.collectionVariables;
        scriptsAllowed = msg.scriptsAllowed;
        variablesResolve = msg.variablesResolve;
        break;
      case 'results':
        results = msg.results;
        queued = msg.queued;
        running = msg.running;
        break;
      case 'saved':
        saveError = undefined;
        break;
      case 'saveFailed':
        saveError = msg.message;
        break;
      case 'runFailed':
        runError = msg.message;
        break;
    }
  });

  post({ type: 'ready' });
</script>

{#if !view}
  <div class="empty">Loading…</div>
{:else}
  <div class="layout">
   <div class="sheet">
    <div class="crumbs">
      <span>{view.collectionName}</span>
      {#each view.path as segment}
        <span class="sep">›</span><span>{segment}</span>
      {/each}
      {#if view.kind === 'folder'}
        <span class="sep">›</span><span>{view.name}</span>
      {/if}
      <span class="sep">›</span>
      <span class="muted">{file}</span>
      <button class="icon" title="Open the collection JSON" onclick={() => post({ type: 'revealInFile' })}>
        <span class="codicon codicon-json"></span>
      </button>
    </div>

    <div class="grouphead">
      <div class="title">
        <input
          class="groupname"
          value={view.name}
          aria-label={view.kind === 'folder' ? 'Folder name' : 'Collection name'}
          onfocus={() => onfocuschange(true)}
          onblur={(e) => {
            onfocuschange(false);
            const value = (e.currentTarget as HTMLInputElement).value.trim();
            if (value && value !== view!.name) { save({ field: 'name', value }); }
          }}
        />
        <div class="tally">
          <span>
            {view.requests} request{view.requests === 1 ? '' : 's'}
            {#if view.folders}· {view.folders} folder{view.folders === 1 ? '' : 's'}{/if}
          </span>
          {#if totals.ran}
            <span class:fail={totals.failedRequests > 0} class:pass={totals.failedRequests === 0}>
              {totals.ran} run{totals.failedRequests ? `, ${totals.failedRequests} with problems` : ''}
            </span>
          {/if}
          {#if totals.passed + totals.failed}
            <span class:fail={totals.failed > 0} class:pass={totals.failed === 0}>
              {totals.passed} test{totals.passed === 1 ? '' : 's'} passed{totals.failed
                ? `, ${totals.failed} failed`
                : ''}
            </span>
          {/if}
        </div>
      </div>

      <div class="groupactions">
        <select
          value={activeEnvId}
          title="Active environment"
          onchange={(e) =>
            post({
              type: 'selectEnvironment',
              environmentId: (e.currentTarget as HTMLSelectElement).value
            })}
        >
          <option value="">No environment</option>
          {#each environments as env}<option value={env.id}>{env.name}</option>{/each}
        </select>

        <button
          class:stop={running}
          disabled={!running && !view.requests}
          title={running
            ? 'Stop the run'
            : `Run all ${view.requests} request(s) in order, with this ${view.kind}'s scripts`}
          onclick={runAll}
        >
          {#if running}<span class="codicon codicon-debug-stop"></span>{/if}
          {running ? 'Stop' : 'Run All'}
        </button>
      </div>
    </div>

    {#if !scriptsAllowed}
      <div class="banner">
        This workspace is not trusted, so pre-request and test scripts will not run.
        Trust the workspace to enable them.
      </div>
    {/if}
    {#if saveError}
      <div class="banner error">Could not save: {saveError}</div>
    {/if}
    {#if runError}
      <div class="banner error">{runError}</div>
    {/if}

    <div class="tabs">
      <button class="tab" class:active={tab === 'contents'} onclick={() => (tab = 'contents')}>
        Contents<span class="count">{view.requests}</span>
      </button>
      <button class="tab" class:active={tab === 'auth'} onclick={() => (tab = 'auth')}>
        Auth<span class="count">{view.auth.type}</span>
      </button>
      <button class="tab" class:active={tab === 'variables'} onclick={() => (tab = 'variables')}>
        Variables<span class="count">{view.variables.length}</span>
      </button>
      <button class="tab" class:active={tab === 'pre'} onclick={() => (tab = 'pre')}>
        Pre-request{#if view.scripts.prerequest}<span class="count">●</span>{/if}
      </button>
      <button class="tab" class:active={tab === 'tests'} onclick={() => (tab = 'tests')}>
        Tests{#if view.scripts.test}<span class="count">●</span>{/if}
      </button>
      <button class="tab" class:active={tab === 'about'} onclick={() => (tab = 'about')}>
        Description
      </button>
    </div>

    <div class="pane" class:fill={paneFills}>
      {#if tab === 'contents'}
        {#if !view.requests}
          <div class="empty">
            No requests in this {view.kind} yet. Add one from the Collections pane.
          </div>
        {:else}
          <div class="treebar">
            <span class="codicon codicon-filter"></span>
            <input
              bind:this={filterBox}
              bind:value={filterText}
              class="searchbox"
              type="text"
              spellcheck="false"
              aria-label="Filter these requests"
              placeholder="Filter by name, method or URL — all words must match"
              onkeydown={(e) => {
                if (e.key === 'Escape' && filterText) {
                  e.stopPropagation();
                  filterText = '';
                }
              }}
            />
            {#if filterText}
              <button class="icon" title="Clear the filter (Esc)" onclick={() => (filterText = '')}>
                <span class="codicon codicon-close"></span>
              </button>
              <span class="searchnote muted">{shownRequests} of {view.requests}</span>
            {/if}
            {#if view.folders && !filter}
              <button class="icon" title={anyShut ? 'Expand all folders' : 'Collapse all folders'} onclick={() => setAll(!anyShut)}>
                <span class="codicon {anyShut ? 'codicon-expand-all' : 'codicon-collapse-all'}"></span>
              </button>
            {/if}
          </div>
          {#if !rows.length}
            <div class="empty">Nothing here matches “{filterText}”.</div>
          {:else}
            <table class="contents">
              <thead>
                <tr>
                  <th class="run"></th>
                  <th class="detail">Request</th>
                  <th class="status">Status</th>
                  <th class="tests">Tests</th>
                </tr>
              </thead>
              <tbody>
                {#each rows as row (row.itemId)}
                  {#if row.kind === 'folder'}
                    {@const roll = rollup(row.requests)}
                    <tr class="folderrow">
                      <td class="run">
                        <button
                          class="icon"
                          class:stop={roll.running}
                          disabled={running && !roll.running}
                          title={roll.running
                            ? 'Stop the run'
                            : running
                              ? 'A run is already in progress'
                              : `Run the ${row.requests.length} request(s) in ${row.name}`}
                          onclick={() => {
                            if (roll.running) { return post({ type: 'cancel', itemId: row.itemId }); }
                            runError = undefined;
                            post({ type: 'runItem', itemId: row.itemId });
                          }}
                        >
                          <span class="codicon codicon-{roll.running ? 'debug-stop' : 'play'}"></span>
                        </button>
                      </td>

                      <td class="detail" style="--depth: {row.depth}">
                        <button
                          class="foldername"
                          aria-expanded={!shut[row.itemId]}
                          title={shut[row.itemId] ? `Show what is in ${row.name}` : `Hide what is in ${row.name}`}
                          onclick={() => toggle(row.itemId)}
                        >
                          <span
                            class="codicon {shut[row.itemId] ? 'codicon-chevron-right' : 'codicon-chevron-down'}"
                          ></span>
                          <span class="codicon codicon-folder"></span>
                          <span class="fname">{row.name}</span>
                          <span class="fcount">
                            {row.requests.length} request{row.requests.length === 1 ? '' : 's'}
                          </span>
                        </button>
                      </td>

                      <td class="status">
                        {#if roll.running}
                          <span class="muted"><span class="codicon codicon-sync spin"></span> running</span>
                        {:else if roll.ran}
                          <span class="pill {roll.bad ? 'bad' : 'ok'}">
                            {roll.bad ? `${roll.bad}/${roll.ran} failed` : `${roll.ran} ok`}
                          </span>
                        {:else}
                          <span class="never">—</span>
                        {/if}
                      </td>

                      <td class="tests">
                        {#if roll.passed + roll.failed + roll.skipped}
                          <span class:pass={roll.failed === 0} class:fail={roll.failed > 0}>
                            {roll.failed
                              ? `✗ ${roll.failed}/${roll.passed + roll.failed + roll.skipped}`
                              : `✓ ${roll.passed}`}
                          </span>
                        {:else}
                          <span class="never">—</span>
                        {/if}
                      </td>
                    </tr>
                  {:else}
                    {@const result = byItem.get(row.itemId)}
                    <!--
                      The whole row opens the request, not just its name: the
                      name is a few characters wide in a row the width of the
                      page, and everything else on the row — the method, the
                      URL, the status, the tests — is about that one request too.

                      The name stays a real button, so the keyboard path and the
                      accessible name are unchanged; this is the pointer
                      shortcut on top of it. Giving the row a role of its own
                      would only add a second tab stop for the same command,
                      which is why the a11y warnings below are answered rather
                      than obeyed.
                    -->
                    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                    <tr
                      class="reqrow"
                      class:active={result?.running}
                      onclick={() => openRequest(row.itemId)}
                    >
                      <td class="run">
                        <button
                          class="icon"
                          class:stop={result?.running}
                          disabled={running && !result?.running}
                          title={result?.running
                            ? 'Stop the run'
                            : running
                              ? 'A run is already in progress'
                              : `Run ${row.name}`}
                          onclick={(e) => {
                            // The row opens the request; this button does not.
                            e.stopPropagation();
                            if (result?.running) { return post({ type: 'cancel', itemId: row.itemId }); }
                            runError = undefined;
                            post({ type: 'runItem', itemId: row.itemId });
                          }}
                        >
                          <span class="codicon codicon-{result?.running ? 'debug-stop' : 'play'}"></span>
                        </button>
                      </td>

                      <td class="detail" title={detail(result)} style="--depth: {row.depth}">
                        <div class="reqbody">
                          <div class="reqline">
                            <span class="verb" data-method={row.method}>{row.method}</span>
                            <button
                              class="reqname"
                              onclick={(e) => {
                                e.stopPropagation();
                                openRequest(row.itemId);
                              }}
                            >
                              {row.name}
                            </button>
                          </div>
                          {#if row.url}
                            <div class="requrl">{row.url}</div>
                          {/if}
                        </div>
                      </td>

                      <td class="status" title={detail(result)}>
                        {#if result?.running}
                          <span class="muted"><span class="codicon codicon-sync spin"></span> running</span>
                        {:else if queuedSet.has(row.itemId)}
                          <span class="queued">queued</span>
                        {:else if result?.summary?.code !== undefined}
                          <span class="pill {statusClass(result.summary.code)}">{result.summary.code}</span>
                        {:else if result?.summary?.failure}
                          <span class="pill bad">failed</span>
                        {:else}
                          <span class="never">—</span>
                        {/if}
                      </td>

                      <td class="tests" title={detail(result)}>
                        {#if result?.summary}
                          {@const tally = testTally(result.summary)}
                          {#if tally}
                            <span class:pass={result.summary.failed === 0} class:fail={result.summary.failed > 0}>
                              {tally}
                            </span>
                          {:else}
                            <span class="never">—</span>
                          {/if}
                        {:else}
                          <span class="never">—</span>
                        {/if}
                      </td>
                    </tr>
                  {/if}
                {/each}
              </tbody>
            </table>
          {/if}
        {/if}

      {:else if tab === 'auth'}
        <div class="section-title">
          <label class="inline">
            Type
            <select
              value={view.auth.type === 'none' ? (view.kind === 'folder' ? 'inherit' : 'noauth') : view.auth.type}
              onchange={(e) =>
                save({
                  field: 'auth',
                  authType: (e.currentTarget as HTMLSelectElement).value,
                  rows: []
                })}
            >
              {#each authTypes as type}
                <option value={type}>{type === 'inherit' ? 'Inherit from parent' : type}</option>
              {/each}
            </select>
          </label>
          {#if view.auth.inheritedFrom}
            <span class="muted">— currently inherited from {view.auth.inheritedFrom}</span>
          {/if}
        </div>
        <p class="note">
          Every request in this {view.kind} uses this unless it sets its own.
        </p>
        {#key view.auth.type}
          <KeyValueTable
            rows={authRows}
            editable={view.auth.type !== 'none' && view.auth.type !== 'noauth'}
            {resolver}
            {onfocuschange}
            {onvar}
            empty={view.kind === 'folder'
              ? 'This folder adds no authentication of its own.'
              : 'This collection sets no default authentication.'}
            onchange={(rows) => save({ field: 'auth', authType: view!.auth.type, rows })}
          />
        {/key}

      {:else if tab === 'variables'}
        <p class="note">
          {#if variablesResolve}
            Resolved after the environment, so an environment variable of the same name wins.
          {:else}
            Stored in the collection file, but Postman resolves variables at collection scope
            only — move one to the collection to have it apply during a run.
          {/if}
        </p>
        <KeyValueTable
          rows={view.variables}
          editable
          {resolver}
          {onfocuschange}
          {onvar}
          empty="No variables defined here."
          onchange={(rows) => save({ field: 'variables', rows })}
        />

      {:else if tab === 'pre' || tab === 'tests'}
        {@const listen = tab === 'pre' ? 'prerequest' : 'test'}
        {@const source = (tab === 'pre' ? view.scripts.prerequest : view.scripts.test) ?? ''}
        <p class="note">
          Runs {listen === 'prerequest' ? 'before' : 'after'} every request in this {view.kind}.
        </p>
        {#key (view.itemId ?? '') + listen}
          <HighlightedField
            multiline
            fieldClass="code tall grow"
            language="javascript"
            placeholder={listen === 'prerequest'
              ? "pm.environment.set('token', '…');"
              : "pm.test('status is ok', function () {\n  pm.response.to.be.success;\n});"}
            value={source}
            {resolver}
            {onvar}
            {onfocuschange}
            oncommit={(next) => save({ field: 'script', listen, source: next })}
          />
        {/key}
        {#each view.inheritedScripts.filter((s) => s.listen === listen) as script}
          <div class="section-title">Also runs — from {script.from} (edit it there)</div>
          <pre>{@html highlight(script.source, 'javascript', resolver.classify)}</pre>
        {/each}

      {:else if tab === 'about'}
        <p class="note">Shown in Postman and in generated documentation. Markdown is allowed.</p>
        {#key view.itemId ?? ''}
          <HighlightedField
            multiline
            fieldClass="code grow"
            value={view.description}
            {resolver}
            {onvar}
            {onfocuschange}
            placeholder="What this {view.kind} is for."
            oncommit={(value) => save({ field: 'description', value })}
          />
        {/key}
      {/if}
    </div>

    {#if hover}
      <VariablePopover
        name={hover.name}
        rect={hover.rect}
        {resolver}
        onsave={(scope, key, value) => post({ type: 'setVariable', scope, key, value })}
        onmovesecret={(key) => post({ type: 'moveSecretToKeychain', key })}
        oneditenvironment={() => post({ type: 'editEnvironment' })}
        onkeepalive={() => clearTimeout(closeTimer)}
        onclose={() => (hover = undefined)}
      />
    {/if}
   </div>
  </div>
{/if}
