import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { backendEnvironment, frpConfiguration } from '../ex_app/runtime.mjs';

test('only private loopback backends share storage; AppAPI and FRP secrets never reach them', () => {
  const env = backendEnvironment({ nextcloudUrl: 'http://internal/cloud', admins: ['Admin'],
    publicUrl: new URL('https://public/cloud/exapps/wekan/'), writable: '/volume/wekan' }, 'fresh-key', 3001, 3002,
  { APP_SECRET: 'secret', HP_SHARED_KEY: 'harp', MONGO_URL: 'mongodb://external/prod',
    MONGO_URL_FILE: '/secret', MONGO_OPLOG_URL: 'mongodb://external/local', DDP_TRANSPORT: 'uws' });
  for (const name of ['APP_SECRET', 'HP_SHARED_KEY', 'MONGO_URL_FILE', 'MONGO_OPLOG_URL']) assert.equal(env[name], undefined);
  assert.equal(env.MONGO_URL, 'mongodb://127.0.0.1:3002/wekan');
  assert.equal(env.BIND_IP, '127.0.0.1');
  assert.equal(env.FERRETDB_SQLITE_DIR, '/volume/wekan/files/db');
  assert.equal(env.ROOT_URL, 'https://public/cloud/exapps/wekan/');
  assert.equal(env.NEXTCLOUD_ADMIN_USERS, '["Admin"]');
  assert.equal(env.WEKAN_NEXTCLOUD_PROXY_KEY, 'fresh-key');
  assert.equal(env.DDP_TRANSPORT, 'sockjs');
});

for (const scenario of ['child-exit', 'spawn-failure', 'sigterm', 'stubborn-child']) {
  test(`supervision: ${scenario} shuts down every real child`, { timeout: 10000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wekan-supervision-'));
    const module = new URL('../ex_app/runtime.mjs', import.meta.url).href;
    const pidFile = path.join(dir, 'pid');
    const source = `import { supervise } from ${JSON.stringify(module)};
      import fs from 'node:fs';
      const { run, stop } = supervise({ close() {} }, { timeoutMs: 200 });
      process.on('SIGTERM', () => stop());
      const child = run(process.execPath, ['-e', ${JSON.stringify(scenario === 'stubborn-child'
        ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)" : 'setInterval(() => {}, 1000)')}], process.env);
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      setTimeout(() => ${scenario === 'child-exit' ? "run(process.execPath, ['-e', 'process.exit(2)'], process.env)"
        : scenario === 'spawn-failure' ? "run('/missing/wekan-test-executable', [], process.env)" : scenario === 'sigterm' ? "process.kill(process.pid, 'SIGTERM')" : "stop()"}, 300);`;
    const script = path.join(dir, 'run.mjs'); fs.writeFileSync(script, source);
    const proc = spawn(process.execPath, [script], { stdio: 'pipe' });
    let output = ''; proc.stderr.on('data', data => { output += data; });
    try {
      const code = await new Promise((resolve, reject) => { proc.on('error', reject); proc.on('exit', resolve); });
      assert.equal(code, ['child-exit', 'spawn-failure'].includes(scenario) ? 1 : 0, output);
      const pid = Number(fs.readFileSync(pidFile));
      // Killed children may briefly remain zombies while init reaps them.
      let alive = true;
      for (let i = 0; i < 100; i++) {
        try {
          process.kill(pid, 0);
          if (fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] === 'Z') { alive = false; break; }
        } catch { alive = false; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(alive, false, 'A supervised child survived shutdown');
    } finally { proc.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
  });
}


test('FRP config round-trips quoted secrets, private Unix socket and mutual TLS paths', () => {
  const config = { port: 23000, appId: 'wekan' };
  const env = { HP_FRP_ADDRESS: 'harp', HP_FRP_PORT: '8782', HP_SHARED_KEY: 'quoted"token\\value' };
  for (const directory of [null, '/private/certificates']) {
    const value = frpConfiguration(config, env, '/private/exapp.sock', directory);
    // Parse with an independent TOML parser, not a regex that repeats the generator.
    const parsed = JSON.parse(execFileSync('python3', ['-c', 'import sys,tomllib,json; print(json.dumps(tomllib.loads(sys.stdin.read())))'], { input: value, encoding: 'utf8' }));
    assert.equal(parsed.metadatas.token, env.HP_SHARED_KEY);
    assert.equal(parsed.proxies[0].plugin.unixPath, '/private/exapp.sock');
    assert.equal(parsed.proxies[0].remotePort, config.port);
    assert.equal(parsed.transport.tls.enable, !!directory);
    if (directory) {
      assert.equal(parsed.transport.tls.keyFile, directory + '/client.key');
      assert.equal(parsed.transport.tls.trustedCaFile, directory + '/ca.crt');
      assert.equal(parsed.transport.tls.serverName, 'harp.nc');
    }
  }
  for (const port of ['0', '-1', '65536', 'invalid']) {
    assert.throws(() => frpConfiguration(config, { ...env, HP_FRP_PORT: port }, '/socket'));
  }
});
