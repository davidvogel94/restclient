<script lang="ts">
  import type {
    ConsoleLine,
    EnvironmentSummary,
    FromWebview,
    KeyValue,
    RequestView,
    ToWebview
  } from '../../src/panels/protocol';
  import type { RequestUpdate } from '../../src/collections/edits';
  import type { SerializedAssertion, SerializedRequest, SerializedResponse } from '../../src/runner/protocol';
  import {
    bodyLanguage,
    contentTypeLanguage,
    highlight,
    renderTokens,
    variableTokens
  } from '../../src/shared/highlight';
  import { formatBody } from '../../src/shared/format';
  import KeyValueTable from './KeyValueTable.svelte';
  import HighlightedField from '../shared/HighlightedField.svelte';
  import VariablePopover from '../shared/VariablePopover.svelte';
  import JsonTree from '../shared/JsonTree.svelte';
  import { buildResolver, type VarHover } from '../shared/vars';

  declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
  const vscode = acquireVsCodeApi();
  const post = (msg: FromWebview) => vscode.postMessage(msg);
  const save = (update: RequestUpdate) => post({ type: 'update', update });

  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  const BODY_MODES = ['none', 'raw', 'graphql', 'urlencoded', 'formdata', 'file'];
  const RAW_LANGUAGES = ['json', 'text', 'javascript', 'html', 'xml'];

  let request = $state<RequestView | undefined>(undefined);
  let environments = $state<EnvironmentSummary[]>([]);
  let collectionVariables = $state<KeyValue[]>([]);
  let scriptsAllowed = $state(true);
  let authTypes = $state<readonly string[]>([]);
  let authFields = $state<Record<string, string[]>>({});

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
  /** How the response body is rendered: formatted, verbatim, or as a tree. */
  let resView = $state<'pretty' | 'raw' | 'tree'>('pretty');
  let wrap = $state(true);

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

  const bodyText = $derived.by(() => {
    if (!response) { return ''; }
    try {
      const bin = atob(response.bodyBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) { bytes[i] = bin.charCodeAt(i); }
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
      return '(unable to decode response body)';
    }
  });

  const contentType = $derived(
    response?.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? ''
  );

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

  function send() {
    if (running) { return post({ type: 'cancel' }); }
    post({ type: 'send' });
  }

  function apply(view: RequestView) {
    if (focusCount > 0) { pending = view; }
    else { request = view; }
  }

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
        resTab = 'body';
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
    }
  });

  post({ type: 'ready' });
</script>

