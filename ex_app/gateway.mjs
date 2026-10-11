import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function configuration(env = process.env) {
  for (const key of ['APP_ID', 'APP_SECRET', 'APP_VERSION', 'APP_PORT', 'APP_PERSISTENT_STORAGE', 'NEXTCLOUD_URL']) {
    if (!env[key]) throw new Error(`Missing ${key}`);
  }
  if (env.APP_ID !== 'wekan') throw new Error('APP_ID must be wekan');
  const port = Number(env.APP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid APP_PORT');
  if (!path.isAbsolute(env.APP_PERSISTENT_STORAGE) || env.APP_PERSISTENT_STORAGE === '/') throw new Error('Persistent storage must be an absolute data directory');
  const nc = new URL(env.NEXTCLOUD_URL);
  if (!['http:', 'https:'].includes(nc.protocol) || nc.username || nc.password || nc.search || nc.hash) throw new Error('Invalid NEXTCLOUD_URL');
  const nextcloudUrl = nc.href.replace(/\/$/, '');
  const publicUrl = new URL(env.WEKAN_PUBLIC_URL || `${nextcloudUrl}/exapps/wekan/`);
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password ||
      publicUrl.search || publicUrl.hash || !publicUrl.pathname.endsWith('/exapps/wekan/')) {
    throw new Error('WEKAN_PUBLIC_URL must be the public HaRP URL ending in /exapps/wekan/');
  }
  const admins = JSON.parse(env.NEXTCLOUD_ADMIN_USERS || '[]');
  if (!Array.isArray(admins) || admins.some(user => typeof user !== 'string' || !user)) throw new Error('NEXTCLOUD_ADMIN_USERS must be a JSON array of user IDs');
  return { appId: env.APP_ID, secret: env.APP_SECRET, version: env.APP_VERSION,
    aaVersion: env.AA_VERSION || '3.2.0', host: env.APP_HOST || '0.0.0.0', port,
    storage: env.APP_PERSISTENT_STORAGE, writable: path.join(env.APP_PERSISTENT_STORAGE, 'wekan'),
    nextcloudUrl, publicUrl, admins };
}

export function authenticate(headers, config) {
  if (headers['ex-app-id'] !== config.appId || !headers['ex-app-version']) throw new Error('Unauthorized');
  const encoded = headers['authorization-app-api'];
  if (typeof encoded !== 'string' || encoded.length > 8192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Unauthorized');
  const raw = Buffer.from(encoded, 'base64').toString('utf8');
  const separator = raw.indexOf(':');
  if (separator < 0) throw new Error('Unauthorized');
  const secret = Buffer.from(raw.slice(separator + 1));
  const expected = Buffer.from(config.secret);
  if (secret.length !== expected.length || !timingSafeEqual(secret, expected)) throw new Error('Unauthorized');
  const user = raw.slice(0, separator);
  if (user.length > 255 || /[\x00-\x1f\x7f]/.test(user)) throw new Error('Unauthorized');
  return user;
}

export function proxyHeaders(headers, userId, config, key) {
  const result = { ...headers };
  // Do not pass Nextcloud credentials, untrusted identity, or hop-by-hop headers
  // into Meteor. The WebSocket handshake adds only the required upgrade fields.
  const hopHeaders = String(headers.connection || '').toLowerCase().split(',').map(s => s.trim());
  for (const name of Object.keys(result)) {
    if (name.startsWith('x-wekan-nextcloud-') || name.startsWith('x-forwarded-') ||
        ['authorization', 'authorization-app-api', 'ex-app-id', 'ex-app-version', 'aa-version',
          'connection', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
          'keep-alive', 'transfer-encoding', 'te', 'trailer', ...hopHeaders].includes(name)) delete result[name];
  }
  // WeKan does not need Nextcloud's session cookies.
  if (result.cookie) result.cookie = result.cookie.split(';').filter(part => /^\s*(meteor_|wekan_)/.test(part)).join(';');
  const payload = Buffer.from(JSON.stringify({ issuer: config.nextcloudUrl, userId })).toString('base64url');
  result['x-wekan-nextcloud-user'] = payload;
  result['x-wekan-nextcloud-signature'] = createHmac('sha256', key).update(payload).digest('hex');
  result.host = config.publicUrl.host;
  result['x-forwarded-proto'] = config.publicUrl.protocol.slice(0, -1);
  return result;
}

export function localPath(url, config) {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) throw new Error('Invalid request path');
  const prefix = config.publicUrl.pathname.replace(/\/$/, '');
  if (url === prefix || url.startsWith(prefix + '/') || url.startsWith(prefix + '?')) return url.slice(prefix.length) || '/';
  return url;
}

export async function ocs(config, method, endpoint, data, fetcher = fetch) {
  const url = new URL(`${config.nextcloudUrl}/ocs/v1.php/apps/app_api/${endpoint}`);
  url.searchParams.set('format', 'json');
  if (method === 'DELETE') for (const [key, value] of Object.entries(data)) url.searchParams.set(key, value);
  const response = await fetcher(url, { method, redirect: 'error', signal: AbortSignal.timeout(15000), headers: {
    'Content-Type': 'application/json', 'OCS-APIRequest': 'true', 'AA-VERSION': config.aaVersion,
    'EX-APP-ID': config.appId, 'EX-APP-VERSION': config.version,
    'AUTHORIZATION-APP-API': Buffer.from(`:${config.secret}`).toString('base64'),
  }, ...(method === 'DELETE' ? {} : { body: JSON.stringify(data) }) });
  const body = await response.json();
  const code = Number(body?.ocs?.meta?.statuscode);
  if (method === 'DELETE' && (response.status === 404 || code === 404)) return;
  if (!response.ok || ![100, 200].includes(code)) throw new Error(`Nextcloud ${endpoint} failed (${response.status}/${code})`);
}

