<script lang="ts">
  import type {
    CookieDomainGroup,
    FromCookieWebview,
    ToCookieWebview
  } from '../../src/panels/cookiePanel';
  import type { StoredCookie } from '../../src/runner/cookieStore';

  declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
  const vscode = acquireVsCodeApi();
  const post = (msg: FromCookieWebview) => vscode.postMessage(msg);

  let groups = $state<CookieDomainGroup[]>([]);
  let error = $state<string | undefined>(undefined);

  /** The cookie currently being edited, plus the identity it had on open. */
  let draft = $state<StoredCookie | undefined>(undefined);
  let original = $state<{ domain: string; path: string; key: string } | undefined>(undefined);

  const total = $derived(groups.reduce((n, g) => n + g.cookies.length, 0));

  function edit(cookie: StoredCookie) {
    draft = { ...cookie };
    original = { domain: cookie.domain, path: cookie.path, key: cookie.key };
    error = undefined;
  }

  function add() {
    draft = { key: '', value: '', domain: '', path: '/' };
    original = undefined;
    error = undefined;
  }

  function cancel() {
    draft = undefined;
    original = undefined;
  }

  function save() {
    if (!draft) { return; }
    post({ type: 'save', cookie: draft, original });
    draft = undefined;
    original = undefined;
  }

  /** Session cookies have no expiry; tough-cookie writes 'Infinity'. */
  function expiryLabel(cookie: StoredCookie): string {
    if (cookie.maxAge !== undefined) { return `max-age ${cookie.maxAge}s`; }
    if (!cookie.expires || cookie.expires === 'Infinity') { return 'session'; }
    const date = new Date(cookie.expires);
    return Number.isNaN(date.getTime()) ? cookie.expires : date.toLocaleString();
  }

  window.addEventListener('message', (event: MessageEvent<ToCookieWebview>) => {
    const msg = event.data;
    if (msg.type === 'cookies') {
      groups = msg.groups;
      error = undefined;
    }
    if (msg.type === 'error') { error = msg.message; }
  });

  post({ type: 'ready' });
</script>

<div class="layout">
  <div class="crumbs">
    <span>Cookies</span>
    <span class="sep">›</span>
    <span class="muted">{total} cookie{total === 1 ? '' : 's'} across {groups.length} domain{groups.length === 1 ? '' : 's'}</span>
  </div>

  <div class="console-toolbar">
    <button onclick={add}>Add cookie</button>
    <span style="flex:1"></span>
    <button class="secondary" disabled={!total} onclick={() => post({ type: 'clearAll' })}>Clear all</button>
  </div>

  {#if error}
    <div class="banner error">{error}</div>
  {/if}

  <div class="banner">
    These are the cookies requests actually send. They are stored outside your workspace and are
    never written to a collection file.
  </div>

  <div class="pane">
    {#if draft}
      <div class="editor">
        <div class="row">
          <label class="field">
            Name
            <input bind:value={draft.key} placeholder="session" />
          </label>
          <label class="field">
            Domain
            <input bind:value={draft.domain} placeholder="api.example.com" />
          </label>
          <label class="field">
            Path
            <input bind:value={draft.path} placeholder="/" />
          </label>
        </div>
        <div class="row">
          <label class="field" style="flex:1">
            Value
            <input bind:value={draft.value} />
          </label>
        </div>
        <div class="row">
          <label class="field">
            Expires
            <input bind:value={draft.expires} placeholder="leave blank for a session cookie" />
          </label>
          <label class="inline"><input type="checkbox" bind:checked={draft.httpOnly} /> HttpOnly</label>
          <label class="inline"><input type="checkbox" bind:checked={draft.secure} /> Secure</label>
          <label class="inline"><input type="checkbox" bind:checked={draft.hostOnly} /> Host only</label>
        </div>
        <div class="actions">
          <button onclick={save}>Save</button>
          <button class="secondary" onclick={cancel}>Cancel</button>
        </div>
      </div>
    {/if}

    {#if !groups.length}
      <div class="empty">
        No cookies stored. Send a request that returns a <code>Set-Cookie</code> header, or add one above.
      </div>
    {:else}
      {#each groups as group (group.domain)}
        <div class="domain">
          <div class="domain-head">
            <span class="name">{group.domain}</span>
            <span class="muted">{group.cookies.length}</span>
            <button
              class="icon"
              title="Remove every cookie for this domain"
              onclick={() => post({ type: 'deleteDomain', domain: group.domain })}
            >
              <span class="codicon codicon-trash"></span>
            </button>
          </div>

          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Value</th>
                <th>Path</th>
                <th>Expires</th>
                <th>Flags</th>
                <th class="tick"></th>
              </tr>
            </thead>
            <tbody>
              {#each group.cookies as cookie (cookie.key + cookie.path)}
                <tr>
                  <td class="k">{cookie.key}</td>
                  <td>{cookie.value}</td>
                  <td>{cookie.path}</td>
                  <td class="muted">{expiryLabel(cookie)}</td>
                  <td>
                    <div class="flags">
                      <span class="flag" class:on={cookie.httpOnly}>HttpOnly</span>
                      <span class="flag" class:on={cookie.secure}>Secure</span>
                      {#if cookie.sameSite}<span class="flag on">SameSite={cookie.sameSite}</span>{/if}
                    </div>
                  </td>
                  <td class="tick">
                    <button class="icon" title="Edit" onclick={() => edit(cookie)}>
                      <span class="codicon codicon-edit"></span>
                    </button>
                    <button
                      class="icon"
                      title="Delete"
                      onclick={() =>
                        post({ type: 'delete', domain: cookie.domain, path: cookie.path, key: cookie.key })}
                    >
                      <span class="codicon codicon-trash"></span>
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/each}
    {/if}
  </div>
</div>
