import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomBytes, createHash } from 'node:crypto';
import { createTestBindings } from '../server/tests/helpers.mjs';
import { MemoryStore } from '../server/memory-store.mjs';
import { readSnapshot, commitStore, prepareUploads, retryCleanup } from '../server/d1-store.mjs';
import { handleApi } from '../server/worker-api.mjs';

// Independent acceptance cases use real SQLite transactions through the D1
// test binding. They do not assert that Miniflare or hosted D1 has been tested.
const origin = 'https://independent-cockpit.example.test';
const testPassword = 'Independent-fixture-password-2026!';
const digest = value => createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const bindings = createTestBindings();
  bindings.env.BOOTSTRAP_TOKEN = randomBytes(32).toString('base64url');
  t.after(() => bindings.db.close());
  function client() {
    const identity = { cookie: '', csrf: '' };
    return {
      identity,
      async request(path, { method = 'GET', body, headers = {} } = {}) {
        const response = await handleApi(new Request(origin + path, {
          method,
          headers: { Origin: origin, Cookie: identity.cookie, 'X-CSRF-Token': identity.csrf, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
        }), bindings.env);
        if (response.headers.get('set-cookie')) identity.cookie = response.headers.get('set-cookie').split(';')[0];
        const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
        if (data?.csrfToken) identity.csrf = data.csrfToken;
        return { status: response.status, data, headers: response.headers };
      },
      async ok(path, method = 'GET', body, headers) {
        const result = await this.request(path, { method, body, headers });
        assert.equal(result.status, 200, `${method} ${path}: ${JSON.stringify(result.data)}`);
        return result.data;
      },
    };
  }
  const setup = (actor, email = 'owner@independent.example.test', header = bindings.env.BOOTSTRAP_TOKEN) => actor.request('/api/setup', {
    method: 'POST', body: { name: '独立验收所有者', email, password: testPassword },
    headers: header === undefined ? {} : { 'X-Bootstrap-Token': header },
  });
  return { ...bindings, client, setup };
}

test('independent: public empty workspace fails closed and competing setup creates exactly one owner/session/audit', async t => {
  const f = fixture(t);
  const a = f.client(), b = f.client();
  assert.equal((await a.ok('/api/bootstrap')).initialized, false);
  const configured = f.env.BOOTSTRAP_TOKEN;
  delete f.env.BOOTSTRAP_TOKEN;
  assert.equal((await f.setup(a, 'missing@independent.example.test', configured)).status, 403);
  f.env.BOOTSTRAP_TOKEN = configured;
  assert.equal((await a.request('/api/setup', { method: 'POST', body: { name: '无凭据', email: 'none@independent.example.test', password: testPassword } })).status, 403);
  assert.equal((await f.setup(a, 'wrong@independent.example.test', randomBytes(32).toString('base64url'))).status, 403);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  const results = await Promise.all([f.setup(a, 'a@independent.example.test'), f.setup(b, 'b@independent.example.test')]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM users WHERE workspace_role='owner'").get().n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='workspace.setup'").get().n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM entities').get().n, 0);
  assert.equal((await f.setup(f.client())).status, 409);
  const winner = results.find(r => r.status === 200);
  assert.match(winner.headers.get('set-cookie'), /HttpOnly/);
  assert.match(winner.headers.get('set-cookie'), /SameSite=Lax/);
  assert.match(winner.headers.get('set-cookie'), /Secure/);
  const publicData = await f.client().ok('/api/bootstrap');
  assert.equal(JSON.stringify(publicData).includes(configured), false);
  assert.equal((await f.client().request('/api/state')).status, 401);
});