export function createGateway({ config, key, backendPort, isReady, callOcs = (method, endpoint, data) => ocs(config, method, endpoint, data) }) {
  const enabledFile = path.join(config.storage, 'nextcloud-enabled.json');
  let enabled = false;
  try { enabled = JSON.parse(fs.readFileSync(enabledFile)).enabled === true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let initializing = false;
  const sockets = new Set();
  const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  async function initialize() {
    if (initializing) return;
    initializing = true;
    try {
      await callOcs('PUT', 'ex-app/status', { progress: 0 });
      const deadline = Date.now() + 10 * 60 * 1000;
      while (!await isReady()) {
        if (Date.now() > deadline) throw new Error('WeKan startup timed out');
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      await callOcs('PUT', 'ex-app/status', { progress: 100 });
    } catch (_) {
      console.error('Nextcloud initialization failed; check WeKan startup and Nextcloud connectivity');
      try { await callOcs('PUT', 'ex-app/status', { error: 'WeKan initialization failed; inspect container logs' }); } catch (_) { /* no secrets in logs */ }
    } finally { initializing = false; }
  }
  const server = http.createServer(async (req, res) => {
    let route;
    try { route = localPath(req.url, config); } catch (_) { return json(res, 400, { error: 'Invalid path' }); }
    const url = new URL(route, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/heartbeat') return json(res, 200, { status: 'ok' });
    let user;
    try { user = authenticate(req.headers, config); } catch (_) { return json(res, 401, { error: 'Unauthorized' }); }
    if (url.pathname === '/init' || url.pathname === '/enabled') {
      if (user) return json(res, 403, { error: 'Lifecycle requires system authentication' });
      if (req.method === 'POST' && url.pathname === '/init') {
        json(res, 200, {}); void initialize(); return;
      }
      if (req.method !== 'PUT' || url.pathname !== '/enabled') return json(res, 405, { error: 'Method not allowed' });
      const value = url.searchParams.get('enabled');
      if (!['0', '1', 'false', 'true'].includes(value)) return json(res, 400, { error: 'Invalid enabled value' });
      const enable = value === '1' || value === 'true';
      // Disable immediately, even if deregistration subsequently fails.
      if (!enable) { enabled = false; for (const socket of sockets) socket.destroy(); }
      try {
        // Persist denial before contacting Nextcloud: an unavailable OCS endpoint
        // must not resurrect the previous enabled state on process restart.
        if (!enable) fs.writeFileSync(enabledFile, JSON.stringify({ enabled: false }), { mode: 0o600 });
        const method = enable ? 'POST' : 'DELETE';
        await callOcs(method, 'api/v1/ui/top-menu', enable ? { name: 'wekan', displayName: 'WeKan', icon: 'img/app.svg', adminRequired: 0 } : { name: 'wekan' });
        await callOcs(method, 'api/v1/ui/script', { type: 'top_menu', name: 'wekan', path: 'js/menu.js' });
        fs.writeFileSync(enabledFile, JSON.stringify({ enabled: enable }), { mode: 0o600 });
        enabled = enable;
        return json(res, 200, { error: '' });
      } catch (_) { return json(res, 500, { error: 'Could not update Nextcloud menu registration' }); }
    }
    // AppAPI fetches registered assets using system authentication.
    if (req.method === 'GET' && url.pathname === '/js/menu.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
      return res.end(`window.location.replace(window.location.origin + ${JSON.stringify(config.publicUrl.pathname)});`);
    }
    if (req.method === 'GET' && url.pathname === '/img/app.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="5" fill="#2980b9"/><path fill="white" d="M6 7h8v18H6zm12 0h8v12h-8z"/></svg>');
    }
    if (!enabled || !user) return json(res, 403, { error: 'WeKan is disabled or user authentication is missing' });
    if (url.pathname.startsWith('/_nextcloud/')) return json(res, 404, { error: 'Not found' });
    const upstream = http.request({ hostname: '127.0.0.1', port: backendPort, method: req.method,
      path: config.publicUrl.pathname.replace(/\/$/, '') + route,
      headers: proxyHeaders(req.headers, user, config, key) }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) json(res, 503, { error: 'WeKan is starting' }); else res.destroy(); });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on('upgrade', (req, socket, head) => {
    let user, route;
    try {
      user = authenticate(req.headers, config); route = localPath(req.url, config);
      if (!enabled || !user || !/^\/sockjs\//.test(route) || req.headers.upgrade?.toLowerCase() !== 'websocket') throw new Error('Unauthorized');
      if (req.headers.origin && req.headers.origin !== config.publicUrl.origin) throw new Error('Origin mismatch');
    } catch (_) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const headers = proxyHeaders(req.headers, user, config, key);
    headers.connection = 'Upgrade'; headers.upgrade = 'websocket';
    const upstream = http.request({ hostname: '127.0.0.1', port: backendPort,
      path: config.publicUrl.pathname.replace(/\/$/, '') + route, headers });
    upstream.on('upgrade', (response, remote, upstreamHead) => {
      sockets.add(socket); sockets.add(remote);
      socket.on('close', () => { sockets.delete(socket); remote.destroy(); });
      remote.on('close', () => { sockets.delete(remote); socket.destroy(); });
      socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy());
      const lines = [`HTTP/1.1 ${response.statusCode} ${response.statusMessage}`];
      for (let i = 0; i < response.rawHeaders.length; i += 2) lines.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) remote.write(head);
      socket.pipe(remote); remote.pipe(socket);
    });
    upstream.on('response', response => { response.resume(); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); });
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    upstream.end();
  });
  return server;
}
