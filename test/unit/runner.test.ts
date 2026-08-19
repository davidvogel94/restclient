import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RunnerClient } from '../../src/runner/client';
import type { RunnerMessage } from '../../src/runner/protocol';

const REPO = path.resolve(__dirname, '../../..');
const RUNNER = path.join(REPO, 'dist/runner.js');

/** Minimal API the smoke collection talks to. Keeps the test hermetic. */
function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const auth = req.headers.authorization ?? null;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Set-Cookie', 'session=abc123; Path=/');

    if (url.pathname === '/login') {
      let body = '';
      req.on('data', (c) => (body += c));
      return req.on('end', () => {
        res.end(JSON.stringify({ token: 'tok-' + Buffer.from(body).length, sawAuth: auth, echo: body }));
      });
    }
    if (url.pathname === '/me') {
      return res.end(JSON.stringify({
        sawAuth: auth,
        query: Object.fromEntries(url.searchParams.entries())
      }));
    }
    if (url.pathname === '/ping') { return res.end(JSON.stringify({ pong: true })); }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r()))
      });
    });
  });
}

interface Collected {
  messages: RunnerMessage[];
  assertions: Array<{ name: string; passed: boolean; error?: string }>;
  consoleLines: string[];
  responses: number[];
  error?: string;
}

async function runCollection(
  collection: unknown,
  env: Array<{ key: string; value: string; type?: string }>,
  opts: Partial<Parameters<RunnerClient['run']>[1]> = {}
): Promise<Collected> {
  const client = new RunnerClient(RUNNER);
  const collected: Collected = { messages: [], assertions: [], consoleLines: [], responses: [] };
  try {
    const handle = client.run(collection as any, {
      allowScripts: true,
      environment: { values: env },
      workspaceRoot: REPO,
      timeout: { script: 15000, request: 15000 },
      ...opts
    });
    handle.on('message', (m) => {
      collected.messages.push(m);
      if (m.type === 'assertion') {
        for (const a of m.assertions) {
          collected.assertions.push({ name: a.name, passed: a.passed, error: a.error?.message });
        }
      }
      if (m.type === 'console') { collected.consoleLines.push(m.messages.join(' ')); }
      if (m.type === 'response') { collected.responses.push(m.response.code); }
      if (m.type === 'requestError') { collected.error = m.message; }
    });
    handle.on('done', (e) => { if (e) { collected.error = e; } });
    await handle.completion;
    return collected;
  } finally {
    client.dispose();
  }
}

test('runs a real Postman v2.1 collection with scripts, auth and chaining', async () => {
  assert.ok(fs.existsSync(RUNNER), 'dist/runner.js must be built first (npm run build)');
  const server = await startServer();
  try {
    const collection = JSON.parse(
      fs.readFileSync(path.join(REPO, 'fixtures/collections/smoke.postman_collection.json'), 'utf8')
    );

    const r = await runCollection(collection, [
      { key: 'baseUrl', value: server.url },
      { key: 'user', value: 'alice' },
      { key: 'pass', value: 's3cr3t' }
    ]);

    assert.equal(r.error, undefined, 'run should not error');
    // Only collection-level items land here; the nested pm.sendRequest to
    // /ping is deliberately not surfaced as a response.
    assert.deepEqual(r.responses, [200, 200], 'both collection requests should return 200');

    const failed = r.assertions.filter((a) => !a.passed);
    assert.deepEqual(
      failed.map((f) => `${f.name}: ${f.error}`),
      [],
      'every pm.test should pass'
    );
    assert.deepEqual(
      r.assertions.map((a) => a.name),
      [
        'login returns 200',
        'token issued',
        'basic auth was applied from collection level',
        'collection prerequest ran',
        'bearer token from previous request was used',
        'prerequest local var interpolated into query',
        // async: only reports once its done() callback fires
        'sendRequest works'
      ],
      'every pm.test should be reported, in order'
    );
    assert.ok(r.consoleLines.includes('me-request-finished'), 'console.log should be forwarded');

    // Scripts mutated the environment; the extension persists what comes back.
    const scope = r.messages.find((m) => m.type === 'scopeChanged' && m.scope === 'environment');
    assert.ok(scope && scope.type === 'scopeChanged');
    const token = scope.values.find((v) => v.key === 'token');
    assert.ok(token && String(token.value).startsWith('tok-'), 'pm.environment.set should round-trip');
  } finally {
    await server.close();
  }
});

