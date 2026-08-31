<script lang="ts">
  import type {
    ConsoleLine,
    EnvironmentSummary,
    FromWebview,
    KeyValue,
    RequestView,
    ResponseViewState,
    ToWebview
  } from '../../src/panels/protocol';
  import type { RequestUpdate } from '../../src/collections/edits';
  import type { SerializedAssertion, SerializedRequest, SerializedResponse } from '../../src/runner/protocol';
  import {
    bodyLanguage,
    contentTypeLanguage,
    highlight,
    languageTokens,
    mergeTokens,
    renderTokens,
    variableTokens,
    type TokenClass
  } from '../../src/shared/highlight';
  import {
    compileSearch,
    jsonMatches,
    matchTokens,
    MATCH_LIMIT,
    type Matcher
  } from '../../src/shared/search';
  import { formatBody } from '../../src/shared/format';
  import {
    effectiveMediaType,
    isOpaqueMedia,
    mediaType,
    previewKind,
    type PreviewKind
  } from '../../src/shared/media';
  import KeyValueTable from './KeyValueTable.svelte';
  import SettingsTab from './SettingsTab.svelte';
  import HighlightedField from '../shared/HighlightedField.svelte';
  import VariablePopover from '../shared/VariablePopover.svelte';
  import JsonTree from '../shared/JsonTree.svelte';
  import { buildResolver, type VarHover } from '../shared/vars';
  import type { SettingValue } from '../../src/collections/settings';

  declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
  const vscode = acquireVsCodeApi();
  const post = (msg: FromWebview) => vscode.postMessage(msg);
  const save = (update: RequestUpdate) => post({ type: 'update', update });

  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  const BODY_MODES = ['none', 'raw', 'graphql', 'urlencoded', 'formdata', 'file'];
  const RAW_LANGUAGES = ['json', 'text', 'javascript', 'html', 'xml'];
  /** Body renderings, in the order they sit in the segmented control. */
  const BODY_VIEWS = ['pretty', 'raw', 'preview', 'tree'] as const;
  type BodyView = (typeof BODY_VIEWS)[number];
  /** Response tabs that are always there, so always safe to reopen on. */
  const RES_TABS = ['body', 'headers', 'cookies', 'tests', 'console', 'sent'];

  let request = $state<RequestView | undefined>(undefined);
  let environments = $state<EnvironmentSummary[]>([]);
  let collectionVariables = $state<KeyValue[]>([]);
  let scriptsAllowed = $state(true);
  let authTypes = $state<readonly string[]>([]);
  let authFields = $state<Record<string, string[]>>({});
  let settingDefaults = $state<Record<string, SettingValue>>({});

  let running = $state(false);
  let response = $state<SerializedResponse | undefined>(undefined);
  let sentRequest = $state<SerializedRequest | undefined>(undefined);
  let assertions = $state<SerializedAssertion[]>([]);
  let consoleLines = $state<ConsoleLine[]>([]);
  let visualizerHtml = $state<string | undefined>(undefined);
  let failure = $state<string | undefined>(undefined);
  let saveError = $state<string | undefined>(undefined);

  let reqTab = $state('params');
  let resTab = $state('body');
  /** How the response body is rendered — the preference, not always the view. */
  let resView = $state<BodyView>('pretty');
  let wrap = $state(true);

  /**
   * Whether the preview on screen is one nobody asked for.
   *
   * A picture or a sound has no reading as text, so it opens in the preview
   * whatever the remembered preference says. Clicking any segment is the user
   * saying otherwise, and it holds until the next response arrives.
   */
  let previewedAutomatically = $state(true);

  /**
   * Searching the response.
   *
   * One query across every response tab rather than one per tab: "where does
   * this token appear" is a question about the whole exchange, and the tab
   * counts turn into `matched/total` so the answer is visible without opening
   * each one. Rows filter, text highlights and steps.
   */
  let query = $state('');
  /**
   * What the views are actually searching for. A keystroke re-renders the whole
   * response — a megabyte of highlighted body included — so the box runs ahead
   * of the search by a beat rather than repainting on every letter.
   */
  let appliedQuery = $state('');
  let searchRegex = $state(false);
  let searchCase = $state(false);
  let searchBox = $state<HTMLInputElement | undefined>(undefined);
  /** The block the step buttons walk: whichever body view is on screen. */
  let matchHost = $state<HTMLElement | undefined>(undefined);
  let currentMatch = $state(0);

  $effect(() => {
    const next = query;
    // Clearing is instant: nobody waits to see the response come back whole.
    if (!next) { appliedQuery = ''; return; }
    const timer = setTimeout(() => (appliedQuery = next), 120);
    return () => clearTimeout(timer);
  });

  const search = $derived(
    compileSearch(appliedQuery, { regex: searchRegex, caseSensitive: searchCase })
  );
  const matcher = $derived<Matcher | undefined>(
    search.kind === 'ready' ? search.matcher : undefined
  );

  /**
   * Writing to the file triggers a reload, which pushes a fresh `init` back.
   * If that lands while the user is mid-edit it would wipe what they are typing,
   * so incoming state is parked until focus leaves the control.
   */
  let focusCount = $state(0);
  let pending = $state<RequestView | undefined>(undefined);

  function onfocuschange(focused: boolean) {
    focusCount = Math.max(0, focusCount + (focused ? 1 : -1));
    if (focusCount === 0 && pending) {
      request = pending;
      pending = undefined;
    }
  }

  const activeEnvId = $derived(environments.find((e) => e.active)?.id ?? '');

  const resolver = $derived(buildResolver(environments, collectionVariables));

  /**
   * Colouring for `:name` segments of the URL. A path variable is only
   * substituted when it has a value (postman-collection's `Url#getPath`), so an
   * empty one is flagged the way a missing `{{variable}}` is.
   */
  const pathClassify = $derived(
    (name: string): TokenClass =>
      request?.pathVariables.some((v) => v.key === name && v.value) ? 'path-ok' : 'path-missing'
  );

  /**
   * The inline variable editor. Hovering a token opens it; it survives a short
   * gap so the pointer can travel from the token into the popover itself.
   */
  let hover = $state<VarHover | undefined>(undefined);
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  function onvar(hit: VarHover | undefined) {
    clearTimeout(closeTimer);
    if (hit) { hover = hit; }
    else { closeTimer = setTimeout(() => (hover = undefined), 220); }
  }

  function setVariable(scope: 'environment' | 'collection', key: string, value: string) {
    post({ type: 'setVariable', scope, key, value });
  }

  /**
   * The host's file dialog, as a promise.
   *
   * Only the extension host can show one, so the reply comes back as a message;
   * the token pairs it with the field that asked. Resolves undefined when the
   * dialog was cancelled or the file was rejected.
   */
  const pickWaiters = new Map<string, (path: string | undefined) => void>();
  let pickCount = 0;

  function pickFile(): Promise<string | undefined> {
    const token = `pick${++pickCount}`;
    post({ type: 'pickFile', token });
    return new Promise((resolve) => pickWaiters.set(token, resolve));
  }

  /**
   * The body as it came back, before anything decides what it is.
   *
   * `undefined` means the base64 would not decode, which is a broken result
   * rather than an empty one and has to read differently on screen.
   */
  const bodyBytes = $derived.by<Uint8Array | undefined>(() => {
    if (!response) { return new Uint8Array(); }
    try {
      const bin = atob(response.bodyBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) { bytes[i] = bin.charCodeAt(i); }
      return bytes;
    } catch {
      return undefined;
    }
  });

  const bodyText = $derived(
    bodyBytes === undefined
      ? '(unable to decode response body)'
      : new TextDecoder('utf-8', { fatal: false }).decode(bodyBytes)
  );

  const contentType = $derived(
    response?.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? ''
  );

  /** The type the preview is built with — sniffed only where the server said nothing. */
  const previewType = $derived(effectiveMediaType(contentType, bodyBytes));
  /** What this body can be shown as, beyond its text. */
  const preview = $derived<PreviewKind>(previewKind(contentType, bodyBytes));

  /**
   * The content-type as sent, saying so when the bytes disagree with the silence.
   * A server that sent `application/octet-stream` for a PNG has not lied, but it
   * has not helped either, and the preview should explain where it came from.
   */
  const contentTypeLabel = $derived.by(() => {
    if (!contentType) { return previewType ? `no content-type — looks like ${previewType}` : 'no content-type'; }
    return previewType && previewType !== mediaType(contentType)
      ? `${contentType} — looks like ${previewType}`
      : contentType;
  });

  /** The segments on offer: preview only where there is something to preview. */
  const bodyViews = $derived(BODY_VIEWS.filter((v) => v !== 'preview' || preview !== 'none'));

  /**
   * The view actually on screen.
   *
   * `resView` is the remembered preference; this reconciles it with what the
   * response in front of it can do. Media with no reading as text opens in the
   * preview regardless, and a preference for `preview` falls back to `pretty`
   * on the next JSON response rather than showing an empty pane.
   */
  const bodyView = $derived.by<BodyView>(() => {
    if (preview === 'none') { return resView === 'preview' ? 'pretty' : resView; }
    if (previewedAutomatically && isOpaqueMedia(preview)) { return 'preview'; }
    return resView;
  });

  function chooseView(view: BodyView) {
    previewedAutomatically = false;
    resView = view;
  }

  /**
   * The body as something an `<img>`, a player or the preview frame can load.
   *
   * A blob rather than a `data:` URL: a data URL of a ten-megabyte video is a
   * thirteen-megabyte string rebuilt on every render, where a blob is handed to
   * the element by reference. Minted only while the preview is actually on
   * screen and revoked the moment it is not, so a response never sits in memory
   * twice for a pane nobody is looking at.
   */
  let blobUrl = $state<string | undefined>(undefined);

  $effect(() => {
    const bytes = bodyBytes;
    const type = previewType;
    if (!bytes?.length || resTab !== 'body' || bodyView !== 'preview') {
      blobUrl = undefined;
      return;
    }
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    blobUrl = url;
    return () => URL.revokeObjectURL(url);
  });

  /** Set when the engine could not decode the bytes it was handed. */
  let previewFailed = $state(false);
  /** An image's own idea of its size, which the headers never carry. */
  let imageSize = $state<{ width: number; height: number } | undefined>(undefined);

  // A new blob is a new thing to fail at, or to measure.
  $effect(() => {
    void blobUrl;
    previewFailed = false;
    imageSize = undefined;
  });

  function onImageLoad(event: Event & { currentTarget: HTMLImageElement }) {
    const { naturalWidth, naturalHeight } = event.currentTarget;
    // An SVG with no intrinsic size reports 0; better to say nothing than 0 × 0.
    imageSize = naturalWidth && naturalHeight ? { width: naturalWidth, height: naturalHeight } : undefined;
  }

  /** What the preview is, under the preview. */
  const previewNote = $derived.by(() => {
    const parts: string[] = [];
    if (imageSize) { parts.push(`${imageSize.width} × ${imageSize.height}`); }
    parts.push(formatSize(bodyBytes?.length ?? 0));
    if (preview === 'html') { parts.push('scripts and remote resources are blocked'); }
    if (response?.bodyTruncated) { parts.push('body truncated, so this is a fragment'); }
    return parts.join(' · ');
  });

  /** The body parsed for the tree view, and the fallback reason when it will not. */
  const parsedBody = $derived.by<{ value: unknown } | { error: string }>(() => {
    if (!bodyText.trim()) { return { error: 'The response body is empty.' }; }
    try {
      return { value: JSON.parse(bodyText) };
    } catch {
      return {
        error: /json/i.test(contentType)
          ? 'This response is not valid JSON, so it cannot be shown as a tree.'
          : `A tree needs JSON; this response is ${contentType || 'of an unknown type'}.`
      };
    }
  });

  const responseLanguage = $derived.by(() => {
    const declared = contentTypeLanguage(contentType);
    // A missing or vague content-type is common; if the body parses, trust it
    // over the header rather than showing JSON as flat grey text.
    if (declared === 'plaintext' && 'value' in parsedBody) { return 'json'; }
    return declared;
  });

  /** Structure first — indented and broken across lines, then highlighted. */
  const prettyBody = $derived(formatBody(bodyText, responseLanguage));

  /** The body as the view on screen shows it: what the search runs against. */
  const shownBody = $derived(bodyView === 'raw' ? bodyText : prettyBody);
  const bodyMatches = $derived(matcher ? matcher.ranges(shownBody).length : 0);

  const shownHeaders = $derived.by(() => {
    const rows = response?.headers ?? [];
    const found = matcher;
    return found ? rows.filter((h) => found.test(h.key, h.value)) : rows;
  });

  const shownCookies = $derived.by(() => {
    const rows = response?.cookies ?? [];
    const found = matcher;
    return found
      ? rows.filter((c) => found.test(c.name, c.value, c.domain, c.path, c.sameSite))
      : rows;
  });

  const shownAssertions = $derived.by(() => {
    const found = matcher;
    return found ? assertions.filter((a) => found.test(a.name, a.error?.message)) : assertions;
  });

  const shownConsole = $derived.by(() => {
    const found = matcher;
    return found ? consoleLines.filter((l) => found.test(l.level, l.message)) : consoleLines;
  });

  /** What the search found on the tab being looked at, in words. */
  const searchSummary = $derived.by(() => {
    if (!matcher || !response) { return ''; }
    const of = (shown: number, total: number, noun: string) =>
      `${shown} of ${total} ${noun}${total === 1 ? '' : 's'}`;
    switch (resTab) {
      case 'body': {
        if (bodyMatches === 0) { return 'no matches'; }
        const count = `${bodyMatches}${bodyMatches >= MATCH_LIMIT ? '+' : ''} match${bodyMatches === 1 ? '' : 'es'}`;
        // The preview has no text to mark up, so say which text was counted.
        return bodyView === 'preview' ? `${count} in the source` : count;
      }
      case 'headers': return of(shownHeaders.length, response.headers.length, 'header');
      case 'cookies': return of(shownCookies.length, response.cookies.length, 'cookie');
      case 'tests': return of(shownAssertions.length, assertions.length, 'test');
      case 'console': return of(shownConsole.length, consoleLines.length, 'line');
      // The sent tab mixes a filtered table with marked-up text; one number
      // could only describe half of it, so it goes without.
      default: return '';
    }
  });

  /** Stepping only makes sense where matches are marked rather than filtered. */
  const canStep = $derived(
    resTab === 'body' && (bodyView === 'pretty' || bodyView === 'raw') && bodyMatches > 0
  );

  function step(delta: number) {
    if (!bodyMatches) { return; }
    currentMatch = (currentMatch + delta + bodyMatches) % bodyMatches;
  }

  function onSearchKey(event: KeyboardEvent) {
    if (event.key === 'Escape') { query = ''; }
    else if (event.key === 'Enter') { step(event.shiftKey ? -1 : 1); }
    else { return; }
    event.preventDefault();
  }

  // A fresh query, tab, view or response is a fresh walk through the hits.
  $effect(() => {
    void matcher;
    void resTab;
    void bodyView;
    void bodyMatches;
    currentMatch = 0;
  });

  /** Plain text, escaped, with any search hits marked. */
  const mark = (text: string) => renderTokens(text, matchTokens(text, matcher));

  /** Syntax and `{{variable}}` colouring, with search hits laid over the top. */
  function marked(text: string, language: string | undefined): string {
    const base = mergeTokens(languageTokens(text, language), variableTokens(text));
    return renderTokens(text, matcher ? mergeTokens(base, matchTokens(text, matcher)) : base);
  }

  const bodyHtml = $derived(
    bodyView === 'raw' ? mark(shownBody) : marked(shownBody, responseLanguage)
  );

  /**
   * Put the current hit on screen. Runs after every re-render of the body,
   * because `{@html}` replaces the spans this marks up.
   */
  $effect(() => {
    const host = matchHost;
    const index = currentMatch;
    void bodyHtml;
    if (!host) { return; }
    const marks = host.querySelectorAll<HTMLElement>('[data-match]');
    marks.forEach((hit) => hit.classList.remove('current'));
    const target = marks[index];
    if (!target) { return; }
    target.classList.add('current');
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
  });

  /**
   * Remembering where the user was reading.
   *
   * The host keeps one response view for the workspace, so a preference for the
   * raw body, or for checking Tests first, survives the next send and the next
   * editor. Applied on the first `init` only: later ones arrive because the
   * collection file changed, and re-applying then would drag the user off
   * whichever tab they had opened since.
   */
  let viewRestored = false;
  let lastRemembered = '';

  function restoreView(state: ResponseViewState) {
    if (viewRestored) { return; }
    viewRestored = true;
    lastRemembered = JSON.stringify(state);
    if (RES_TABS.includes(state.tab)) { resTab = state.tab; }
    if ((BODY_VIEWS as readonly string[]).includes(state.view)) { resView = state.view as BodyView; }
    wrap = state.wrap;
  }

  $effect(() => {
    // Visualize is never reopened on: it exists only while a run has produced
    // one, so a stored `viz` would be a tab that is not there.
    const state = { tab: resTab === 'viz' ? 'body' : resTab, view: resView, wrap };
    const encoded = JSON.stringify(state);
    if (!viewRestored || encoded === lastRemembered) { return; }
    lastRemembered = encoded;
    post({ type: 'responseView', state });
  });

  /** How many settings this request itself carries — the Settings tab's badge. */
  const settingsCount = $derived(Object.keys(request?.settings.own ?? {}).length);

  /**
   * Whether the open request tab is one whose content is a single text editor,
   * and so should be stretched to the bottom of the card rather than left as a
   * fixed-height box with dead space under it. The tables and the settings list
   * keep their natural heights.
   */
  const reqPaneFills = $derived(
    reqTab === 'pre' ||
      reqTab === 'tests' ||
      (reqTab === 'body' && (request?.body.mode === 'raw' || request?.body.mode === 'graphql'))
  );

  const passed = $derived(assertions.filter((a) => a.passed && !a.skipped).length);
  const failed = $derived(assertions.filter((a) => !a.passed && !a.skipped).length);

  /** Auth params for the selected type, padded out to the full field list. */
  const authRows = $derived.by<KeyValue[]>(() => {
    if (!request) { return []; }
    const fields = authFields[request.auth.type] ?? [];
    const existing = new Map(request.auth.params.map((p) => [p.key, p.value]));
    if (!fields.length) { return request.auth.params; }
    return fields.map((key) => ({ key, value: existing.get(key) ?? '' }));
  });

  function statusClass(code: number): string {
    if (code >= 200 && code < 300) { return 'ok'; }
    if (code >= 300 && code < 400) { return 'warn'; }
    return 'bad';
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) { return `${bytes} B`; }
    if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  /**
   * The response card's overflow menu.
   *
   * Saving a response is an occasional, deliberate act — it is the one thing
   * that takes a response out of memory and onto disk — so it lives behind the
   * ⋯ rather than as another button competing with the status strip.
   */
  let menuOpen = $state(false);
  let menuRoot = $state<HTMLElement | undefined>(undefined);

  function saveResponse(kind: 'body' | 'full') {
    menuOpen = false;
    post({ type: 'saveResponse', kind });
  }

  // Open until the next click outside it or Escape. Bound on window while it is
  // open rather than for the life of the editor, which is otherwise listening
  // for keys on every keystroke in a body of any size.
  $effect(() => {
    if (!menuOpen) { return; }
    const onDown = (event: MouseEvent) => {
      if (!menuRoot?.contains(event.target as Node)) { menuOpen = false; }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { menuOpen = false; }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  });

  /** Send, or — while the run this button started is still going — stop it. */
  function send() {
    if (running) { return post({ type: 'cancel' }); }
    post({ type: 'send' });
  }

  function apply(view: RequestView) {
    if (focusCount > 0) { pending = view; }
    else { request = view; }
  }

  /**
   * A webview panel has no find widget of its own, so Ctrl/Cmd+F is free — and
   * a key that visibly does nothing is worse than one that goes somewhere. It
   * lands in the response search.
   */
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key.toLowerCase() !== 'f' || event.altKey) { return; }
    if (!event.ctrlKey && !event.metaKey) { return; }
    if (!searchBox) { return; }
    event.preventDefault();
    searchBox.focus();
    searchBox.select();
  });

  window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
    const msg = event.data;
    switch (msg.type) {
      case 'init':
        apply(msg.request);
        environments = msg.environments;
        collectionVariables = msg.collectionVariables;
        scriptsAllowed = msg.scriptsAllowed;
        authTypes = msg.authTypes;
        authFields = msg.authFields;
        settingDefaults = msg.settingDefaults;
        restoreView(msg.responseView);
        break;
      case 'environments':
        environments = msg.environments;
        break;
      case 'saved':
        saveError = undefined;
        break;
      case 'saveFailed':
        saveError = msg.message;
        break;
      case 'runStarted':
        running = true;
        // Whatever the menu was about to save is on its way out.
        menuOpen = false;
        failure = undefined;
        response = undefined;
        sentRequest = undefined;
        assertions = [];
        consoleLines = [];
        visualizerHtml = undefined;
        break;
      case 'sent':
        sentRequest = msg.request;
        break;
      case 'response':
        sentRequest = msg.request;
        response = msg.response;
        // The tab stays where the user left it — a fresh response is no reason
        // to drag someone off Tests. Only the body view is reconsidered, and
        // only so that media opens in the preview rather than as mojibake.
        previewedAutomatically = true;
        break;
      case 'assertions':
        assertions = [...assertions, ...msg.assertions];
        break;
      case 'console':
        consoleLines = msg.lines;
        break;
      case 'visualizer':
        visualizerHtml = msg.html;
        break;
      case 'runFailed':
        failure = msg.message;
        break;
      case 'runFinished':
        running = false;
        break;
      case 'filePicked':
        pickWaiters.get(msg.token)?.(msg.path);
        pickWaiters.delete(msg.token);
        break;
    }
  });

  post({ type: 'ready' });
