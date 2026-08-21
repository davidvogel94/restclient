import * as esbuild from 'esbuild';
import esbuildSvelte from 'esbuild-svelte';
import { sveltePreprocess } from 'svelte-preprocess';
import { readdirSync, existsSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const watch = process.argv.includes('--watch');
const prod = process.argv.includes('--production');

/**
 * The Postman stack is deliberately NOT bundled. Two reasons:
 *  1. postman-sandbox/lib/bootcode.js falls back to a live browserify+terser
 *     compile, and both are *static* requires — bundlers follow them and drag
 *     the whole of browserify in. (Postman's own extension ships browserify as
 *     a production dep because of this.)
 *  2. The prebuilt 2.3MB .cache/bootcode.js blob must survive intact.
 * These are listed in package.json `dependencies`, so vsce ships them as-is.
 */
const POSTMAN_STACK = [
  'postman-runtime',
  'postman-collection',
  'postman-collection-transformer',
  'postman-sandbox'
];

/**
 * Progress markers for the .vscode/tasks.json background problem matcher: the
 * `Run Extension` launch waits for "[watch] build finished" before it starts
 * the extension host. The esbuild JS API prints nothing of the sort itself.
 */
const watchMarkers = {
  name: 'watch-markers',
  setup(build) {
    build.onStart(() => console.log('[watch] build started'));
    build.onEnd(() => console.log('[watch] build finished'));
  }
};

/** Node-side bundles: the extension host entry and the forked runner. */
const nodeCommon = {
  bundle: true,
  format: 'cjs',
  // MUST be 'node'. postman-sandbox and uvm both declare `browser` field
  // remaps (worker.js -> worker.browser.js, bootcode.js -> bootcode.browser.js);
  // building for 'browser'/'webworker' silently swaps in Blob + Web Worker
  // and fails at runtime under Node.
  platform: 'node',
  target: 'node18',
  // postman-collection and chai both dispatch on Function.prototype.name.
  keepNames: true,
  // jsonc-parser's default entry is a UMD bundle whose inner requires go through
  // the UMD `require` parameter, so esbuild cannot resolve them statically and
  // leaves `require("./impl/format")` in the output — which then fails at
  // runtime. Its ESM build has plain static imports and bundles cleanly.
  alias: {
    'jsonc-parser': 'jsonc-parser/lib/esm/main.js'
  },
  sourcemap: !prod,
  minify: prod,
  logLevel: 'info',
  plugins: watch ? [watchMarkers] : []
};

const contexts = [
  await esbuild.context({
    ...nodeCommon,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    external: ['vscode', ...POSTMAN_STACK]
  }),
  await esbuild.context({
    ...nodeCommon,
    entryPoints: ['src/runner/runner.ts'],
    outfile: 'dist/runner.js',
    // The runner is forked, never loaded by the extension host, so it must not
    // reference 'vscode' at all (workers/forks cannot require it).
    external: [...POSTMAN_STACK]
  })
];

/** One browser bundle per webview app, discovered from webview/<name>/main.ts. */
const webviewApps = readdirSync('webview', { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join('webview', d.name, 'main.ts')))
  .map((d) => d.name);

if (webviewApps.length) {
  contexts.push(
    await esbuild.context({
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      entryPoints: Object.fromEntries(webviewApps.map((n) => [n, `webview/${n}/main.ts`])),
      outdir: 'dist/webview',
      sourcemap: !prod,
      minify: prod,
      logLevel: 'info',
      // CSP forbids inline <style>, so CSS is emitted as a sibling file and
      // loaded through webview.asWebviewUri().
      plugins: [
        esbuildSvelte({
          preprocess: sveltePreprocess(),
          compilerOptions: { css: 'external' }
        }),
        ...(watch ? [watchMarkers] : [])
      ]
    })
  );
}

// Codicons ship as a font + stylesheet the webviews load via asWebviewUri.
for (const f of ['codicon.css', 'codicon.ttf']) {
  const src = join('node_modules/@vscode/codicons/dist', f);
  const dest = join('dist/webview/codicons', f);
  if (existsSync(src)) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
}

/**
 * A bundled file must never contain a *relative* require: those resolve against
 * dist/ at runtime and throw. UMD packages are the usual culprit — their inner
 * requires go through the UMD `require` parameter, so esbuild leaves them alone
 * and activation fails with "Cannot find module './impl/...'".
 */
function assertNoRelativeRequires(file) {
  const source = readFileSync(file, 'utf8');
  const found = new Set();
  // esbuild renames a UMD wrapper's `require` parameter (to `require2`, etc.),
  // so match any callee whose name contains "require", not just the bare word.
  for (const match of source.matchAll(/[\w$]*require[\w$]*\s*\(\s*["'](\.\.?\/[^"']+)["']\s*\)/g)) {
    found.add(match[1]);
  }
  if (found.size) {
    console.error(`\n${file} contains unbundled relative requires:`);
    for (const spec of found) { console.error(`  require("${spec}")`); }
    console.error('Alias the offending package to its ESM build in esbuild.mjs.\n');
    process.exit(1);
  }
}

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('[watch] esbuild watching');
} else {
  await Promise.all(contexts.map(async (c) => { await c.rebuild(); await c.dispose(); }));
  assertNoRelativeRequires('dist/extension.js');
  assertNoRelativeRequires('dist/runner.js');
}