test('untrusted workspace: scripts are stripped but the request still sends', async () => {
  const server = await startServer();
  try {
    const collection = JSON.parse(
      fs.readFileSync(path.join(REPO, 'fixtures/collections/smoke.postman_collection.json'), 'utf8')
    );
    const r = await runCollection(
      collection,
      [
        { key: 'baseUrl', value: server.url },
        { key: 'user', value: 'alice' },
        { key: 'pass', value: 's3cr3t' }
      ],
      { allowScripts: false }
    );
    assert.equal(r.assertions.length, 0, 'no pm.test should run without script permission');
    assert.ok(r.responses.length > 0, 'requests should still be sent');
  } finally {
    await server.close();
  }
});

test('secrets are injected from SecretStorage rather than the collection file', async () => {
  const server = await startServer();
  try {
    const collection = {
      info: { name: 'secret', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [{
        name: 'echo',
        event: [{
          listen: 'test',
          script: { exec: ["pm.test('secret reached the wire', function () { pm.expect(pm.response.json().query.k).to.eql('injected-secret'); });"] }
        }],
        request: { method: 'GET', url: '{{baseUrl}}/me?k={{apiKey}}' }
      }]
    };
    const r = await runCollection(
      collection,
      // Note the blanked value — this is what is safe to commit.
      [{ key: 'baseUrl', value: server.url }, { key: 'apiKey', value: '', type: 'secret' }],
      { secrets: { apiKey: 'injected-secret' } }
    );
    assert.deepEqual(r.assertions.filter((a) => !a.passed), []);
    assert.equal(r.assertions.length, 1);
  } finally {
    await server.close();
  }
});

test('cookies persist across runs through the serialized jar', async () => {
  // A server that sets a session cookie and reports what it received back.
  const server = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const s = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/login') {
        res.setHeader('Set-Cookie', 'session=abc123; Path=/; HttpOnly');
      }
      res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
    });
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => s.close(() => r()))
      });
    });
  });

  try {
    const collection = (path_: string) => ({
      info: { name: 'cookies', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [{ name: 'req', request: { method: 'GET', url: `{{baseUrl}}${path_}` } }]
    });

    // Run 1: log in and capture the jar the runner hands back.
    const first = await runCollection(collection('/login'), [{ key: 'baseUrl', value: server.url }]);
    assert.equal(first.error, undefined);

    const jarMsg = first.messages.find((m) => m.type === 'cookieJarChanged');
    assert.ok(jarMsg && jarMsg.type === 'cookieJarChanged', 'the runner must return the cookie jar');
    const cookies = (jarMsg.jar as any).cookies;
    assert.equal(cookies.length, 1, 'one cookie should have been stored');
    assert.equal(cookies[0].key, 'session');

    // Run 2: feed the jar back in; the cookie must be sent automatically.
    const second = await runCollection(
      collection('/me'),
      [{ key: 'baseUrl', value: server.url }],
      { cookieJar: jarMsg.jar }
    );
    const response = second.messages.find((m) => m.type === 'response');
    assert.ok(response && response.type === 'response');
    const body = JSON.parse(Buffer.from(response.response.bodyBase64, 'base64').toString('utf8'));
    assert.equal(body.cookie, 'session=abc123', 'the stored cookie must be replayed');

    // And with cookies disabled it must not be.
    const third = await runCollection(
      collection('/me'),
      [{ key: 'baseUrl', value: server.url }],
      { cookieJar: jarMsg.jar, disableCookies: true }
    );
    const thirdResponse = third.messages.find((m) => m.type === 'response');
    assert.ok(thirdResponse && thirdResponse.type === 'response');
    const thirdBody = JSON.parse(
      Buffer.from(thirdResponse.response.bodyBase64, 'base64').toString('utf8')
    );
    assert.equal(thirdBody.cookie, null, 'disableCookies must suppress the jar');
  } finally {
    await server.close();
  }
});