</script>

{#if !request}
  <div class="empty">Loading request…</div>
{:else}
  <div class="layout request">
    <div class="crumbs">
      <span>{request.collectionName}</span>
      {#each request.path.slice(0, -1) as segment}
        <span class="sep">›</span><span>{segment}</span>
      {/each}
      <span class="sep">›</span><span>{request.name}</span>
      <button class="icon" title="Open the collection JSON" onclick={() => post({ type: 'revealInFile' })}>
        <span class="codicon codicon-json"></span>
      </button>
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
    {#if failure}
      <div class="banner error">{failure}</div>
    {/if}

    <div class="split">
      <!-- request half -->
      <div class="half">
        <div class="urlbar">
          <select
            class="method"
            data-method={request.method}
            value={request.method}
            onchange={(e) => save({ field: 'method', value: (e.currentTarget as HTMLSelectElement).value })}
          >
            {#each METHODS as method}<option value={method}>{method}</option>{/each}
          </select>

          <HighlightedField
            fieldClass="url"
            value={request.url}
            {resolver}
            {pathClassify}
            {onvar}
            placeholder="https://{'{{'}baseUrl{'}}'}/path"
            {onfocuschange}
            oncommit={(value) => save({ field: 'url', value })}
          />

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
            title={running ? 'Stop this request' : 'Send this request'}
            onclick={send}
          >
            {#if running}<span class="codicon codicon-debug-stop"></span>{/if}
            {running ? 'Stop' : 'Send'}
          </button>
        </div>

        <div class="tabs">
          <button class="tab" class:active={reqTab === 'params'} onclick={() => (reqTab = 'params')}>
            Params<span class="count">{request.query.length + request.pathVariables.length}</span>
          </button>
          <button class="tab" class:active={reqTab === 'auth'} onclick={() => (reqTab = 'auth')}>
            Auth<span class="count">{request.auth.type}</span>
          </button>
          <button class="tab" class:active={reqTab === 'headers'} onclick={() => (reqTab = 'headers')}>
            Headers<span class="count">{request.headers.length}</span>
          </button>
          <button class="tab" class:active={reqTab === 'body'} onclick={() => (reqTab = 'body')}>
            Body<span class="count">{request.body.mode}</span>
          </button>
          <button class="tab" class:active={reqTab === 'pre'} onclick={() => (reqTab = 'pre')}>
            Pre-request{#if request.scripts.prerequest}<span class="count">●</span>{/if}
          </button>
          <button class="tab" class:active={reqTab === 'tests'} onclick={() => (reqTab = 'tests')}>
            Tests{#if request.scripts.test}<span class="count">●</span>{/if}
          </button>
          <button class="tab" class:active={reqTab === 'settings'} onclick={() => (reqTab = 'settings')}>
            Settings{#if settingsCount}<span class="count">{settingsCount}</span>{/if}
          </button>
        </div>

        <div class="pane" class:fill={reqPaneFills}>
          {#if reqTab === 'params'}
            <div class="section-title">Query parameters</div>
            <KeyValueTable
              rows={request.query}
              editable
              {resolver}
              {onfocuschange}
              {onvar}
              empty="No query parameters."
              onchange={(rows) => save({ field: 'query', rows })}
            />
            <div class="section-title">Path variables</div>
            <div class="note">
              Fill <code>:name</code> segments of the URL path, for this request only — unlike
              <code>{'{{'}name{'}}'}</code> environment variables, which work anywhere and are
              shared across requests.
            </div>
            <KeyValueTable
              rows={request.pathVariables}
              editable
              {resolver}
              {onfocuschange}
              {onvar}
              empty="No path variables. Add `:name` segments to the URL."
              onchange={(rows) => save({ field: 'pathVariables', rows })}
            />
          {:else if reqTab === 'auth'}
            <div class="section-title">
              <label class="inline">
                Type
                <select
                  value={request.auth.type === 'none' ? 'inherit' : request.auth.type}
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
              {#if request.auth.inheritedFrom}
                <span class="muted">— currently inherited from {request.auth.inheritedFrom}</span>
              {/if}
            </div>
            {#key request.auth.type}
              <KeyValueTable
                rows={authRows}
                editable={request.auth.type !== 'none' && request.auth.type !== 'noauth'}
                {resolver}
                {onfocuschange}
                {onvar}
                empty="This request does not use authentication."
                onchange={(rows) => save({ field: 'auth', authType: request!.auth.type, rows })}
              />
            {/key}
          {:else if reqTab === 'headers'}
            <KeyValueTable
              rows={request.headers}
              editable
              {resolver}
              {onfocuschange}
              {onvar}
              empty="No headers set on this request."
              onchange={(rows) => save({ field: 'headers', rows })}
            />
          {:else if reqTab === 'body'}
            <div class="section-title">
              <label class="inline">
                Mode
                <select
                  value={request.body.mode}
                  onchange={(e) =>
                    save({
                      field: 'body',
                      mode: (e.currentTarget as HTMLSelectElement).value,
                      text: request!.body.text,
                      language: request!.body.language,
                      rows: request!.body.entries
                    })}
                >
                  {#each BODY_MODES as mode}<option value={mode}>{mode}</option>{/each}
                </select>
              </label>
              {#if request.body.mode === 'raw'}
                <label class="inline">
                  Language
                  <select
                    value={request.body.language ?? 'text'}
                    onchange={(e) =>
                      save({
                        field: 'body',
                        mode: 'raw',
                        text: request!.body.text ?? '',
                        language: (e.currentTarget as HTMLSelectElement).value
                      })}
                  >
                    {#each RAW_LANGUAGES as lang}<option value={lang}>{lang}</option>{/each}
                  </select>
                </label>
              {/if}
            </div>

            {#if request.body.mode === 'none'}
              <div class="empty">This request has no body.</div>
            {:else if request.body.mode === 'urlencoded' || request.body.mode === 'formdata'}
              <KeyValueTable
                rows={request.body.entries ?? []}
                editable
                fileToggle={request.body.mode === 'formdata'}
                pickFile={request.body.mode === 'formdata' ? pickFile : undefined}
                {resolver}
                {onfocuschange}
                {onvar}
                empty="Empty body."
                onchange={(rows) => save({ field: 'body', mode: request!.body.mode, rows })}
              />
            {:else if request.body.mode === 'file'}
              <div class="valuecell">
                <HighlightedField
                  fieldClass="cell wide"
                  value={request.body.text ?? ''}
                  {resolver}
                  {onvar}
                  placeholder="path/to/file relative to the workspace"
                  {onfocuschange}
                  oncommit={(text) => save({ field: 'body', mode: 'file', text })}
                />
                <button
                  class="icon"
                  title="Browse for a file"
                  onclick={async () => {
                    const picked = await pickFile();
                    if (picked !== undefined) { save({ field: 'body', mode: 'file', text: picked }); }
                  }}
                >
                  <span class="codicon codicon-folder-opened"></span>
                </button>
              </div>
            {:else}
              <HighlightedField
                multiline
                fieldClass="code grow"
                value={request.body.text ?? ''}
                language={bodyLanguage(request.body.language)}
                {resolver}
                {onvar}
                {onfocuschange}
                oncommit={(text) =>
                  save({
                    field: 'body',
                    mode: request!.body.mode,
                    text,
                    language: request!.body.language,
                    rows: request!.body.entries
                  })}
              />
              {#if request.body.mode === 'graphql'}
                <div class="section-title">GraphQL variables</div>
                <HighlightedField
                  multiline
                  fieldClass="code short"
                  value={request.body.entries?.[0]?.value ?? ''}
                  language="json"
                  {resolver}
                  {onvar}
                  {onfocuschange}
                  oncommit={(value) =>
                    save({
                      field: 'body',
                      mode: 'graphql',
                      text: request!.body.text ?? '',
                      rows: [{ key: 'variables', value }]
                    })}
                />
              {/if}
            {/if}
          {:else if reqTab === 'pre' || reqTab === 'tests'}
            {@const listen = reqTab === 'pre' ? 'prerequest' : 'test'}
            {@const source = (reqTab === 'pre' ? request.scripts.prerequest : request.scripts.test) ?? ''}
            {#key request.itemId + listen}
              <HighlightedField
                multiline
                fieldClass="code tall grow"
                language="javascript"
                placeholder={listen === 'prerequest'
                  ? "pm.environment.set('token', '…');"
                  : "pm.test('status is 200', function () {\n  pm.response.to.have.status(200);\n});"}
                value={source}
                {resolver}
                {onvar}
                {onfocuschange}
                oncommit={(next) => save({ field: 'script', listen, source: next })}
              />
            {/key}
            {#each request.inheritedScripts.filter((s) => s.listen === listen) as script}
              <div class="section-title">Also runs — from {script.from} (edit it there)</div>
              <pre>{@html highlight(script.source, 'javascript', resolver.classify)}</pre>
            {/each}
          {:else if reqTab === 'settings'}
            <SettingsTab
              settings={request.settings}
              defaults={settingDefaults}
              collectionName={request.collectionName}
              {onfocuschange}
              onset={(key, value) => save({ field: 'setting', key, value })}
            />
          {/if}
        </div>
      </div>

      <!-- response half -->
      <div class="half">
        {#if response}
          <div class="status">
            <span class="pill {statusClass(response.code)}">{response.code} {response.status}</span>
            <span class="muted">{response.responseTime} ms</span>
            <span class="muted">{formatSize(response.responseSize)}</span>
            {#if assertions.length}
              <span class:pass={failed === 0} class:fail={failed > 0}>
                {passed} passed{failed ? `, ${failed} failed` : ''}
              </span>
            {/if}
            {#if response.bodyTruncated}<span class="muted">body truncated</span>{/if}
            <label class="inline muted"><input type="checkbox" bind:checked={wrap} /> wrap</label>

            <div class="menu" bind:this={menuRoot}>
              <button
                class="icon"
                title="More response actions"
                aria-label="More response actions"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onclick={() => (menuOpen = !menuOpen)}
              >
                <span class="codicon codicon-ellipsis"></span>
              </button>
              {#if menuOpen}
                <div class="menu-list" role="menu">
                  <button role="menuitem" onclick={() => saveResponse('body')}>
                    Save body…
                    <span class="muted">just what came back</span>
                  </button>
                  <button role="menuitem" onclick={() => saveResponse('full')}>
                    Save with headers…
                    <span class="muted">status line, headers, then the body</span>
                  </button>
                </div>
              {/if}
            </div>
          </div>

          <div class="tabs">
            <button class="tab" class:active={resTab === 'body'} onclick={() => (resTab = 'body')}>
              Body{#if matcher}<span class="count">{bodyMatches}</span>{/if}
            </button>
            <button class="tab" class:active={resTab === 'headers'} onclick={() => (resTab = 'headers')}>
              Headers<span class="count">
                {matcher ? `${shownHeaders.length}/${response.headers.length}` : response.headers.length}
              </span>
            </button>
            <button class="tab" class:active={resTab === 'cookies'} onclick={() => (resTab = 'cookies')}>
              Cookies<span class="count">
                {matcher ? `${shownCookies.length}/${response.cookies.length}` : response.cookies.length}
              </span>
            </button>
            <button class="tab" class:active={resTab === 'tests'} onclick={() => (resTab = 'tests')}>
              Tests<span class="count">
                {matcher ? `${shownAssertions.length}/${assertions.length}` : assertions.length}
              </span>
            </button>
            <button class="tab" class:active={resTab === 'console'} onclick={() => (resTab = 'console')}>
              Console<span class="count">
                {matcher ? `${shownConsole.length}/${consoleLines.length}` : consoleLines.length}
              </span>
            </button>
            <button class="tab" class:active={resTab === 'sent'} onclick={() => (resTab = 'sent')}>Sent</button>
            <!-- Kept on the bar while it is the open tab even before this run
                 has produced a visualization, so a re-send does not move you. -->
            {#if visualizerHtml || resTab === 'viz'}
              <button class="tab" class:active={resTab === 'viz'} onclick={() => (resTab = 'viz')}>Visualize</button>
            {/if}
          </div>

          {#if resTab !== 'viz'}
            <div class="searchbar">
              <span class="codicon codicon-search"></span>
              <input
                bind:this={searchBox}
                bind:value={query}
                class="searchbox"
                type="text"
                spellcheck="false"
                aria-label="Search this response"
                placeholder="Search this response — body, headers, cookies, tests, console"
                onkeydown={onSearchKey}
              />
              {#if query}
                <button class="icon" title="Clear the search (Esc)" onclick={() => (query = '')}>
                  <span class="codicon codicon-close"></span>
                </button>
              {/if}
              <button
                class="toggle"
                class:active={searchCase}
                title="Match case"
                onclick={() => (searchCase = !searchCase)}
              >Aa</button>
              <button
                class="toggle"
                class:active={searchRegex}
                title="Use a regular expression"
                onclick={() => (searchRegex = !searchRegex)}
              >.*</button>

              {#if search.kind === 'invalid'}
                <span class="searchnote bad" title={search.message}>{search.message}</span>
              {:else if searchSummary}
                <span class="searchnote muted">{searchSummary}</span>
              {/if}

              {#if canStep}
                <span class="searchnote muted">{currentMatch + 1} of {bodyMatches}</span>
                <button class="icon" title="Previous match (Shift+Enter)" onclick={() => step(-1)}>
                  <span class="codicon codicon-arrow-up"></span>
                </button>
                <button class="icon" title="Next match (Enter)" onclick={() => step(1)}>
                  <span class="codicon codicon-arrow-down"></span>
                </button>
              {/if}
            </div>
          {/if}

          <div class="pane">
            {#if resTab === 'body'}
              <div class="section-title">
                <div class="segmented" role="group" aria-label="Response view">
                  {#each bodyViews as view}
                    <button
                      class="seg"
                      class:active={bodyView === view}
                      onclick={() => chooseView(view)}
                    >{view}</button>
                  {/each}
                </div>
                <span class="muted">{contentTypeLabel}</span>
              </div>

              {#if bodyView === 'preview'}
                {#if bodyBytes === undefined}
                  <div class="empty">This body did not decode, so there is nothing to show.</div>
                {:else if !blobUrl}
                  <div class="empty">The response body is empty.</div>
                {:else if previewFailed}
                  <div class="empty">
                    This editor could not decode {previewType || 'this body'}. Save the response
                    and open it in something that can.
                  </div>
                {:else}
                  <div class="preview" class:page={preview === 'html'}>
                    {#if preview === 'image'}
                      <img
                        class="preview-image"
                        src={blobUrl}
                        alt="The response body"
                        onload={onImageLoad}
                        onerror={() => (previewFailed = true)}
                      />
                    {:else if preview === 'audio'}
                      <audio
                        class="preview-player"
                        controls
                        src={blobUrl}
                        onerror={() => (previewFailed = true)}
                      ></audio>
                    {:else if preview === 'video'}
                      <!-- svelte-ignore a11y_media_has_caption -->
                      <video
                        class="preview-player"
                        controls
                        src={blobUrl}
                        onerror={() => (previewFailed = true)}
                      ></video>
                    {:else}
                      <!-- sandbox="": opaque origin, no scripts, no forms, no
                           navigation. It inherits this panel's CSP on top, so
                           the page cannot reach the network either. -->
                      <iframe
                        class="preview-frame"
                        title="The response body, rendered"
                        sandbox=""
                        src={blobUrl}
                      ></iframe>
                    {/if}
                  </div>
                {/if}
                {#if blobUrl && !previewFailed}
                  <div class="preview-note muted">{previewNote}</div>
                {/if}
              {:else if bodyView === 'tree'}
                {#if !('value' in parsedBody)}
                  <div class="empty">{parsedBody.error}</div>
                {:else if matcher && !jsonMatches(matcher, parsedBody.value)}
                  <div class="empty">Nothing in this body matches “{matcher.text}”.</div>
                {:else}
                  <div class="tree">
                    <JsonTree value={parsedBody.value} open {matcher} />
                  </div>
                {/if}
              {:else}
                <!-- Pretty is formatted and coloured; raw is exactly what came
                     back. Either way the only thing added is the search hits. -->
                <pre bind:this={matchHost} class:wrap>{@html bodyHtml}</pre>
              {/if}
            {:else if resTab === 'headers'}
              <KeyValueTable rows={response.headers} {matcher} empty="No response headers." />
            {:else if resTab === 'cookies'}
              <div class="section-title">
                <span>Cookies for this request's URL</span>
                <button class="secondary" onclick={() => post({ type: 'manageCookies' })}>
                  Manage cookies
                </button>
              </div>
              {#if shownCookies.length}
                <table>
                  <thead>
                    <tr><th>Name</th><th>Value</th><th>Domain</th><th>Path</th><th>Expires</th><th>Flags</th></tr>
                  </thead>
                  <tbody>
                    {#each shownCookies as c}
                      <tr>
                        <td class="k">{@html mark(c.name)}</td>
                        <td>{@html mark(c.value)}</td>
                        <td>{@html mark(c.domain ?? '')}</td>
                        <td>{@html mark(c.path ?? '')}</td>
                        <td class="muted">
                          {c.maxAge !== undefined
                            ? `max-age ${c.maxAge}s`
                            : !c.expires || c.expires === 'Infinity'
                              ? 'session'
                              : c.expires}
                        </td>
                        <td class="muted">
                          {[c.httpOnly && 'HttpOnly', c.secure && 'Secure', c.sameSite && `SameSite=${c.sameSite}`]
                            .filter(Boolean)
                            .join(' · ')}
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              {:else if matcher && response.cookies.length}
                <div class="empty">No cookie here matches “{matcher.text}”.</div>
              {:else}
                <div class="empty">No cookies apply to this URL.</div>
              {/if}
            {:else if resTab === 'tests'}
              {#if shownAssertions.length}
                {#each shownAssertions as a}
                  <div class="test">
                    <span class={a.skipped ? 'skip' : a.passed ? 'pass' : 'fail'}>
                      {a.skipped ? '○' : a.passed ? '✓' : '✕'}
                    </span>
                    <span class="name">
                      {@html mark(a.name)}
                      {#if a.error}<span class="err">{@html mark(a.error.message)}</span>{/if}
                    </span>
                  </div>
                {/each}
              {:else if matcher && assertions.length}
                <div class="empty">No test here matches “{matcher.text}”.</div>
              {:else}
                <div class="empty">This request has no tests.</div>
              {/if}
            {:else if resTab === 'console'}
              {#if shownConsole.length}
                {#each shownConsole as line}
                  <div class="console-line {line.level}">
                    <span class="level">{line.level}</span>{@html mark(line.message)}
                  </div>
                {/each}
              {:else if matcher && consoleLines.length}
                <div class="empty">No logged line matches “{matcher.text}”.</div>
              {:else}
                <div class="empty">Nothing logged. Use <code>console.log</code> in a script.</div>
              {/if}
            {:else if resTab === 'sent'}
              {#if sentRequest}
                <pre class:wrap>{sentRequest.method} {@html renderTokens(
                  sentRequest.url,
                  mergeTokens(
                    variableTokens(sentRequest.url, resolver.classify),
                    matchTokens(sentRequest.url, matcher)
                  )
                )}</pre>
                <div class="section-title">Headers as sent</div>
                <KeyValueTable rows={sentRequest.headers} {matcher} empty="No headers." />
                {#if sentRequest.body}
                  <div class="section-title">Body as sent</div>
                  <pre class:wrap>{@html marked(sentRequest.body, bodyLanguage(request.body.language))}</pre>
                {/if}
              {/if}
            {:else if resTab === 'viz'}
              {#if visualizerHtml}
                <div class="section-title">
                  Rendered in a separate Visualize tab, isolated from this editor.
                </div>
                <details>
                  <summary class="muted">Show the generated HTML</summary>
                  <pre class:wrap>{visualizerHtml}</pre>
                </details>
              {:else}
                <div class="empty">This run did not call <code>pm.visualizer.set()</code>.</div>
              {/if}
            {/if}
          </div>
        {:else}
          <div class="empty">{running ? 'Sending…' : 'Press Send to run this request.'}</div>
        {/if}
      </div>
    </div>

    {#if hover}
      <VariablePopover
        name={hover.name}
        rect={hover.rect}
        {resolver}
        onsave={setVariable}
        onmovesecret={(key) => post({ type: 'moveSecretToKeychain', key })}
        oneditenvironment={() => post({ type: 'editEnvironment' })}
        onkeepalive={() => clearTimeout(closeTimer)}
        onclose={() => (hover = undefined)}
      />
    {/if}
  </div>
{/if}