test('independent: revision CAS rejects stale writes and rolls back all rows when a later statement fails', async t => {
  const f = fixture(t);
  const initialA = await readSnapshot(f.binding), initialB = await readSnapshot(f.binding);
  const a = new MemoryStore(initialA), b = new MemoryStore(initialB);
  a.prepare('INSERT INTO settings VALUES(?,?)').run('first', 'a');
  b.prepare('INSERT INTO settings VALUES(?,?)').run('second', 'b');
  await commitStore(initialA, a);
  await assert.rejects(commitStore(initialB, b), error => error.status === 409 && error.definiteRollback === true);
  assert.deepEqual(f.db.prepare('SELECT key,value FROM settings ORDER BY key').all().map(row => ({ ...row })), [{ key: 'first', value: 'a' }]);
  const stale = await readSnapshot(f.binding), fresh = await readSnapshot(f.binding);
  const staleStore = new MemoryStore(stale), freshStore = new MemoryStore(fresh);
  staleStore.prepare('INSERT INTO settings VALUES(?,?)').run('stale', 'lost');
  freshStore.prepare('INSERT INTO settings VALUES(?,?)').run('fresh', 'kept');
  await commitStore(fresh, freshStore);
  await assert.rejects(commitStore(stale, staleStore), { status: 409 });
  assert.equal(f.db.prepare("SELECT value FROM settings WHERE key='stale'").get(), undefined);
  const snapshot = await readSnapshot(f.binding), store = new MemoryStore(snapshot);
  store.prepare('INSERT INTO settings VALUES(?,?)').run('must-rollback', 'x');
  f.db.exec("CREATE TRIGGER reject_late BEFORE INSERT ON settings WHEN NEW.key='reject-late' BEGIN SELECT RAISE(ABORT,'injected late constraint'); END");
  store.prepare('INSERT INTO settings VALUES(?,?)').run('reject-late', 'y');
  await assert.rejects(commitStore(snapshot, store));
  assert.equal(f.db.prepare('SELECT revision FROM cloud_revision').get().revision, snapshot.revision);
  assert.equal(f.db.prepare("SELECT value FROM settings WHERE key='must-rollback'").get(), undefined);
  assert.ok(f.binding.sessions.every(bookmark => bookmark === 'first-primary'));
});

test('independent: concurrent API writes preserve both different objects and give one winner for the same version', async t => {
  const f = fixture(t), owner = f.client();
  assert.equal((await f.setup(owner)).status, 200);
  const project = await owner.ok('/api/projects', 'POST', { name: '并发验收', goal: '不丢失已确认工作' });
  const first = await owner.ok('/api/tasks', 'POST', { projectId: project.id, title: '任务一' });
  const second = await owner.ok('/api/tasks', 'POST', { projectId: project.id, title: '任务二' });
  const independent = await Promise.all([
    owner.request(`/api/tasks/${first.id}`, { method: 'PATCH', body: { version: first.version, status: 'doing' } }),
    owner.request(`/api/tasks/${second.id}`, { method: 'PATCH', body: { version: second.version, status: 'done' } }),
  ]);
  assert.deepEqual(independent.map(r => r.status), [200, 200]);
  const before = await owner.ok('/api/state'), target = before.tasks.find(task => task.id === first.id);
  const competing = await Promise.all([
    owner.request(`/api/tasks/${target.id}`, { method: 'PATCH', body: { version: target.version, status: 'blocked', blockReason: '等待依赖' } }),
    owner.request(`/api/tasks/${target.id}`, { method: 'PATCH', body: { version: target.version, status: 'done' } }),
  ]);
  assert.deepEqual(competing.map(r => r.status).sort(), [200, 409]);
  const after = await owner.ok('/api/state'), final = after.tasks.find(task => task.id === target.id);
  assert.equal(final.version, target.version + 1);
  assert.equal(after.tasks.find(task => task.id === second.id).status, 'done');
  const blockers = after.risks.filter(risk => risk.taskId === target.id && risk.status === 'open');
  assert.equal(blockers.length, final.status === 'blocked' ? 1 : 0);
  const history = await owner.ok(`/api/tasks/${target.id}/history`);
  assert.equal(history.filter(event => event.action === 'task.updated').length, 2);
});

