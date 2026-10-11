import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const root = new URL('../', import.meta.url);

test('app metadata requires signed-in users for every route on Nextcloud 32–35', () => {
  const file = new URL('appinfo/info.xml', root);
  const metadata = JSON.parse(execFileSync('python3', ['-c', `import json,sys,xml.etree.ElementTree as E
r=E.parse(sys.argv[1]).getroot()
print(json.dumps({'id':r.findtext('id'),'range':r.find('dependencies/nextcloud').attrib,
 'routes':[{e.tag:e.text for e in route} for route in r.findall('external-app/routes/route')]}))`, file.pathname], { encoding: 'utf8' }));
  assert.equal(metadata.id, 'wekan');
  assert.deepEqual(metadata.range, { 'min-version': '32', 'max-version': '35' });
  assert.ok(metadata.routes.length);
  for (const route of metadata.routes) {
    assert.equal(route.access_level, 'USER');
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) assert.ok(route.verb.split(',').includes(method));
    assert.ok(new RegExp(route.url).test('/sockjs/000/test/websocket'));
    assert.ok(new RegExp(route.url).test('/cdn/storage/attachments/file'));
  }
});

test('the image requires the upstream capability and database and drops privileges before starting children', () => {
  const docker = fs.readFileSync(new URL('Dockerfile', root), 'utf8');
  const start = fs.readFileSync(new URL('ex_app/start.mjs', root), 'utf8');
  assert.match(docker, /nextcloud-exapp-capability\.json/);
  assert.match(docker, /test -x \/build\/ferretdb/);
  assert.match(docker, /COPY ex_app/);
  assert.ok(!docker.includes('/var/run/docker.sock'));
  assert.ok(start.indexOf('process.setgroups([])') < start.indexOf("run(launcher"));
  assert.ok(start.indexOf('process.setuid(uid)') < start.indexOf("run('bash'"));
  assert.match(start, /fs\.chmodSync\(sock, 0o600\)/);
  assert.match(start, /fs\.writeFileSync\(frpConfig, content, \{ mode: 0o600 \}\)/);
  assert.match(start, /randomBytes\(32\)/);
});
