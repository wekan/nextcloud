import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configuration, authenticate, proxyHeaders, localPath, ocs, createGateway } from '../ex_app/gateway.mjs';
const env = { APP_ID: 'wekan', APP_SECRET: 'test:secret', APP_VERSION: '12.29.0', APP_PORT: '23000',
  APP_PERSISTENT_STORAGE: '/data', NEXTCLOUD_URL: 'https://cloud.example/nextcloud' };
const config = configuration(env);
const auth = user => ({ 'ex-app-id': 'wekan', 'ex-app-version': env.APP_VERSION,
  'authorization-app-api': Buffer.from(`${user}:${env.APP_SECRET}`).toString('base64') });
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

test('AppAPI secret and app identity are mandatory; system identity is distinct', () => {
  assert.equal(authenticate(auth('alice'), config), 'alice');
  assert.equal(authenticate(auth(''), config), '');
  for (const headers of [{}, { ...auth('alice'), 'ex-app-id': 'other' },
    { ...auth('alice'), 'authorization-app-api': Buffer.from('alice:wrong').toString('base64') },
    { ...auth('alice'), 'authorization-app-api': '%%%%' }]) assert.throws(() => authenticate(headers, config));
});
test('proxy signs the verified user and removes injected identity and Nextcloud cookies', () => {
  const headers = proxyHeaders({ ...auth('alice'), 'x-wekan-nextcloud-user': 'mallory', 'x-forwarded-proto': 'http',
    cookie: 'nc_session=secret; meteor_login_token=token', connection: 'x-extra', 'x-extra': 'remove' }, 'alice', config, 'key');
  assert.equal(JSON.parse(Buffer.from(headers['x-wekan-nextcloud-user'], 'base64url')).userId, 'alice');
  assert.equal(headers['authorization-app-api'], undefined);
  assert.equal(headers['x-extra'], undefined);
  assert.equal(headers.cookie.trim(), 'meteor_login_token=token');
  assert.equal(headers['x-forwarded-proto'], 'https');
  assert.equal(localPath('/nextcloud/exapps/wekan/sockjs/info', config), '/sockjs/info');
  assert.throws(() => localPath('//other/secret', config));
});
test('persistent paths and explicit administrators are validated', () => {
  assert.equal(config.writable, '/data/wekan');
  assert.deepEqual(config.admins, []);
  assert.equal(configuration({ ...env, WEKAN_PUBLIC_URL: 'https://public.example/exapps/wekan/' }).publicUrl.host, 'public.example');
  for (const change of [{ APP_ID: 'other' }, { APP_PORT: '-1' }, { APP_PERSISTENT_STORAGE: '/' },
    { NEXTCLOUD_URL: 'https://user:password@cloud.example' }, { NEXTCLOUD_ADMIN_USERS: '"admin"' }, { WEKAN_PUBLIC_URL: 'https://public.example/wrong/' }]) {
    assert.throws(() => configuration({ ...env, ...change }));
  }
});
test('OCS failures are not treated as successful menu/status updates', async () => {
  let options;
  await ocs(config, 'POST', 'api/v1/ui/top-menu', { name: 'wekan' }, async (_, opts) => {
    options = opts; return { ok: true, status: 200, json: async () => ({ ocs: { meta: { statuscode: 100 } } }) };
  });
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers['AUTHORIZATION-APP-API'], auth('')['authorization-app-api']);
  await assert.rejects(ocs(config, 'POST', 'api/v1/ui/top-menu', {}, async () => ({ ok: true, status: 200,
    json: async () => ({ ocs: { meta: { statuscode: 997 } } }) })), /failed/);
});
test('lifecycle, HTTP proxy, WebSocket transport, disable and persistent state', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nextcloud-gateway-'));
  const cfg = { ...config, storage: temp };
  let requestHeaders;
  const backend = http.createServer((req, res) => { requestHeaders = req.headers; res.end(req.url); });
  const backendSockets = new Set();
  backend.on('upgrade', (req, socket, head) => {
    backendSockets.add(socket);
    socket.on('close', () => backendSockets.delete(socket));
    requestHeaders = req.headers;
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    if (head.length) socket.write(head);
    socket.on('data', data => socket.write(data));
  });
  await listen(backend);
  const calls = [];
  const gateway = createGateway({ config: cfg, key: 'key', backendPort: backend.address().port,
    isReady: async () => true, callOcs: async (...args) => calls.push(args) });
  await listen(gateway);
  const url = `http://127.0.0.1:${gateway.address().port}`;
  let socket;
  try {
    assert.equal((await fetch(url + '/heartbeat')).status, 200);
    assert.equal((await fetch(url + '/')).status, 401);
    assert.equal((await fetch(url + '/', { headers: auth('alice') })).status, 403);
    assert.equal((await fetch(url + '/enabled?enabled=1', { method: 'PUT', headers: auth('alice') })).status, 403);
    assert.equal((await fetch(url + '/init', { method: 'POST', headers: auth('') })).status, 200);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(calls.some(call => call[1] === 'ex-app/status' && call[2].progress === 100));
    assert.equal((await fetch(url + '/enabled?enabled=1', { method: 'PUT', headers: auth('') })).status, 200);
    const response = await fetch(url + '/board?a=1', { headers: auth('alice') });
    assert.equal(await response.text(), '/nextcloud/exapps/wekan/board?a=1');
    assert.equal(requestHeaders['authorization-app-api'], undefined);
    assert.equal((await fetch(url + '/_nextcloud/health', { headers: auth('alice') })).status, 404);
    assert.equal(JSON.parse(fs.readFileSync(path.join(temp, 'nextcloud-enabled.json'))).enabled, true);
    socket = net.connect(gateway.address().port, '127.0.0.1');
    const received = new Promise((resolve, reject) => {
      let text = ''; socket.on('data', data => { text += data; if (text.includes('echo-data')) resolve(text); });
      socket.on('error', reject); socket.setTimeout(3000, () => reject(new Error('WebSocket tunnel timeout')));
    });
    socket.write('GET /sockjs/000/test/websocket HTTP/1.1\r\nHost: cloud.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
      Object.entries(auth('alice')).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\necho-data');
    assert.match(await received, /101 Switching Protocols/);
    assert.equal((await fetch(url + '/enabled?enabled=0', { method: 'PUT', headers: auth('') })).status, 200);
    assert.equal((await fetch(url + '/', { headers: auth('alice') })).status, 403);
    assert.equal(JSON.parse(fs.readFileSync(path.join(temp, 'nextcloud-enabled.json'))).enabled, false);
  } finally {
    socket?.destroy(); for (const client of backendSockets) client.destroy(); gateway.closeAllConnections(); backend.closeAllConnections();
    await Promise.all([new Promise(resolve => gateway.close(resolve)), new Promise(resolve => backend.close(resolve))]);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