{#if !request}
  <div class="empty">Loading request…</div>
{:else}
  <div class="layout">
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

      <button onclick={send}>{running ? 'Cancel' : 'Send'}</button>
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
        </div>

        <div class="pane">
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
                {resolver}
                {onfocuschange}
                {onvar}
                empty="Empty body."
                onchange={(rows) => save({ field: 'body', mode: request!.body.mode, rows })}
              />
            {:else if request.body.mode === 'file'}
              <HighlightedField
                fieldClass="cell wide"
                value={request.body.text ?? ''}
                {resolver}
                {onvar}
                placeholder="path/to/file relative to the workspace"
                {onfocuschange}
                oncommit={(text) => save({ field: 'body', mode: 'file', text })}
              />
            {:else}
              <HighlightedField
                multiline
                fieldClass="code"
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
                fieldClass="code tall"
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
          </div>

          <div class="tabs">
            <button class="tab" class:active={resTab === 'body'} onclick={() => (resTab = 'body')}>Body</button>
            <button class="tab" class:active={resTab === 'headers'} onclick={() => (resTab = 'headers')}>
              Headers<span class="count">{response.headers.length}</span>
            </button>
            <button class="tab" class:active={resTab === 'cookies'} onclick={() => (resTab = 'cookies')}>
              Cookies<span class="count">{response.cookies.length}</span>
            </button>
            <button class="tab" class:active={resTab === 'tests'} onclick={() => (resTab = 'tests')}>
              Tests<span class="count">{assertions.length}</span>
            </button>
            <button class="tab" class:active={resTab === 'console'} onclick={() => (resTab = 'console')}>
              Console<span class="count">{consoleLines.length}</span>
            </button>
            <button class="tab" class:active={resTab === 'sent'} onclick={() => (resTab = 'sent')}>Sent</button>
            {#if visualizerHtml}
              <button class="tab" class:active={resTab === 'viz'} onclick={() => (resTab = 'viz')}>Visualize</button>
            {/if}
          </div>

          <div class="pane">
            {#if resTab === 'body'}
              <div class="section-title">
                <div class="segmented" role="group" aria-label="Response view">
                  {#each ['pretty', 'raw', 'tree'] as view}
                    <button
                      class="seg"
                      class:active={resView === view}
                      onclick={() => (resView = view as typeof resView)}
                    >{view}</button>
                  {/each}
                </div>
                <span class="muted">{contentType || 'no content-type'}</span>
              </div>

              {#if resView === 'tree'}
                {#if 'value' in parsedBody}
                  <div class="tree">
                    <JsonTree value={parsedBody.value} open />
                  </div>
                {:else}
                  <div class="empty">{parsedBody.error}</div>
                {/if}
              {:else if resView === 'raw'}
                <!-- Exactly what came back: no re-indenting, no colouring. -->
                <pre class:wrap>{bodyText}</pre>
              {:else}
                <pre class:wrap>{@html highlight(prettyBody, responseLanguage)}</pre>
              {/if}
            {:else if resTab === 'headers'}
              <KeyValueTable rows={response.headers} empty="No response headers." />
            {:else if resTab === 'cookies'}
              <div class="section-title">
                <span>Cookies for this request's URL</span>
                <button class="secondary" onclick={() => post({ type: 'manageCookies' })}>
                  Manage cookies
                </button>
              </div>
              {#if response.cookies.length}
                <table>
                  <thead>
                    <tr><th>Name</th><th>Value</th><th>Domain</th><th>Path</th><th>Expires</th><th>Flags</th></tr>
                  </thead>
                  <tbody>
                    {#each response.cookies as c}
                      <tr>
                        <td class="k">{c.name}</td>
                        <td>{c.value}</td>
                        <td>{c.domain ?? ''}</td>
                        <td>{c.path ?? ''}</td>
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
              {:else}
                <div class="empty">No cookies apply to this URL.</div>
              {/if}
            {:else if resTab === 'tests'}
              {#if assertions.length}
                {#each assertions as a}
                  <div class="test">
                    <span class={a.skipped ? 'skip' : a.passed ? 'pass' : 'fail'}>
                      {a.skipped ? '○' : a.passed ? '✓' : '✕'}
                    </span>
                    <span class="name">
                      {a.name}
                      {#if a.error}<span class="err">{a.error.message}</span>{/if}
                    </span>
                  </div>
                {/each}
              {:else}
                <div class="empty">This request has no tests.</div>
              {/if}
            {:else if resTab === 'console'}
              {#if consoleLines.length}
                {#each consoleLines as line}
                  <div class="console-line {line.level}">
                    <span class="level">{line.level}</span>{line.message}
                  </div>
                {/each}
              {:else}
                <div class="empty">Nothing logged. Use <code>console.log</code> in a script.</div>
              {/if}
            {:else if resTab === 'sent'}
              {#if sentRequest}
                <pre class:wrap>{sentRequest.method} {@html renderTokens(
                  sentRequest.url,
                  variableTokens(sentRequest.url, resolver.classify)
                )}</pre>
                <div class="section-title">Headers as sent</div>
                <KeyValueTable rows={sentRequest.headers} empty="No headers." />
                {#if sentRequest.body}
                  <div class="section-title">Body as sent</div>
                  <pre class:wrap>{@html highlight(sentRequest.body, bodyLanguage(request.body.language))}</pre>
                {/if}
              {/if}
            {:else if resTab === 'viz' && visualizerHtml}
              <div class="section-title">
                Rendered in a separate Visualize tab, isolated from this editor.
              </div>
              <details>
                <summary class="muted">Show the generated HTML</summary>
                <pre class:wrap>{visualizerHtml}</pre>
              </details>
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