test('pm.vault reads from the injected vault and reports writes back', async () => {
  const server = await startServer();
  try {
    const collection = {
      info: { name: 'vault', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [{
        name: 'v',
        event: [{
          listen: 'prerequest',
          script: { exec: [
            "const existing = await pm.vault.get('apiKey');",
            "pm.variables.set('fromVault', existing);",
            "await pm.vault.set('issued', 'new-value');"
          ] }
        }, {
          listen: 'test',
          script: { exec: [
            "pm.test('vault value reached the request', function () {",
            "  pm.expect(pm.response.json().query.k).to.eql('vault-secret');",
            "});"
          ] }
        }],
        request: { method: 'GET', url: '{{baseUrl}}/me?k={{fromVault}}' }
      }]
    };

    const r = await runCollection(collection, [{ key: 'baseUrl', value: server.url }], {
      vault: { apiKey: 'vault-secret' }
    });

    assert.deepEqual(r.assertions.filter((a) => !a.passed), [], 'vault read should reach the wire');

    const vaultMsg = r.messages.find((m) => m.type === 'vaultChanged');
    assert.ok(vaultMsg && vaultMsg.type === 'vaultChanged');
    assert.equal(vaultMsg.values.issued, 'new-value', 'pm.vault.set must be reported back');
    assert.equal(vaultMsg.values.apiKey, 'vault-secret', 'existing vault entries survive');
  } finally {
    await server.close();
  }
});

test('all http traffic is reported for the console, including pm.sendRequest', async () => {
  const server = await startServer();
  try {
    const collection = {
      info: { name: 'traffic', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [{
        name: 'main',
        event: [{
          listen: 'test',
          script: { exec: [
            "pm.sendRequest(pm.environment.get('baseUrl') + '/ping', function () {});"
          ] }
        }],
        request: { method: 'GET', url: '{{baseUrl}}/me' }
      }]
    };

    const r = await runCollection(collection, [{ key: 'baseUrl', value: server.url }]);

    const traffic = r.messages.filter((m) => m.type === 'httpTraffic');
    assert.equal(traffic.length, 2, 'console sees both the item request and the nested one');
    assert.ok(
      traffic.some((m) => m.type === 'httpTraffic' && m.request.url.endsWith('/ping')),
      'the nested pm.sendRequest call is reported'
    );

    // The response pane must still only see the collection-level request.
    assert.equal(r.messages.filter((m) => m.type === 'response').length, 1);
  } finally {
    await server.close();
  }
});

test('Set-Cookie headers populate the response cookies shown in the UI', async () => {
  const server = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const s = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Set-Cookie', [
        'session=abc123; Path=/; HttpOnly',
        'theme=dark; Path=/; Max-Age=3600'
      ]);
      res.end(JSON.stringify({ ok: true, sawCookie: req.headers.cookie ?? null }));
    });
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => s.close(() => r()))
      });
    });
  });

  try {
    const collection = {
      info: { name: 'setcookie', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [{ name: 'login', request: { method: 'GET', url: '{{baseUrl}}/login' } }]
    };

    const r = await runCollection(collection, [{ key: 'baseUrl', value: server.url }]);
    const response = r.messages.find((m) => m.type === 'response');
    assert.ok(response && response.type === 'response');

    const cookies = response.response.cookies;
    assert.equal(cookies.length, 2, `expected both cookies, got ${JSON.stringify(cookies)}`);

    const session = cookies.find((c) => c.name === 'session')!;
    assert.ok(session, 'the session cookie must be reported');
    assert.equal(session.value, 'abc123');
    assert.equal(session.path, '/');
    assert.equal(session.httpOnly, true);
    assert.equal(session.domain, '127.0.0.1');

    const theme = cookies.find((c) => c.name === 'theme')!;
    assert.equal(theme.value, 'dark');
    assert.equal(theme.maxAge, 3600);
  } finally {
    await server.close();
  }
});

