import path from 'node:path';
import { spawn } from 'node:child_process';

export function backendEnvironment(config, key, backendPort, databasePort, inherited = process.env) {
  const env = { ...inherited };
  for (const name of ['APP_SECRET', 'HP_SHARED_KEY', 'MONGO_URL_FILE', 'MONGO_OPLOG_URL']) delete env[name];
  return Object.assign(env, {
    NEXTCLOUD_EXAPP: 'true', WEKAN_NEXTCLOUD_PROXY_KEY: key, NEXTCLOUD_URL: config.nextcloudUrl,
    NEXTCLOUD_ADMIN_USERS: JSON.stringify(config.admins), ROOT_URL: config.publicUrl.href,
    PORT: String(backendPort), BIND_IP: '127.0.0.1', WRITABLE_PATH: config.writable,
    WEKAN_DB: 'mongodb', MONGO_URL: `mongodb://127.0.0.1:${databasePort}/wekan`,
    FERRETDB_SQLITE_DIR: path.join(config.writable, 'files', 'db'), DDP_TRANSPORT: 'sockjs',
    METEOR_REACTIVITY_ORDER: 'polling', DEFAULT_METEOR_REACTIVITY_ORDER: 'polling',
    HTTP_FORWARDED_COUNT: '0',
  });
}

// Own process groups so a shell launcher cannot leave database/server children behind.
export function supervise(server, { timeoutMs = 15000 } = {}) {
  const children = new Set();
  let stopping = false;
  function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    server.close();
    for (const child of children) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
    }
    const deadline = setTimeout(() => {
      for (const child of children) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
      }
      process.exit(code);
    }, timeoutMs);
    Promise.all([...children].map(child => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode || !child.pid) resolve();
      else child.once('exit', resolve);
    }))).then(() => { clearTimeout(deadline); process.exit(code); });
  }
  function run(command, args, env) {
    const child = spawn(command, args, { env, stdio: 'inherit', detached: true });
    children.add(child);
    child.once('error', () => { console.error('Could not start a required ExApp process'); stop(1); });
    child.once('exit', () => { if (!stopping) { console.error('A required ExApp process exited'); stop(1); } });
    return child;
  }
  return { run, stop };
}

export function frpConfiguration(config, env, socket, certificateDirectory = null) {
  const quote = value => JSON.stringify(String(value));
  const port = Number(env.HP_FRP_PORT);
  if (!env.HP_FRP_ADDRESS || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid HaRP FRP address/port');
  return `serverAddr = ${quote(env.HP_FRP_ADDRESS)}\nserverPort = ${port}\nloginFailExit = false\n` +
    `transport.tls.enable = ${!!certificateDirectory}\n` + (certificateDirectory ?
      `transport.tls.certFile = ${quote(path.join(certificateDirectory, 'client.crt'))}\ntransport.tls.keyFile = ${quote(path.join(certificateDirectory, 'client.key'))}\ntransport.tls.trustedCaFile = ${quote(path.join(certificateDirectory, 'ca.crt'))}\ntransport.tls.serverName = "harp.nc"\n` : '') +
    `metadatas.token = ${quote(env.HP_SHARED_KEY)}\n[[proxies]]\nremotePort = ${config.port}\ntype = "tcp"\nname = ${quote(config.appId)}\n[proxies.plugin]\ntype = "unix_domain_socket"\nunixPath = ${quote(socket)}\n`;
}
