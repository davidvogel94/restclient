<script lang="ts">
  import {
    languageTokens,
    mergeTokens,
    pathVariableTokens,
    renderTokens,
    variableTokens
  } from '../../src/shared/highlight';
  import type { TokenClass } from '../../src/shared/highlight';
  import type { Resolver, VarHover } from './vars';

  /**
   * A text field that shows syntax and `{{variable}}` colouring while staying a
   * real `<input>`/`<textarea>`.
   *
   * A coloured `<pre>` mirror sits underneath and the control on top renders its
   * own text transparently, so the caret, selection, IME, undo and spellcheck are
   * all the browser's rather than reimplemented. The mirror is `pointer-events:
   * none` from end to end — hovering a variable is detected by rect-testing the
   * pointer against the token spans, so nothing in the highlight layer can
   * intercept a click and break caret placement.
   */

  let {
    value = '',
    multiline = false,
    language = undefined,
    resolver = undefined,
    pathClassify = undefined,
    placeholder = '',
    spellcheck = false,
    fieldClass = '',
    rows = undefined,
    onfocuschange = (_focused: boolean) => {},
    oninput = (_value: string) => {},
    oncommit = (_value: string) => {},
    onvar = (_hit: VarHover | undefined) => {}
  }: {
    value?: string;
    multiline?: boolean;
    language?: string | undefined;
    resolver?: Resolver | undefined;
    /** Set only where `:name` path variables mean something: the URL bar. */
    pathClassify?: ((name: string) => TokenClass) | undefined;
    placeholder?: string;
    spellcheck?: boolean;
    fieldClass?: string;
    rows?: number | undefined;
    onfocuschange?: (focused: boolean) => void;
    oninput?: (value: string) => void;
    oncommit?: (value: string) => void;
    onvar?: (hit: VarHover | undefined) => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let text = $state(value);
  let mirror = $state<HTMLPreElement | undefined>(undefined);
  let control = $state<HTMLInputElement | HTMLTextAreaElement | undefined>(undefined);

  // Only adopt an incoming value when it genuinely changed upstream, otherwise
  // every re-render would fight whatever is being typed. Deliberately not
  // reactive state: it is a watermark, not something to render.
  // svelte-ignore state_referenced_locally
  let lastValue = value;
  $effect(() => {
    if (value !== lastValue) {
      lastValue = value;
      text = value;
    }
  });

  // `{{variables}}` go on last so they win over a path variable they sit inside.
  const html = $derived(
    renderTokens(
      text,
      mergeTokens(
        pathClassify
          ? mergeTokens(languageTokens(text, language), pathVariableTokens(text, pathClassify))
          : languageTokens(text, language),
        variableTokens(text, resolver?.classify)
      )
    )
  );

  let hovered: string | undefined;

  function handleInput(e: Event) {
    text = (e.currentTarget as HTMLInputElement | HTMLTextAreaElement).value;
    oninput(text);
  }

  function handleBlur() {
    onfocuschange(false);
    if (text !== value) {
      lastValue = text;
      oncommit(text);
    }
  }

  /** Keep the mirror scrolled exactly like the control it sits behind. */
  function syncScroll() {
    if (!mirror || !control) { return; }
    mirror.scrollTop = control.scrollTop;
    mirror.scrollLeft = control.scrollLeft;
  }

  /**
   * Which variable token, if any, is under the pointer. Rect-testing rather
   * than hit-testing because the mirror must stay click-through.
   */
  function handleMove(e: MouseEvent) {
    if (!mirror) { return; }
    let hit: VarHover | undefined;
    for (const span of mirror.querySelectorAll<HTMLElement>('[data-var]')) {
      const rect = span.getBoundingClientRect();
      if (
        e.clientX >= rect.left && e.clientX <= rect.right &&
        e.clientY >= rect.top && e.clientY <= rect.bottom
      ) {
        hit = { name: span.dataset.var ?? '', rect };
        break;
      }
    }
    if (hit?.name === hovered) { return; }
    hovered = hit?.name;
    onvar(hit);
  }

  function handleLeave() {
    if (hovered === undefined) { return; }
    hovered = undefined;
    onvar(undefined);
  }
</script>

<div
  class="hl-wrap {fieldClass}"
  class:multiline
  role="presentation"
  onmousemove={handleMove}
  onmouseleave={handleLeave}
>
  <pre class="hl-mirror" aria-hidden="true" bind:this={mirror}>{@html html}</pre>
  {#if multiline}
    <textarea
      class="hl-input"
      bind:this={control}
      {placeholder}
      {rows}
      spellcheck={spellcheck}
      value={text}
      oninput={handleInput}
      onscroll={syncScroll}
      onfocus={() => onfocuschange(true)}
      onblur={handleBlur}
    ></textarea>
  {:else}
    <input
      class="hl-input"
      bind:this={control}
      {placeholder}
      spellcheck={spellcheck}
      value={text}
      oninput={handleInput}
      onscroll={syncScroll}
      onfocus={() => onfocuschange(true)}
      onblur={handleBlur}
    />
  {/if}
</div>
