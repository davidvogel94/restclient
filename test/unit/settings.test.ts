import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as http from 'node:http';
import * as path from 'node:path';
import { buildRequestEdits } from '../../src/collections/edits';
import { applyJsonEdits } from '../../src/collections/jsonEdit';
import { materialize } from '../../src/collections/model';
import { buildRequestView } from '../../src/collections/view';
import {
  REQUEST_SETTINGS,
  coerceSetting,
  ownSettings,
  usesUrlEncodingBehavior
} from '../../src/collections/settings';
import { RunnerClient } from '../../src/runner/client';
import type { RunnerMessage } from '../../src/runner/protocol';

const REPO = path.resolve(__dirname, '../../..');
const RUNNER = path.join(REPO, 'dist/runner.js');

/**
 * A collection with one folder, one request inside it and one at the root, so
 * inheritance has somewhere to come from.
 */
function fixture(): string {
  return JSON.stringify(
    {
      info: { name: 'Settings', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [
        { name: 'Root', request: { method: 'GET', url: 'https://example.com/a' } },
        {
          name: 'Folder',
          protocolProfileBehavior: { followRedirects: false, strictSSL: true },
          item: [{ name: 'Nested', request: { method: 'GET', url: 'https://example.com/b' } }]
        }
      ]
    },
    null,
    '\t'
  );
}

function viewFor(text: string, name: string) {
  const { tree, json } = materialize(JSON.parse(text));
  const find = (nodes: any[]): any => {
    for (const n of nodes) {
      if (n.name === name) { return n; }
      const hit = find(n.children);
      if (hit) { return hit; }
    }
  };
  const node = find(tree);
  return { node, json, view: buildRequestView(json, 'Settings', node)! };
}

/** Apply one setting edit and hand back both the text and the reparsed item. */
function setSetting(text: string, name: string, key: string, value: unknown) {
  const { node, json } = viewFor(text, name);
  let raw: any = json;
  for (const segment of node.jsonPath) { raw = raw?.[segment]; }
  const after = applyJsonEdits(
    text,
    buildRequestEdits(node.jsonPath, raw, { field: 'setting', key, value } as any)
  );
  const reparsed = viewFor(after, name);
  return { after, item: (() => {
    let cursor: any = JSON.parse(after);
    for (const segment of node.jsonPath) { cursor = cursor?.[segment]; }
    return cursor;
  })(), view: reparsed.view };
}

test('every catalogued setting is a behaviour the engine actually resolves', () => {
  // The list is only worth having if it matches PPB_OPTS and the handful of
  // keys core.js special-cases; a typo here is a control that does nothing.
  const engineKeys = new Set([
    'strictSSL',
    'maxRedirects',
    'followRedirects',
    'insecureHTTPParser',
    'followAuthorizationHeader',
    'followOriginalHttpMethod',
    'removeRefererHeaderOnRedirect',
    'protocolVersion',
    'disableCookies',
    'disableUrlEncoding',
    'disabledSystemHeaders',
    'disableBodyPruning',
    'tlsPreferServerCiphers',
    'tlsDisabledProtocols',
    'tlsCipherSelection'
  ]);

  assert.deepEqual(
    new Set(REQUEST_SETTINGS.map((s) => s.key)),
    engineKeys,
    'the catalogue and the engine must agree, in both directions'
  );
});

test('a setting is written onto the item, beside request rather than inside it', () => {
  const { item, after } = setSetting(fixture(), 'Root', 'followRedirects', false);
  assert.deepEqual(item.protocolProfileBehavior, { followRedirects: false });
  assert.equal(item.request.method, 'GET', 'the request itself is untouched');
  assert.ok(after.includes('\t\t\t"followRedirects"'), 'tab indentation is preserved');
});

test('unsetting the last setting removes protocolProfileBehavior entirely', () => {
  const withOne = setSetting(fixture(), 'Root', 'strictSSL', true).after;
  const cleared = setSetting(withOne, 'Root', 'strictSSL', undefined);
  assert.equal(
    'protocolProfileBehavior' in cleared.item,
    false,
    'no empty husk is left behind — Postman omits the key'
  );
  assert.equal(cleared.after, fixture(), 'the file is byte-identical to before');
});

test('unsetting one of several settings leaves the others alone', () => {
  const two = setSetting(setSetting(fixture(), 'Root', 'strictSSL', true).after, 'Root', 'maxRedirects', 3);
  const cleared = setSetting(two.after, 'Root', 'strictSSL', undefined);
  assert.deepEqual(cleared.item.protocolProfileBehavior, { maxRedirects: 3 });
});

test('only undefined resets; an explicit empty value is written as the override it is', () => {
  const withList = setSetting(fixture(), 'Root', 'tlsDisabledProtocols', ['TLSv1']).after;

  const reset = setSetting(withList, 'Root', 'tlsDisabledProtocols', undefined);
  assert.equal('protocolProfileBehavior' in reset.item, false, 'no `[]` left in the file');

  // A request under a folder that disables a protocol has no other way to say
  // "not here" — so an empty value must survive when it is asked for.
  const emptied = setSetting(withList, 'Root', 'tlsDisabledProtocols', []);
  assert.deepEqual(emptied.item.protocolProfileBehavior, { tlsDisabledProtocols: [] });
});

test('settings resolve up the tree, with the request winning over its folder', () => {
  const { view } = viewFor(fixture(), 'Nested');
  assert.deepEqual(view.settings.own, {}, 'the request itself sets nothing');
  assert.deepEqual(view.settings.inherited, { followRedirects: false, strictSSL: true });
  assert.deepEqual(view.settings.inheritedFrom, { followRedirects: 'Folder', strictSSL: 'Folder' });

  const overridden = setSetting(fixture(), 'Nested', 'followRedirects', true);
  assert.deepEqual(overridden.view.settings.own, { followRedirects: true });
  assert.deepEqual(
    overridden.view.settings.inherited,
    { strictSSL: true },
    'the folder still supplies the keys the request is silent on'
  );
});

test('a nearer container shadows a further one', () => {
  const json = JSON.parse(fixture());
  json.protocolProfileBehavior = { followRedirects: true, maxRedirects: 2 };
  const { view } = viewFor(JSON.stringify(json, null, '\t'), 'Nested');
  assert.equal(view.settings.inherited.followRedirects, false, 'the folder wins over the collection');
  assert.equal(view.settings.inheritedFrom.followRedirects, 'Folder');
  assert.equal(view.settings.inherited.maxRedirects, 2, 'and the collection still supplies the rest');
  assert.equal(view.settings.inheritedFrom.maxRedirects, 'Settings');
});

test('values the engine would not act on are not presented as settings', () => {
  assert.equal(coerceSetting('followRedirects', 'yes'), undefined, 'a string is not a boolean');
  assert.equal(coerceSetting('maxRedirects', -1), undefined, 'a negative hop count is nonsense');
  assert.equal(coerceSetting('maxRedirects', '5'), 5, 'a numeric string is still a number');
  assert.equal(coerceSetting('protocolVersion', 'http3'), undefined, 'not a version it negotiates');
  assert.deepEqual(coerceSetting('tlsDisabledProtocols', ['TLSv1', 'SSLv2']), ['TLSv1'],
    'only versions the engine can refuse');
  assert.deepEqual(
    coerceSetting('disabledSystemHeaders', { 'User-Agent': true, 'x-mine': true, accept: false }),
    { 'user-agent': true },
    'lower-cased, and only the headers the engine adds itself'
  );

  assert.deepEqual(
    ownSettings({ protocolProfileBehavior: { followRedirects: 'nope', strictSSL: true } }),
    { strictSSL: true },
    'a garbage value is skipped rather than shown as in force'
  );
});

test('the WHATWG url parser is switched on only when a collection asks about encoding', () => {
  assert.equal(usesUrlEncodingBehavior(JSON.parse(fixture())), false);

  const json = JSON.parse(fixture());
  json.item[1].item[0].protocolProfileBehavior = { disableUrlEncoding: true };
  assert.equal(usesUrlEncodingBehavior(json), true, 'found on a request nested in a folder');
});

// --- and now that the engine honours them on the wire ---------------------

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * A server that records what it was sent and redirects `/hop` onwards, so a
 * setting's effect is observable rather than merely configured.
 */
function startServer(): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const url = new URL(req.url ?? '/', 'http://localhost');

      // A different port is a different origin, which is what makes the
      // engine consider dropping credentials on the way through.
      if (url.pathname === '/away') {
        res.statusCode = 302;
        res.setHeader('Location', url.searchParams.get('to') ?? '/end');
        return res.end();
      }

      if (url.pathname === '/hop') {
        const left = Number(url.searchParams.get('n') ?? '1');
        res.statusCode = 302;
        res.setHeader('Location', left > 1 ? `/hop?n=${left - 1}` : '/end');
        return res.end();
      }

      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, path: url.pathname }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}`,
        seen,
        close: () => new Promise<void>((r) => server.close(() => r()))
      });
    });
  });
}

async function run(collection: unknown, opts: Record<string, unknown> = {}) {
  const client = new RunnerClient(RUNNER);
  const messages: RunnerMessage[] = [];
  try {
    const handle = client.run(collection as any, {
      allowScripts: false,
      environment: { values: [] },
      workspaceRoot: REPO,
      timeout: { script: 15000, request: 15000 },
      ...opts
    } as any);
    handle.on('message', (m) => messages.push(m));
    await handle.completion;
    return messages;
  } finally {
    client.dispose();
  }
}

/** One request, wrapped in the folder its settings may come from. */
function oneRequest(
  request: Record<string, unknown>,
  itemBehavior?: Record<string, unknown>,
  folderBehavior?: Record<string, unknown>
) {
  const item: Record<string, unknown> = { name: 'Only', request };
  if (itemBehavior) { item.protocolProfileBehavior = itemBehavior; }
  return {
    info: { name: 'T', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [
      folderBehavior
        ? { name: 'Folder', protocolProfileBehavior: folderBehavior, item: [item] }
        : item
    ]
  };
}

const codeOf = (messages: RunnerMessage[]) =>
  messages.find((m): m is Extract<RunnerMessage, { type: 'response' }> => m.type === 'response')
    ?.response.code;

test('followRedirects on the request is obeyed, and overrides its folder', async () => {
  const server = await startServer();
  try {
    const url = `${server.url}/hop?n=1`;

    const followed = await run(oneRequest({ method: 'GET', url }));
    assert.equal(codeOf(followed), 200, 'redirects are followed by default');

    const stopped = await run(
      oneRequest({ method: 'GET', url }, { followRedirects: false })
    );
    assert.equal(codeOf(stopped), 302, 'the request setting stops the follow');

    // The folder says no; the request says yes. The request must win.
    const overridden = await run(
      oneRequest({ method: 'GET', url }, { followRedirects: true }, { followRedirects: false })
    );
    assert.equal(codeOf(overridden), 200, 'the nearer setting wins');

    const inherited = await run(
      oneRequest({ method: 'GET', url }, undefined, { followRedirects: false })
    );
    assert.equal(codeOf(inherited), 302, 'and a silent request takes the folder’s');
  } finally {
    await server.close();
  }
});

test('a per-request setting beats the workspace default', async () => {
  const server = await startServer();
  try {
    // The workspace says follow; the request says do not.
    const messages = await run(
      oneRequest({ method: 'GET', url: `${server.url}/hop?n=1` }, { followRedirects: false }),
      { followRedirects: true }
    );
    assert.equal(codeOf(messages), 302);
  } finally {
    await server.close();
  }
});

test('maxRedirects caps the chain', async () => {
  const server = await startServer();
  try {
    const messages = await run(
      oneRequest({ method: 'GET', url: `${server.url}/hop?n=5` }, { maxRedirects: 2 })
    );
    const failed = messages.find((m) => m.type === 'requestError');
    assert.ok(failed, 'exceeding the cap is an error, not a silent stop');
  } finally {
    await server.close();
  }
});

test('disabledSystemHeaders keeps the named headers off the wire', async () => {
  const server = await startServer();
  try {
    await run(
      oneRequest(
        { method: 'GET', url: `${server.url}/plain` },
        { disabledSystemHeaders: { 'user-agent': true, accept: true, 'accept-encoding': true } }
      )
    );

    const sent = server.seen.at(-1)!;
    assert.equal(sent.headers['user-agent'], undefined, 'no User-Agent was sent');
    assert.equal(sent.headers['accept'], undefined, 'no Accept was sent');
    assert.equal(sent.headers['accept-encoding'], undefined, 'no Accept-Encoding was sent');
    assert.ok(sent.headers['host'], 'a header that was not disabled is still there');
  } finally {
    await server.close();
  }
});

test('system headers are sent when nothing disables them', async () => {
  const server = await startServer();
  try {
    await run(oneRequest({ method: 'GET', url: `${server.url}/plain` }));
    const sent = server.seen.at(-1)!;
    assert.match(String(sent.headers['user-agent']), /PostmanRuntime/);
    assert.equal(sent.headers['accept'], '*/*');
  } finally {
    await server.close();
  }
});

test('disableBodyPruning sends a body on a GET', async () => {
  const server = await startServer();
  try {
    const body = { mode: 'raw', raw: '{"q":1}', options: { raw: { language: 'json' } } };

    await run(oneRequest({ method: 'GET', url: `${server.url}/plain`, body }));
    assert.equal(server.seen.at(-1)!.body, '', 'the engine prunes a GET body by default');

    await run(
      oneRequest({ method: 'GET', url: `${server.url}/plain`, body }, { disableBodyPruning: true })
    );
    assert.equal(server.seen.at(-1)!.body, '{"q":1}', 'and sends it when told to');
  } finally {
    await server.close();
  }
});

test('followAuthorizationHeader controls whether credentials cross a redirect', async () => {
  // The engine only weighs this up when the redirect changes origin — protocol,
  // hostname or port — so the chain has to leave the first server entirely.
  const from = await startServer();
  const to = await startServer();
  try {
    const request = {
      method: 'GET',
      url: `${from.url}/away?to=${encodeURIComponent(`${to.url}/landed`)}`,
      header: [{ key: 'Authorization', value: 'Bearer keep-me' }]
    };

    await run(oneRequest(request));
    assert.equal(
      to.seen.at(-1)!.headers['authorization'],
      undefined,
      'dropped when the redirect crosses origin, so credentials do not leak'
    );

    await run(oneRequest(request, { followAuthorizationHeader: true }));
    assert.equal(
      to.seen.at(-1)!.headers['authorization'],
      'Bearer keep-me',
      'kept when the request asks for it'
    );
  } finally {
    await from.close();
    await to.close();
  }
});

test('followOriginalHttpMethod redirects with the method that was sent', async () => {
  const server = await startServer();
  try {
    const request = {
      method: 'POST',
      url: `${server.url}/hop?n=1`,
      body: { mode: 'raw', raw: 'hello' }
    };

    await run(oneRequest(request));
    assert.equal(server.seen.at(-1)!.method, 'GET', 'a 302 is followed with GET, as browsers do');

    await run(oneRequest(request, { followOriginalHttpMethod: true }));
    assert.equal(server.seen.at(-1)!.method, 'POST', 'unless the request says otherwise');
  } finally {
    await server.close();
  }
});

test('disableUrlEncoding leaves the url as written', async () => {
  const server = await startServer();
  try {
    const url = `${server.url}/plain?q=a<b`;

    await run(oneRequest({ method: 'GET', url }), { useWhatWGUrlParser: true });
    assert.equal(server.seen.at(-1)!.url, '/plain?q=a%3Cb', 'encoded by default');

    await run(oneRequest({ method: 'GET', url }, { disableUrlEncoding: true }), {
      useWhatWGUrlParser: true
    });
    assert.equal(server.seen.at(-1)!.url, '/plain?q=a<b', 'sent verbatim when asked');
  } finally {
    await server.close();
  }
});
