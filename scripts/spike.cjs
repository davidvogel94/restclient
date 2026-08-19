/**
 * Phase 0 de-risk spike.
 *
 * Run under the *same* runtime the extension host uses:
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/Visual Studio Code.app/Contents/MacOS/Code" scripts/spike.cjs
 *
 * 1. postman-sandbox boots a uvm worker thread and executes real pm.* code.
 * 2. postman-runtime executes a whole collection over HTTPS, with a pre-request
 *    script, a test script, variable scoping and an auth helper.
 */
const assert = require('assert');

console.log('node      :', process.version);
console.log('electron  :', process.versions.electron || '(none)');
console.log('execPath  :', process.execPath);

function spikeSandbox () {
  return new Promise((resolve, reject) => {
    const Sandbox = require('postman-sandbox');
    const t0 = Date.now();

    Sandbox.createContext({ timeout: 10000 }, (err, ctx) => {
      if (err) { return reject(new Error('createContext: ' + err.message)); }
      console.log('  createContext ok (%dms)', Date.now() - t0);

      const logs = [];
      const assertions = [];
      ctx.on('console', (_cursor, level, ...args) => logs.push(level + ': ' + args.join(' ')));
      // pm.test results are dispatched as events, NOT returned on the execute callback.
      ctx.on('execution.assertion', (_cursor, results) => assertions.push(...results));

      ctx.ping((pingErr, elapsed) => {
        if (pingErr) { return reject(new Error('ping: ' + pingErr.message)); }
        console.log('  ping ok (%dms)', elapsed);

        const code = `
          const _ = require('lodash');
          const moment = require('moment');
          const CryptoJS = require('crypto-js');
          console.log('lodash', typeof _.map, 'moment', typeof moment, 'webcrypto', typeof crypto.subtle);
          pm.environment.set('fromScript', _.toUpper('ok'));
          pm.test('chai works', function () { pm.expect(1 + 1).to.eql(2); });
          pm.test('stdlib works', function () {
            pm.expect(moment('2026-08-19').format('YYYY')).to.eql('2026');
            pm.expect(CryptoJS.MD5('a').toString()).to.have.lengthOf(32);
          });
          pm.test('deliberately failing', function () { pm.expect(true).to.eql(false); });
        `;

        ctx.execute(code, {
          timeout: 10000,
          context: { environment: { values: [] } }
        }, (execErr, res) => {
          if (execErr) { return reject(new Error('execute: ' + execErr.message)); }

          console.log('  assertions:', assertions.map(a => a.name + '=' + (a.skipped ? 'skip' : a.error ? 'FAIL' : 'pass')).join(', '));
          console.log('  env mutated to:', JSON.stringify((res.environment && res.environment.values) || []));
          logs.forEach(l => console.log('  script ' + l));

          assert.strictEqual(assertions.length, 3, 'expected 3 assertions');
          assert.ok(!assertions[0].error, 'assertion 1 should pass');
          assert.ok(!assertions[1].error, 'assertion 2 should pass');
          assert.ok(assertions[2].error, 'assertion 3 should fail');

          ctx.dispose();
          resolve();
        });
      });
    });
  });
}

function spikeRuntime () {
  return new Promise((resolve, reject) => {
    const runtime = require('postman-runtime');
    const { Collection, VariableScope } = require('postman-collection');

    const collection = new Collection({
      info: { name: 'spike', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      variable: [{ key: 'collectionVar', value: 'from-collection' }],
      item: [{
        name: 'get',
        event: [
          { listen: 'prerequest', script: { exec: ["pm.variables.set('nonce', 'n-' + pm.info.requestName);"] } },
          { listen: 'test', script: { exec: [
            "pm.test('status is 200', function () { pm.response.to.have.status(200); });",
            "const j = pm.response.json();",
            "pm.test('env var interpolated into url', function () { pm.expect(j.args.who).to.eql('world'); });",
            "pm.test('collection var interpolated', function () { pm.expect(j.args.cv).to.eql('from-collection'); });",
            "pm.test('prerequest local var interpolated', function () { pm.expect(j.args.nonce).to.eql('n-get'); });",
            "const authHeader = j.headers.Authorization || j.headers.authorization;",
            "pm.test('basic auth header applied', function () { pm.expect(authHeader).to.match(/^Basic /); });",
            "pm.test('basic auth credentials correct', function () { pm.expect(Buffer.from(String(authHeader).slice(6), 'base64').toString()).to.eql('u:p'); });",
            "pm.environment.set('roundTrip', j.args.who);"
          ] } }
        ],
        request: {
          method: 'GET',
          auth: { type: 'basic', basic: [{ key: 'username', value: 'u' }, { key: 'password', value: 'p' }] },
          url: '{{baseUrl}}/get?who={{who}}&cv={{collectionVar}}&nonce={{nonce}}'
        }
      }]
    });

    const environment = new VariableScope({
      name: 'spike-env',
      values: [
        { key: 'baseUrl', value: 'https://postman-echo.com', type: 'default', enabled: true },
        { key: 'who', value: 'world', type: 'default', enabled: true }
      ]
    });

    const assertions = [];
    new runtime.Runner().run(collection, { environment, timeout: { global: 60000, request: 30000, script: 10000 } }, (err, run) => {
      if (err) { return reject(err); }
      run.start({
        console: (_c, level, ...a) => console.log('  script ' + level + ':', ...a),
        assertion: (_c, results) => results.forEach(r => assertions.push(r)),
        exception: (_c, e) => console.log('  EXCEPTION', e && e.message),
        response: (e, _c, res) => {
          if (e) { return console.log('  request error:', e.message); }
          console.log('  HTTP %d %s (%d bytes)', res.code, res.reason(), res.responseSize);
        },
        done: (doneErr) => {
          if (doneErr) { return reject(doneErr); }
          assertions.forEach(a => console.log('  %s %s', a.error ? 'FAIL' : 'pass', a.name + (a.error ? ' -> ' + a.error.message : '')));
          const failed = assertions.filter(a => a.error);
          assert.ok(assertions.length >= 5, 'expected >=5 assertions, got ' + assertions.length);
          assert.strictEqual(failed.length, 0, failed.length + ' assertion(s) failed');
          resolve();
        }
      });
    });
  });
}

(async () => {
  console.log('\n--- spike 1: postman-sandbox worker + pm.* ---');
  await spikeSandbox();
  console.log('  SPIKE 1 PASS');

  console.log('\n--- spike 2: postman-runtime full lifecycle over HTTPS ---');
  await spikeRuntime();
  console.log('  SPIKE 2 PASS');

  console.log('\nALL SPIKES PASS');
  process.exit(0);
})().catch(e => { console.error('\nSPIKE FAILED:', e && e.stack || e); process.exit(1); });