test('independent: failed private upload retains a retry job, then cleanup removes only unreferenced objects', async t => {
  const f = fixture(t), snapshot = await readSnapshot(f.binding), store = new MemoryStore(snapshot, { bucket: f.bucket });
  store.stageFile('failed-private-version', Buffer.from('never committed'));
  f.bucket.failPut = true;
  f.bucket.failDelete = true;
  await assert.rejects(prepareUploads(f.env, store), /injected R2 failure/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM upload_cleanup').get().n, 1);
  f.bucket.failPut = false;
  f.bucket.failDelete = false;
  f.db.exec('UPDATE upload_cleanup SET next_attempt_at=0');
  await retryCleanup(f.env);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM upload_cleanup').get().n, 0);
  const liveSnapshot = await readSnapshot(f.binding), live = new MemoryStore(liveSnapshot, { bucket: f.bucket });
  live.stageFile('live-version', Buffer.from('must survive cleanup'));
  await prepareUploads(f.env, live);
  await commitStore(liveSnapshot, live);
  f.db.prepare('INSERT INTO upload_cleanup VALUES(?,?,?,?)').run('versions/live-version', 0, 0, new Date().toISOString());
  await retryCleanup(f.env);
  assert.equal(f.bucket.objects.get('versions/live-version').toString(), 'must survive cleanup');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM upload_cleanup').get().n, 0);
});

test('independent: unknown commit outcome does not delete committed bytes and retry returns the single original version', async t => {
  const f = fixture(t), owner = f.client();
  assert.equal((await f.setup(owner)).status, 200);
  const project = await owner.ok('/api/projects', 'POST', { name: '未知提交结果', goal: '保存成功但响应中断仍可恢复' });
  const bytes = Buffer.from('immutable committed bytes'), body = { projectId: project.id, name: '资料', kind: 'file', file: { name: '../../fixture.txt', mime: 'text/plain', base64: bytes.toString('base64') } };
  const operationId = randomBytes(12).toString('hex');
  let injected = false;
  f.binding.afterBatch = async statements => {
    if (!injected && statements.some(statement => statement.sql.startsWith('UPDATE cloud_revision'))) {
      injected = true;
      throw new Error('network lost after commit');
    }
  };
  const uncertain = await owner.request('/api/resources', { method: 'POST', body, headers: { 'X-Operation-Id': operationId } });
  assert.equal(uncertain.status, 503);
  f.binding.afterBatch = null;
  const retried = await owner.ok('/api/resources', 'POST', body, { 'X-Operation-Id': operationId });
  const state = await owner.ok('/api/state');
  assert.equal(state.resources.length, 1);
  assert.equal(state.versions.length, 1);
  const downloaded = await owner.ok(`/api/files/${retried.currentVersionId}`);
  assert.equal(digest(downloaded), digest(bytes));
  assert.equal(f.bucket.objects.size, 1);
  const key = [...f.bucket.objects.keys()][0];
  assert.equal(key, `versions/${retried.currentVersionId}`);
  assert.equal(key.includes('fixture.txt'), false);
  // Unknown outcomes are reconciled by checking current D1 references first.
  f.db.prepare('INSERT INTO upload_cleanup(object_key,next_attempt_at,attempts,created_at) VALUES(?,?,0,?) ON CONFLICT(object_key) DO UPDATE SET next_attempt_at=0').run(key, 0, new Date().toISOString());
  await retryCleanup(f.env);
  assert.equal(digest(await owner.ok(`/api/files/${retried.currentVersionId}`)), digest(bytes));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM upload_cleanup').get().n, 0);
});

test('independent: definite rollback cleans uploaded bytes without publishing a broken file version', async t => {
  const f = fixture(t), owner = f.client();
  assert.equal((await f.setup(owner)).status, 200);
  const project = await owner.ok('/api/projects', 'POST', { name: '回滚验收', goal: '失败不能留下坏版本' });
  f.db.exec("CREATE TRIGGER reject_resource BEFORE INSERT ON entities WHEN NEW.kind='resource' BEGIN SELECT RAISE(ABORT,'injected resource constraint'); END");
  const result = await owner.request('/api/resources', { method: 'POST', body: { projectId: project.id, name: '拒绝提交', kind: 'file', file: { name: 'valid.txt', mime: 'text/plain', base64: Buffer.from('private data').toString('base64') } } });
  assert.equal(result.status, 503);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM entities WHERE kind IN ('resource','version')").get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 0);
  assert.equal(f.bucket.objects.size, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM upload_cleanup').get().n, 0);
});

