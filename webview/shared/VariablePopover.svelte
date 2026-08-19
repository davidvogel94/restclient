<script lang="ts">
  import type { Resolver, VarInfo } from './vars';

  /**
   * Postman-style inline editor for one `{{variable}}`.
   *
   * Anchored under the token that is hovered so a value can be corrected
   * without opening the environment editor and losing the request in view.
   */

  let {
    name,
    rect,
    resolver,
    onsave = (_scope: 'environment' | 'collection', _key: string, _value: string) => {},
    onmovesecret = (_key: string) => {},
    oneditenvironment = () => {},
    onkeepalive = () => {},
    onclose = () => {}
  }: {
    name: string;
    rect: DOMRect;
    resolver: Resolver;
    onsave?: (scope: 'environment' | 'collection', key: string, value: string) => void;
    onmovesecret?: (key: string) => void;
    oneditenvironment?: () => void;
    onkeepalive?: () => void;
    onclose?: () => void;
  } = $props();

  const info = $derived<VarInfo>(resolver.lookup(name));
  const activeEnv = $derived(resolver.activeEnvironment);
  const editable = $derived(info.scope !== 'dynamic' && (info.scope === 'collection' || Boolean(activeEnv)));

  // Re-seeded whenever the popover moves to a different variable.
  let draft = $state('');
  let seeded = '';
  $effect(() => {
    if (seeded !== name) {
      seeded = name;
      draft = info.secret ? '' : info.value;
    }
  });

  const scopeLabel = $derived(
    info.scope === 'environment'
      ? `environment · ${info.environmentName}`
      : info.scope === 'collection'
        ? 'collection variable'
        : info.scope === 'dynamic'
          ? 'dynamic — generated per request'
          : activeEnv
            ? `not defined — will be added to ${activeEnv.name}`
            : 'not defined — no environment selected'
  );

  /** Moving the pointer away must not discard what is being typed. */
  let holding = $state(false);

  function leave() {
    if (!holding) { onclose(); }
  }

  function commit() {
    if (!editable) { return; }
    if (info.secret && draft === '') { return onclose(); }
    onsave(info.scope === 'collection' ? 'collection' : 'environment', name, draft);
    onclose();
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); onclose(); }
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<div
  class="var-pop"
  role="dialog"
  tabindex="-1"
  aria-label="Edit {name}"
  style="left: {Math.max(4, Math.min(rect.left, window.innerWidth - 320))}px; top: {rect.bottom + 4}px;"
  onmouseenter={onkeepalive}
  onmouseleave={leave}
  onfocusin={() => { holding = true; onkeepalive(); }}
  onfocusout={() => (holding = false)}
>
  <div class="var-pop-head">
    <span class="var-pop-name">{name}</span>
    <span class="var-pop-scope">{scopeLabel}</span>
  </div>

  {#if info.scope === 'dynamic'}
    <div class="var-pop-note">
      Postman generates a fresh value for <code>{'{{'}{name}{'}}'}</code> on every send.
    </div>
  {:else if !editable}
    <div class="var-pop-note">
      Select an environment before setting a value.
    </div>
  {:else}
    <div class="var-pop-row">
      <input
        class="var-pop-input"
        type={info.secret ? 'password' : 'text'}
        spellcheck="false"
        placeholder={info.secret
          ? info.hasStoredSecret
            ? 'stored in keychain — type to replace'
            : 'no value stored yet'
          : 'value'}
        bind:value={draft}
        {onkeydown}
      />
      <button onclick={commit}>
        {info.scope === 'unresolved' ? 'Add' : 'Save'}
      </button>
    </div>
    {#if info.secret && info.plaintextInFile}
      <div class="var-pop-note warn">
        ⚠ This secret is stored in plaintext in the environment file.
      </div>
      <button
        class="var-pop-link"
        onclick={() => { onmovesecret(name); onclose(); }}
      >Move it into the OS keychain and blank it in the file</button>
    {:else if info.secret}
      <div class="var-pop-note">
        Secret — kept in the OS keychain, never written to the environment file.
      </div>
    {:else if !info.enabled}
      <div class="var-pop-note">
        This variable is unticked in the environment, so it will not resolve.
      </div>
    {/if}
  {/if}

  {#if activeEnv}
    <button class="var-pop-link" onclick={oneditenvironment}>Open the environment editor</button>
  {/if}
</div>
