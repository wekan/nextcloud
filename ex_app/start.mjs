import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { configuration, createGateway } from './gateway.mjs';
import { backendEnvironment, supervise, frpConfiguration } from './runtime.mjs';

const config = configuration();
const key = randomBytes(32).toString('hex');
const uid = Number(execFileSync('id', ['-u', 'wekan'], { encoding: 'utf8' }).trim());
const gid = Number(execFileSync('id', ['-g', 'wekan'], { encoding: 'utf8' }).trim());
for (const dir of [config.storage, config.writable, path.join(config.writable, 'files'),
  ...['db', 'attachments', 'avatars'].map(name => path.join(config.writable, 'files', name))]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.getuid() === 0) fs.chownSync(dir, uid, gid);
}
// The gateway, database and application all run as wekan after initializing the
// AppAPI volume. No Docker socket, privileged container, or external DB needed.
const frpCertDir = path.join(config.storage, '.frp-certs');
if (fs.existsSync('/certs/frp')) {
  // Copy injected certificates before dropping privileges; the source mount may
  // be read-only. The destination is private and refreshed on every startup.
  fs.mkdirSync(frpCertDir, { recursive: true, mode: 0o700 });
  if (process.getuid() === 0) fs.chownSync(frpCertDir, uid, gid);
  for (const name of ['client.crt', 'client.key', 'ca.crt']) {
    const target = path.join(frpCertDir, name);
    fs.writeFileSync(target, fs.readFileSync(`/certs/frp/${name}`), { mode: 0o600 });
    if (process.getuid() === 0) fs.chownSync(target, uid, gid);
  }
}
if (process.getuid() === 0) { process.setgroups([]); process.setgid(gid); process.setuid(uid); }


async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}
const backendPort = await freePort();
const databasePort = await freePort();
if (databasePort === backendPort) throw new Error('Port allocation collision; restart container');
const databaseDir = path.join(config.writable, 'files', 'db');

const healthPath = config.publicUrl.pathname.replace(/\/$/, '') + '/_nextcloud/health';
const server = createGateway({ config, key, backendPort, isReady: () => new Promise(resolve => {
  const request = http.get({ hostname: '127.0.0.1', port: backendPort, path: healthPath, timeout: 3000 }, response => {
    let data = ''; response.on('data', chunk => { data += chunk; if (data.length > 4096) request.destroy(); });
    response.on('end', () => { try { resolve(response.statusCode === 200 && JSON.parse(data).nextcloud === 1); } catch (_) { resolve(false); } });
  });
  request.on('timeout', () => request.destroy()); request.on('error', () => resolve(false));
}) });
const { run, stop } = supervise(server);
server.on('error', () => stop(1));
process.on('SIGTERM', () => stop()); process.on('SIGINT', () => stop());

if (process.env.HP_SHARED_KEY) {
  // HaRP's FRP mode forwards to this Unix socket. Its direct-connect mode uses
  // APP_HOST/APP_PORT instead, without HP_SHARED_KEY.
  const sock = '/tmp/exapp.sock';
  try { fs.unlinkSync(sock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await new Promise(resolve => server.listen(sock, resolve));
  fs.chmodSync(sock, 0o600);
  const content = frpConfiguration(config, process.env, sock, fs.existsSync('/certs/frp') ? frpCertDir : null);
  const frpConfig = path.join(config.storage, '.frpc.toml');
  fs.writeFileSync(frpConfig, content, { mode: 0o600 });
  run('/usr/local/bin/frpc', ['-c', frpConfig], process.env);
} else {
  await new Promise(resolve => server.listen(config.port, config.host, resolve));
}
// Do not inherit AppAPI/FRP secrets in WeKan or FerretDB. The dedicated gateway
// signing key is sufficient for Meteor to verify connection-bound identities.
const appEnv = backendEnvironment(config, key, backendPort, databasePort);
// Separate supervised child processes, in one AppAPI-managed container. Either
// child exiting shuts down the whole container so Docker can restart it.
const launcher = fs.existsSync('/build/cpu-exec') ? '/build/cpu-exec' : '/build/ferretdb';
const dbArgs = ['--handler=sqlite', `--sqlite-url=file:${databaseDir}/`,
  `--listen-addr=127.0.0.1:${databasePort}`, '--telemetry=disable'];
run(launcher, launcher.endsWith('cpu-exec') ? ['/build/ferretdb', ...dbArgs] : dbArgs, appEnv);
run('bash', ['/build/wekan-entrypoint.sh'], appEnv);
