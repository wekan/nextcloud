import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configuration, createGateway } from '../ex_app/gateway.mjs';

async function fixture(t, options = {}) {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'wekan-lifecycle-'));
  const config = configuration({ APP_ID: 'wekan', APP_SECRET: 'test-secret', APP_VERSION: '1.0.0',
    APP_PORT: '23000', APP_PERSISTENT_STORAGE: storage, NEXTCLOUD_URL: 'http://internal/nextcloud',
    WEKAN_PUBLIC_URL: 'https://public.example/cloud/exapps/wekan/' });
  const calls = [];
  const backend = http.createServer((req, res) => res.end(req.url));
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const servers = [backend];
  t.after(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => {
      server.closeAllConnections(); server.close(resolve);
    })));
    fs.rmSync(storage, { recursive: true, force: true });
  });
  const start = async () => {
    const server = createGateway({ config, key: 'private-key', backendPort: backend.address().port,
      isReady: async () => true, callOcs: async (...args) => calls.push(args), ...options });
    servers.push(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const request = (route, user = '', method = 'GET') => fetch(url + route, { method, headers: {
      'ex-app-id': 'wekan', 'ex-app-version': '1.0.0',
      'authorization-app-api': Buffer.from(`${user}:test-secret`).toString('base64'),
    } });
    return { url, server, request };
  };
  return { config, calls, start, ...(await start()) };
}

test('heartbeat is immediate while init waits for readiness; repeated init does not duplicate progress', async t => {
  let ready;
  const pending = new Promise(resolve => { ready = resolve; });
  const calls = [];
  const f = await fixture(t, { isReady: () => pending, callOcs: async (...args) => calls.push(args) });
  assert.equal((await fetch(f.url + '/heartbeat')).status, 200);
  assert.equal((await f.request('/init', '', 'POST')).status, 200);
  assert.equal((await f.request('/init', '', 'POST')).status, 200);
  assert.deepEqual(calls.map(c => c[2].progress), [0]);
  ready(true);
  for (let i = 0; i < 100 && calls.length < 2; i++) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(calls.map(c => c[2].progress), [0, 100]);
});

test('failed enable stays disabled, successful enable and disable survive gateway replacement', async t => {
  let fail = true;
  const f = await fixture(t, { callOcs: async () => { if (fail) throw Error('offline'); } });
  assert.equal((await f.request('/enabled?enabled=1', '', 'PUT')).status, 500);
  assert.equal((await f.request('/', 'alice')).status, 403);
  fail = false;
  assert.equal((await f.request('/enabled?enabled=1', '', 'PUT')).status, 200);
  const replacement = await f.start();
  assert.equal((await replacement.request('/', 'alice')).status, 200);
  assert.equal((await replacement.request('/enabled?enabled=0', '', 'PUT')).status, 200);
  const disabled = await f.start();
  assert.equal((await disabled.request('/', 'alice')).status, 403);
});

test('failed deregistration cannot re-enable WeKan after a restart', async t => {
  let fail = false;
  const f = await fixture(t, { callOcs: async () => { if (fail) throw Error('offline'); } });
  assert.equal((await f.request('/enabled?enabled=1', '', 'PUT')).status, 200);
  fail = true;
  assert.equal((await f.request('/enabled?enabled=0', '', 'PUT')).status, 500);
  assert.equal((await f.request('/', 'alice')).status, 403);
  const restarted = await f.start();
  assert.equal((await restarted.request('/', 'alice')).status, 403);
});

test('system-only lifecycle, path prefix and asset handling reject invalid requests', async t => {
  const f = await fixture(t);
  for (const route of ['/init', '/enabled?enabled=1']) {
    assert.equal((await f.request(route, 'alice', route === '/init' ? 'POST' : 'PUT')).status, 403);
  }
  assert.equal((await f.request('/enabled?enabled=yes', '', 'PUT')).status, 400);
  assert.equal((await f.request('/enabled?enabled=1', '', 'GET')).status, 405);
  assert.equal((await f.request('/enabled?enabled=true', '', 'PUT')).status, 200);
  assert.equal(await (await f.request('/cloud/exapps/wekan/board?x=1', 'alice')).text(), '/cloud/exapps/wekan/board?x=1');
  const asset = await (await f.request('/js/menu.js')).text();
  assert.match(asset, /\/cloud\/exapps\/wekan\//);
  assert.ok(!asset.includes(f.config.secret));
  assert.equal((await f.request('/_nextcloud/health', 'alice')).status, 404);
  assert.equal((await f.request('/')).status, 403);
});

test('WebSocket upgrades reject absent auth, wrong origin, system identity and non-DDP paths', async t => {
  const f = await fixture(t);
  await f.request('/enabled?enabled=1', '', 'PUT');
  for (const [route, user, origin, secret] of [
    ['/sockjs/a/websocket', 'alice', 'https://evil.example', 'test-secret'],
    ['/sockjs/a/websocket', '', 'https://public.example', 'test-secret'],
    ['/board', 'alice', 'https://public.example', 'test-secret'],
    ['/sockjs/a/websocket', 'alice', 'https://public.example', 'wrong'],
  ]) {
    const response = await new Promise((resolve, reject) => {
      const socket = net.connect(f.server.address().port, '127.0.0.1');
      socket.setTimeout(2000, () => { socket.destroy(); reject(Error('upgrade timed out')); });
      socket.on('error', reject);
      socket.once('data', data => { socket.destroy(); resolve(data.toString()); });
      socket.write(`GET ${route} HTTP/1.1\r\nHost: public.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nOrigin: ${origin}\r\nex-app-id: wekan\r\nex-app-version: 1.0.0\r\nauthorization-app-api: ${Buffer.from(`${user}:${secret}`).toString('base64')}\r\n\r\n`);
    });
    assert.match(response, /^HTTP\/1.1 403/);
  }
});