test('response cookies still appear when the jar is disabled', async () => {
  const server = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const s = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Set-Cookie', 'session=xyz; Path=/api; Secure; SameSite=Lax');
      res.end('{}');
    });
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => s.close(() => r()))
      });
    });
  });

  try {
    const collection = {
      info: { name: 'nojar', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [{ name: 'x', request: { method: 'GET', url: '{{baseUrl}}/api' } }]
    };

    // With cookies disabled the jar stays empty, so this exercises the
    // Set-Cookie header fallback.
    const r = await runCollection(collection, [{ key: 'baseUrl', value: server.url }], {
      disableCookies: true
    });
    const response = r.messages.find((m) => m.type === 'response');
    assert.ok(response && response.type === 'response');

    const cookies = response.response.cookies;
    assert.equal(cookies.length, 1, `expected the header fallback, got ${JSON.stringify(cookies)}`);
    assert.equal(cookies[0].name, 'session');
    assert.equal(cookies[0].value, 'xyz');
    assert.equal(cookies[0].path, '/api');
    assert.equal(cookies[0].secure, true);
    assert.equal(cookies[0].sameSite, 'Lax');
  } finally {
    await server.close();
  }
});

test('pm.visualizer output is returned already rendered', async () => {
  const server = await startServer();
  try {
    const collection = {
      info: { name: 'viz', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [{
        name: 'v',
        event: [{
          listen: 'test',
          script: { exec: [
            "const template = '<h1>{{title}}</h1><ul>{{#each rows}}<li>{{this}}</li>{{/each}}</ul>';",
            "pm.visualizer.set(template, { title: 'Report', rows: ['a', 'b'] });"
          ] }
        }],
        request: { method: 'GET', url: '{{baseUrl}}/me' }
      }]
    };

    const r = await runCollection(collection, [{ key: 'baseUrl', value: server.url }]);
    const viz = r.messages.find((m) => m.type === 'visualizer');
    assert.ok(viz && viz.type === 'visualizer', 'a visualizer message should be emitted');

    // postman-runtime runs handlebars itself, so what arrives is finished HTML.
    assert.match(viz.html, /<h1>Report<\/h1>/);
    assert.match(viz.html, /<li>a<\/li>/);
    assert.match(viz.html, /<li>b<\/li>/);
    assert.ok(!viz.html.includes('{{'), 'the template must already be interpolated');
  } finally {
    await server.close();
  }
});

test('the file resolver refuses to read outside the workspace', async () => {
  const server = await startServer();
  const jail = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'restclient-jail-'));
  try {
    const collection = {
      info: { name: 'traversal', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [{
        name: 'upload',
        request: {
          method: 'POST',
          url: '{{baseUrl}}/login',
          body: { mode: 'file', file: { src: '../../../../etc/passwd' } }
        }
      }]
    };
    const r = await runCollection(collection, [{ key: 'baseUrl', value: server.url }], { workspaceRoot: jail });

    // postman-runtime downgrades an unreadable body file to a console warning
    // and sends the request without it — the same as Postman and Newman. The
    // security property under test is that no file content leaves the jail.
    const warning = r.consoleLines.find((l) => /Refusing to read/.test(l));
    assert.ok(warning, `expected a refusal warning, got: ${JSON.stringify(r.consoleLines)}`);
    assert.match(warning!, /outside the workspace folder/);

    const sent = r.messages.find((m) => m.type === 'response');
    assert.ok(sent && sent.type === 'response');
    assert.equal(sent.request.body, undefined, 'no file contents may be sent');
  } finally {
    fs.rmSync(jail, { recursive: true, force: true });
    await server.close();
  }
});
