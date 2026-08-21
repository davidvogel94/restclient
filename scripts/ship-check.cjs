/**
 * Ship check: run the forked runner out of an EXTRACTED .vsix, using only the
 * node_modules that were packaged. This is where bundling mistakes surface —
 * a missing postman-sandbox bootcode blob only fails here, never in the dev tree.
 *
 * Usage: node scripts/ship-check.cjs <path-to-vsix>
 */
const { execFileSync } = require('node:child_process');
const { RunnerClient } = require('../out/src/runner/client.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert');

const vsix = process.argv[2] || 'restclient-0.0.1.vsix';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restclient-ship-'));
execFileSync('unzip', ['-q', vsix, '-d', dir]);

const runnerPath = path.join(dir, 'extension', 'dist', 'runner.js');
assert.ok(fs.existsSync(runnerPath), 'packaged runner missing');
console.log('extracted to', dir);

/**
 * Every unbundled require in the two bundles, loaded out of the packaged tree.
 *
 * The extension host requires these at module load, so one that cannot resolve
 * — or that resolves to a wrong-major transitive dep — takes activation down
 * before a single command is registered, and every button in the UI reports
 * "command not found". The dev tree cannot show it: only vsce decides which
 * nested copies of a package get packaged, and it has been wrong about that
 * (a hoisted lru-cache@10 shipped where semver wanted lru-cache@6).
 *
 * Derived from the bundles rather than listed by hand, so adding an external
 * to esbuild.mjs brings it under this check automatically.
 */
function externalRequires(file) {
  const source = fs.readFileSync(file, 'utf8');
  const specs = new Set();
  for (const [, spec] of source.matchAll(/require\(\s*["'](@?[a-z][^"'.][^"']*)["']\s*\)/g)) {
    // 'vscode' is supplied by the host, and builtins are never packaged.
    if (spec === 'vscode' || require('node:module').isBuiltin(spec)) { continue; }
    specs.add(spec);
  }
  return [...specs].sort();
}

const extensionDir = path.join(dir, 'extension');
for (const bundle of ['extension.js', 'runner.js']) {
  const specs = externalRequires(path.join(extensionDir, 'dist', bundle));
  for (const spec of specs) {
    try {
      execFileSync(process.execPath, ['-e', `require(${JSON.stringify(spec)})`], {
        cwd: extensionDir,
        stdio: 'pipe'
      });
    } catch (e) {
      console.error(`\ndist/${bundle} requires "${spec}", which does not load from the packaged node_modules:`);
      console.error(String(e.stderr ?? e).trim());
      console.error('\nA nested dependency is probably missing from the .vsix — compare');
      console.error('`vsce ls` against `npm ls --omit=dev --all`.\n');
      process.exit(1);
    }
  }
  console.log(`dist/${bundle}: ${specs.length} external require(s) load from the packaged tree`);
}

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, auth: req.headers.authorization ?? null }));
});

server.listen(0, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = new RunnerClient(runnerPath, (l) => process.env.VERBOSE && console.log(l));
  const assertions = [];
  let code;

  const handle = client.run(
    {
      info: { name: 'ship', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [{
        name: 'check',
        event: [{ listen: 'test', script: { exec: [
          "const _ = require('lodash');",
          "pm.test('sandbox booted from packaged node_modules', function () { pm.expect(pm.response.json().ok).to.eql(true); });",
          "pm.test('script stdlib is present', function () { pm.expect(_.toUpper('x')).to.eql('X'); });",
          "pm.test('auth helper ran', function () { pm.expect(pm.response.json().auth).to.match(/^Bearer /); });"
        ] } }],
        request: {
          method: 'GET',
          auth: { type: 'bearer', bearer: [{ key: 'token', value: 'abc' }] },
          url: `${url}/x`
        }
      }]
    },
    { allowScripts: true, environment: { values: [] }, workspaceRoot: dir }
  );

  handle.on('message', (m) => {
    if (m.type === 'assertion') { assertions.push(...m.assertions); }
    if (m.type === 'response') { code = m.response.code; }
    if (m.type === 'requestError') { console.error('request error:', m.message); }
  });

  await handle.completion;
  client.dispose();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });

  const failed = assertions.filter((a) => !a.passed);
  console.log(`HTTP ${code}, ${assertions.length} assertion(s):`);
  assertions.forEach((a) => console.log(`  ${a.passed ? 'pass' : 'FAIL'} ${a.name}`));

  assert.equal(code, 200, 'packaged runner should complete the request');
  assert.equal(assertions.length, 3, 'all three tests should report');
  assert.equal(failed.length, 0, 'no test may fail');
  console.log('\nSHIP CHECK PASS — packaged .vsix boots the sandbox and runs pm.* scripts');
  process.exit(0);
});
