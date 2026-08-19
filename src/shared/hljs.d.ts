/**
 * highlight.js has no `types` condition for its `./lib/core` and
 * `./lib/languages/*` subpath exports, so Node16 resolution cannot find the
 * `.d.ts` files sitting next to them. Only the two entry points this project
 * uses are declared, with just the surface it calls.
 */

declare module 'highlight.js/lib/core' {
  export interface HighlightResult {
    value: string;
    language?: string;
    relevance: number;
  }
  export interface HLJSApi {
    registerLanguage(name: string, language: unknown): void;
    getLanguage(name: string): unknown | undefined;
    highlight(code: string, options: { language: string; ignoreIllegals?: boolean }): HighlightResult;
  }
  const hljs: HLJSApi;
  export default hljs;
}

declare module 'highlight.js/lib/languages/json' {
  const language: unknown;
  export default language;
}
declare module 'highlight.js/lib/languages/javascript' {
  const language: unknown;
  export default language;
}
declare module 'highlight.js/lib/languages/xml' {
  const language: unknown;
  export default language;
}
declare module 'highlight.js/lib/languages/plaintext' {
  const language: unknown;
  export default language;
}
