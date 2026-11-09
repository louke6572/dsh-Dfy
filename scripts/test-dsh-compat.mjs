import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { NodeApiClient } from '../src/dsh-client.js';

test('install graph contains no DSH core packages, including optional peers', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
  const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url)));
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  assert.deepEqual(lock.packages[''].engines, pkg.engines);
  assert.deepEqual(Object.keys(lock.packages).filter(p => /node_modules\/@deepseek-ai\/dsh-/.test(p)), []);
});

// Wire-contract regression, not a substitute for running each real host release.
test('bridge preserves RPC, auth, facades, errors, cancellation and observation', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    requests.push({ url: req.url, cookie: req.headers.cookie, body });
    if (body.method === 'test/hang') return;
    if (body.method === 'test/http') { res.writeHead(503).end(); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ type: 'server-response',
      rpcId: body.method === 'test/mismatch' ? 'wrong' : body.rpcId,
      result: body.method === 'test/error' ? { ok: false, error: { code: 'unsupported' } }
        : { ok: true, value: { futureField: 42 } } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const api = new NodeApiClient(`http://127.0.0.1:${server.address().port}`, 1000);
  api.hasAuth = () => true;
  api.ensureAuth = async () => 'test-cookie=value';
  const observed = [];
  const unsubscribe = api.subscribeEnvelopes(batch => observed.push(...batch));
  const list = api.sessions.list;
  assert.equal((await list({ limit: 5 })).result.value.futureField, 42);
  assert.deepEqual(requests.at(-1).body.payload, { args: { _request: { limit: 5 } } });
  assert.equal(requests.at(-1).url, '/api/session/list');
  assert.equal(requests.at(-1).cookie, 'test-cookie=value');
  const payload = { sessionId: 's', text: 'hello' };
  await api.sessions.prompt(payload);
  assert.equal(typeof requests.at(-1).body.payload.args.request.requestId, 'string');
  assert.equal(payload.requestId, undefined);
  await api.workspace.archiveSession({ sessionId: 's' });
  assert.deepEqual(requests.at(-1).body.payload, { args: { request: { sessionId: 's' } } });
  await api.agentPresets.list({});
  assert.equal(requests.at(-1).url, '/api/agentPresets/list');
  assert.deepEqual(requests.at(-1).body.payload, { args: {} });
  await api.settings.describe({});
  await api.respond({ clientId: 'c', eventId: 'e', outcome: { ok: true } });
  assert.equal(requests.at(-1).url, '/api/$events/result');
  assert.equal((await api.callUnary('test.error', {})).result.error.code, 'unsupported');
  await assert.rejects(api.callUnary('test.mismatch', {}), /invalid server-response/);
  await assert.rejects(api.callUnary('test.http', {}), /HTTP 503/);
  api.timeoutMs = 20;
  await assert.rejects(api.callUnary('test.hang', {}), { name: 'TimeoutError' });
  await assert.rejects(api.sessions.list({}, AbortSignal.abort()), { name: 'AbortError' });
  assert.ok(observed.some(e => e.type === 'client-request'));
  assert.ok(observed.some(e => e.type === 'server-response'));
  unsubscribe();
  const count = observed.length;
  api.onEnvelope({ type: 'ignored' });
  await Promise.resolve();
  assert.equal(observed.length, count);
});

test('native picker uses caller cancellation only; all legacy facades stay bound', async () => {
  const api = new NodeApiClient();
  assert.equal(api.timeoutMs, 30_000);
  const calls = [];
  api.callUnary = (...args) => calls.push(args);
  const pick = api.host.pickDirectory;
  const signal = new AbortController().signal;
  pick({}, signal);
  assert.deepEqual(calls.pop(), ['host.pickDirectory', {}, signal, 'caller-signal-only']);
  for (const domain of ['sessions', 'subagents', 'host', 'workspace', 'skills', 'goals', 'settings', 'credentials', 'llm']) {
    for (const fn of Object.values(api[domain])) {
      fn({}, signal);
      assert.equal(calls.pop()[2], signal);
    }
  }
});
