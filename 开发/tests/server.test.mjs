import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';
import { backupDatabase } from '../server/backup.mjs';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync } from 'node:crypto';

const secret = 'Testing-unique-pass-2026!';
async function fixture(t, dataDir, expectedServerErrors = 0) {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), 'cockpit-api-'));
  const errors = [];
  const app = createApp({ dataDir: dir, onError: e => errors.push(e) });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let closed = false;
  const cleanup = async () => { if (!closed) { closed = true; await app.close(); } };
  t.after(async () => { await cleanup(); if (!dataDir) rmSync(dir, { recursive: true, force: true }); assert.equal(errors.length, expectedServerErrors, `unexpected server errors: ${errors.map(e => e.stack).join('\n')}`); });
  function client() {
    const identity = { cookie: '', csrf: '' };
    return {
      identity,
      async req(path, method = 'GET', body, overrides = {}) {
        const response = await fetch(origin + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Origin: origin, Cookie: identity.cookie, 'X-CSRF-Token': identity.csrf, ...overrides }, body: body ? JSON.stringify(body) : undefined });
        const cookie = response.headers.get('set-cookie'); if (cookie) identity.cookie = cookie.split(';')[0];
        const content = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
        if (content.csrfToken) identity.csrf = content.csrfToken;
        return { status: response.status, data: content, headers: response.headers };
      },
      async ok(path, method = 'GET', body) { const response = await this.req(path, method, body); assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(response.data)}`); return response.data; },
    };
  }
  const owner = client();
  await owner.ok('/api/setup', 'POST', { name: '所有者', email: 'owner@example.com', password: secret });
  async function member(email, role = 'member', projectId, projectRole) { const invitation = await owner.ok('/api/invitations', 'POST', { email, name: email.split('@')[0], workspaceRole: role, ...(projectId ? { projectId, projectRole } : {}) }); const user = client(); await user.ok('/api/join', 'POST', { token: invitation.token, name: email.split('@')[0], password: secret }); return user; }
  const project = (actor = owner, extra = {}) => actor.ok('/api/projects', 'POST', { name: '真实项目', goal: '按计划完成交付', ...extra });
  return { app, owner, client, member, project, origin, cleanup, dir };
}

test('初始空库、唯一初始化、真实登录会话、CSRF/同源和限流', async t => {
  const f = await fixture(t); const outsider = f.client();
  assert.equal((await outsider.ok('/api/bootstrap')).initialized, true);
  assert.equal((await f.owner.ok('/api/state')).projects.length, 0);
  assert.equal((await outsider.req('/api/state')).status, 401);
  assert.equal((await outsider.req('/api/setup', 'POST', { name: 'x', email: 'x@y.com', password: secret })).status, 409);
  assert.equal((await f.owner.req('/api/projects', 'POST', { name: 'x', goal: 'x' }, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await f.owner.req('/api/projects', 'POST', { name: 'x', goal: 'x' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.owner.req('/api/projects', 'POST', { name: 'x', goal: 'x', targetDate: '2026-99-99' })).status, 400);
  assert.equal((await outsider.req('/api/login', 'POST', { email: 'owner@example.com', password: secret })).status, 200);
  assert.match(outsider.identity.cookie, /^cockpit_session=/);
  for (let n = 0; n < 5; n++) assert.equal((await outsider.req('/api/login', 'POST', { email: 'missing@example.com', password: 'incorrect' })).status, 401);
  assert.equal((await outsider.req('/api/login', 'POST', { email: 'missing@example.com', password: 'incorrect' })).status, 429);
  await outsider.ok('/api/logout', 'POST'); assert.equal((await outsider.req('/api/state')).status, 401);
});

test('工作区管理不隐式授权项目、任务字段越权与权限先于统计', async t => {
  const f = await fixture(t); const p = await f.project(); const collaborator = await f.member('collab@example.com', 'member', p.id, 'collaborator'); const viewer = await f.member('view@example.com', 'member', p.id, 'viewer'); const admin = await f.member('admin@example.com', 'admin');
  const hidden = await f.project(collaborator, { name: '私有项目' });
  assert.equal((await admin.ok('/api/state')).projects.length, 0);
  assert.equal((await f.owner.ok('/api/state')).projects.length, 1);
  assert.equal((await f.owner.req(`/api/projects/${hidden.id}`, 'PATCH', { version: hidden.version, name: '入侵' })).status, 404);
  assert.equal((await viewer.req('/api/tasks', 'POST', { projectId: p.id, title: '不能创建' })).status, 403);
  let task = await collaborator.ok('/api/tasks', 'POST', { projectId: p.id, title: '本人任务' });
  assert.equal((await collaborator.req(`/api/tasks/${task.id}`, 'PATCH', { version: task.version, dueDate: '2026-11-01' })).status, 403);
  task = await collaborator.ok(`/api/tasks/${task.id}`, 'PATCH', { version: task.version, status: 'done' });
  assert.equal((await collaborator.req(`/api/tasks/${task.id}`, 'PATCH', { version: task.version, status: 'doing' })).status, 403);
  const cross = await f.owner.req('/api/tasks', 'POST', { projectId: p.id, title: '错误里程碑', milestoneId: 'not-here' }); assert.equal(cross.status, 400);
  const state = await f.owner.ok('/api/state'); assert.equal(state.projects[0].done, 1); assert.equal(state.projects[0].total, 1); assert.equal(state.projects[0].progress, 100); assert.equal(state.projects.some(x => x.id === hidden.id), false);
});

test('任务阻塞原子风险、并发冲突、单独风险不被任务恢复关闭、取消进度', async t => {
  const f = await fixture(t); const p = await f.project(); let task = await f.owner.ok('/api/tasks', 'POST', { projectId: p.id, title: '联调', assigneeId: null });
  assert.equal((await f.owner.req(`/api/tasks/${task.id}`, 'PATCH', { version: task.version, status: 'blocked' })).status, 400);
  assert.equal((await f.owner.ok('/api/state')).risks.length, 0);
  const oldVersion = task.version; task = await f.owner.ok(`/api/tasks/${task.id}`, 'PATCH', { version: task.version, status: 'blocked', blockReason: '等待接口' });
  assert.equal((await f.owner.ok('/api/state')).projects[0].health, 'blocked');
  assert.equal((await f.owner.req(`/api/tasks/${task.id}`, 'PATCH', { version: oldVersion, status: 'done', resolution: '已解决' })).status, 409);
  assert.equal((await f.owner.req(`/api/tasks/${task.id}`, 'PATCH', { version: task.version, status: 'doing' })).status, 400);
  await f.owner.ok('/api/risks', 'POST', { projectId: p.id, title: '独立风险', description: '迁移风险' });
  task = await f.owner.ok(`/api/tasks/${task.id}`, 'PATCH', { version: task.version, status: 'done', resolution: '收到接口并完成' });
  const state = await f.owner.ok('/api/state'); assert.equal(state.projects[0].health, 'risk'); assert.equal(state.risks.filter(r => r.status === 'closed').length, 1);
  await f.owner.ok(`/api/tasks/${task.id}`, 'PATCH', { version: task.version, status: 'cancelled' }); assert.equal((await f.owner.ok('/api/state')).projects[0].progress, null);
});

test('多来源最高授权、最后维护者保护、停用立即撤销和应急接管', async t => {
  const f = await fixture(t); const p = await f.project(); const a = await f.member('person@example.com'); const uid = (await a.ok('/api/me')).user.id;
  const team = await f.owner.ok('/api/teams', 'POST', { name: '交付团队', memberIds: [uid] }); await f.owner.ok('/api/grants', 'POST', { projectId: p.id, subjectType: 'team', subjectId: team.id, role: 'collaborator' });
  const direct = await f.owner.ok('/api/grants', 'POST', { projectId: p.id, subjectType: 'member', subjectId: uid, role: 'viewer' }); assert.equal((await a.ok('/api/state')).projects[0].role, 'collaborator'); await f.owner.ok(`/api/grants/${direct.id}`, 'DELETE'); assert.equal((await a.ok('/api/state')).projects[0].role, 'collaborator');
  const state = await f.owner.ok('/api/state'); const selfGrant = state.grants.find(g => g.subjectId === state.user.id); assert.equal((await f.owner.req(`/api/grants/${selfGrant.id}`, 'DELETE')).status, 409); assert.equal((await f.owner.ok('/api/state')).projects[0].role, 'maintainer');
  await f.owner.ok('/api/grants', 'POST', { projectId: p.id, subjectType: 'member', subjectId: uid, role: 'maintainer' });
  assert.equal((await f.owner.req(`/api/grants/${selfGrant.id}`, 'DELETE')).data.code, 'OWNER_HANDOFF_REQUIRED');
  const personal = await f.project(a); let account = (await f.owner.ok('/api/state')).members.find(m => m.id === uid); await f.owner.ok(`/api/members/${uid}`, 'PATCH', { version: account.version, status: 'suspended' }); assert.equal((await a.req('/api/state')).status, 401);
  assert.equal((await f.owner.req(`/api/projects/${personal.id}/recover`, 'POST', { reason: '紧急交接', reauthPassword: 'wrong' })).status, 403);
  const recovered = await f.owner.ok(`/api/projects/${personal.id}/recover`, 'POST', { reason: '账号已停用，所有者接管', reauthPassword: secret }); assert.equal(recovered.role, 'maintainer');
  assert.equal((await f.owner.ok('/api/audit')).some(e => e.action === 'project.emergencyRecovery'), true);
});

test('文件真实版本、恢复产生新版本、撤权与回收站下载拒绝', async t => {
  const f = await fixture(t); const p = await f.project(); const file = bytes => ({ name: '资料.txt', mime: 'text/plain', base64: Buffer.from(bytes).toString('base64') }); let r = await f.owner.ok('/api/resources', 'POST', { projectId: p.id, name: '接口说明', kind: 'file', file: file('version one') }); const first = r.currentVersionId;
  assert.equal((await f.owner.req(`/api/files/${first}`)).data, 'version one'); r = await f.owner.ok(`/api/resources/${r.id}/versions`, 'POST', { version: r.version, file: file('version two') });
  assert.equal((await f.owner.req(`/api/resources/${r.id}/versions`, 'POST', { version: r.version - 1, file: file('overwritten') })).status, 409);
  r = await f.owner.ok(`/api/resources/${r.id}/versions`, 'POST', { version: r.version, restoreVersionId: first, note: '回到第一版' }); assert.notEqual(r.currentVersionId, first); assert.equal((await f.owner.req(`/api/files/${r.currentVersionId}`)).data, 'version one');
  const viewer = await f.member('reader@example.com', 'member', p.id, 'viewer'); assert.equal((await viewer.req(`/api/files/${first}`)).status, 200); const state = await f.owner.ok('/api/state'); const grant = state.grants.find(g => g.subjectId === state.members.find(m => m.email === 'reader@example.com').id); await f.owner.ok(`/api/grants/${grant.id}`, 'DELETE'); assert.equal((await viewer.req(`/api/files/${first}`)).status, 404);
  await f.owner.ok(`/api/resources/${r.id}`, 'PATCH', { version: r.version, deleted: true }); assert.equal((await f.owner.req(`/api/files/${first}`)).status, 404); assert.equal((await f.owner.ok('/api/trash')).some(x => x.id === r.id), true); await f.owner.ok('/api/trash', 'POST', { kind: 'resource', id: r.id }); assert.equal((await f.owner.req(`/api/files/${first}`)).status, 200);
});

test('邀请绑定身份、一次性、撤销、重新鉴权和最后所有者保护', async t => {
  const f = await fixture(t); const stranger = f.client(); const invitation = await f.owner.ok('/api/invitations', 'POST', { email: 'invited@example.com', workspaceRole: 'member' }); assert.equal((await stranger.ok(`/api/invitations?token=${invitation.token}`)).email, 'invited@example.com'); await stranger.ok('/api/join', 'POST', { token: invitation.token, name: '受邀人', password: secret, email: 'ignored@example.com' }); assert.equal((await stranger.ok('/api/me')).user.email, 'invited@example.com'); assert.equal((await f.client().req('/api/join', 'POST', { token: invitation.token, name: '重复', password: secret })).status, 404);
  const revoke = await f.owner.ok('/api/invitations', 'POST', { email: 'revoke@example.com' }); await f.owner.ok(`/api/invitations/${revoke.id}`, 'DELETE'); assert.equal((await f.client().req(`/api/invitations?token=${revoke.token}`)).status, 404);
  const listed = await f.owner.ok('/api/invitations'); assert.equal(listed.some(x => x.id === revoke.id && x.status === 'revoked'), true); assert.equal(listed.some(x => x.token || x.token_hash), false); assert.equal((await stranger.req('/api/invitations')).status, 403);
  const self = (await f.owner.ok('/api/me')).user; assert.equal((await f.owner.req(`/api/members/${self.id}`, 'PATCH', { version: self.version, status: 'suspended' })).status, 409);
});

test('已完成项目归档再恢复仍完成，显式重开才可新增业务', async t => {
  const f = await fixture(t); let p = await f.project();
  p = await f.owner.ok(`/api/projects/${p.id}`, 'PATCH', { version: p.version, lifecycle: 'completed', summary: '无需拆任务的交付已由负责人完成' });
  p = await f.owner.ok(`/api/projects/${p.id}`, 'PATCH', { version: p.version, lifecycle: 'archived' }); assert.equal(p.archiveFromLifecycle, 'completed');
  p = await f.owner.ok(`/api/projects/${p.id}`, 'PATCH', { version: p.version, lifecycle: 'active' }); assert.equal(p.lifecycle, 'completed');
  assert.equal((await f.owner.req('/api/tasks', 'POST', { projectId: p.id, title: '不允许' })).status, 409);
  p = await f.owner.ok(`/api/projects/${p.id}`, 'PATCH', { version: p.version, lifecycle: 'active' }); await f.owner.ok('/api/tasks', 'POST', { projectId: p.id, title: '已明确重开' });
});

test('协作者创建且未分配的受阻任务可关闭自动阻塞，但不可关闭独立风险', async t => {
  const f = await fixture(t); const p = await f.project(); const user = await f.member('working@example.com', 'member', p.id, 'collaborator');
  let task = await user.ok('/api/tasks', 'POST', { projectId: p.id, title: '未分配', assigneeId: null, status: 'blocked', blockReason: '等待资源' });
  const ownRisk = await user.ok('/api/risks', 'POST', { projectId: p.id, title: '独立风险' }); assert.equal((await user.req(`/api/risks/${ownRisk.id}`, 'PATCH', { version: ownRisk.version, status: 'closed', resolution: '越权关闭' })).status, 403);
  task = await user.ok(`/api/tasks/${task.id}`, 'PATCH', { version: task.version, status: 'doing', resolution: '资源已到位' });
  assert.equal((await user.ok('/api/state')).projects[0].health, 'risk');
  await user.ok('/api/comments', 'POST', { projectId: p.id, taskId: task.id, text: '资源已准备完成，开始推进。' }); assert.equal((await user.ok('/api/state')).comments.length, 1);
});

test('邀请撤销/过期或邀请人失权后拒绝、管理员不能提权', async t => {
  const f = await fixture(t); const admin = await f.member('manager@example.com', 'admin');
  assert.equal((await admin.req('/api/invitations', 'POST', { email: 'newadmin@example.com', workspaceRole: 'admin' })).status, 403);
  const self = (await admin.ok('/api/me')).user; assert.equal((await admin.req(`/api/members/${self.id}`, 'PATCH', { version: self.version, workspaceRole: 'owner', reauthPassword: secret })).status, 403);
  const invitation = await admin.ok('/api/invitations', 'POST', { email: 'later@example.com' });
  await f.owner.ok(`/api/members/${self.id}`, 'PATCH', { version: self.version, workspaceRole: 'member' });
  assert.equal((await f.client().req(`/api/invitations?token=${invitation.token}`)).status, 404);
  const expired = await f.owner.ok('/api/invitations', 'POST', { email: 'expired@example.com' }); f.app.db.prepare('UPDATE invitations SET expires=1 WHERE id=?').run(expired.id); assert.equal((await f.client().req('/api/join', 'POST', { token: expired.token, name: '过期', password: secret })).status, 404);
});

test('归档只读、软删除恢复、幂等创建、重启持久化与样例精确口径', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-persist-')); t.after(() => rmSync(dir, { recursive: true, force: true })); const f = await fixture(t, dir); let p = await f.project(); const task = { projectId: p.id, title: '幂等任务', operationId: 'unique-create' }; const first = await f.owner.ok('/api/tasks', 'POST', task); const second = await f.owner.ok('/api/tasks', 'POST', task); assert.equal(first.id, second.id); assert.equal((await f.owner.ok('/api/state')).tasks.length, 1);
  p = await f.owner.ok(`/api/projects/${p.id}`, 'PATCH', { version: p.version, lifecycle: 'archived' }); assert.equal((await f.owner.req(`/api/tasks/${first.id}`, 'PATCH', { version: first.version, status: 'done' })).status, 409); p = await f.owner.ok(`/api/projects/${p.id}`, 'PATCH', { version: p.version, lifecycle: 'active' }); p = await f.owner.ok(`/api/projects/${p.id}`, 'PATCH', { version: p.version, deleted: true }); assert.equal((await f.owner.ok('/api/state')).projects.length, 0); await f.owner.ok('/api/trash', 'POST', { kind: 'project', id: p.id });
  await f.cleanup(); const reopened = createApp({ dataDir: dir }); assert.equal(reopened.db.prepare("SELECT count(*) AS n FROM entities WHERE kind='task'").get().n, 1); reopened.db.close();
  const fresh = await fixture(t); const count = await fresh.owner.ok('/api/demo', 'POST'); assert.equal(count.tasks, 93); const state = await fresh.owner.ok('/api/state'); assert.equal(state.projects.length, 6); assert.equal(state.tasks.length, 93); assert.equal(state.tasks.filter(x => x.status === 'done').length, 54); assert.deepEqual(state.projects.map(x => x.progress), [72, 45, 30, 90, 60, 0]); assert.equal(state.projects.filter(x => ['risk', 'blocked'].includes(x.health)).length, 2); assert.equal((await fresh.owner.req('/api/demo', 'POST')).status, 409);
  assert.deepEqual(state.milestones.map(m => m.title), ['联调完成', '接口验收', '设计评审', '版本发布', '内容迁移', '计划确认']);
  const portalTasks = state.tasks.filter(task => task.projectId === state.projects[1].id); assert.deepEqual(portalTasks.slice(0, 5).map(task => task.title), ['确认接口文档', '完成账户模块联调', '验证订单状态同步', '整理接口验收清单', '完成页面适配']); assert.deepEqual(['done', 'doing', 'todo', 'blocked'].map(status => portalTasks.filter(task => task.status === status).length), [9, 7, 3, 1]);
  assert.deepEqual(state.risks.map(r => r.title), ['接口文档未确认', '迁移排期可能延后']); assert.match(state.risks[0].description, /10\/27 接口验收/); assert.match(state.risks[1].description, /10\/29 内容迁移/);
});

test('项目业务导出按维护权限隔离，数据库一致备份包含真实文件字节且可恢复', async t => {
  const f = await fixture(t); const p = await f.project(); const viewer = await f.member('export-view@example.com', 'member', p.id, 'viewer'); const resource = await f.owner.ok('/api/resources', 'POST', { projectId: p.id, kind: 'file', file: { name: '验收.txt', mime: 'text/plain', base64: Buffer.from('可恢复的真实文件').toString('base64') } });
  assert.equal((await viewer.req(`/api/projects/${p.id}/export`)).status, 403);
  const exported = await f.owner.ok(`/api/projects/${p.id}/export`); assert.equal(exported.project.id, p.id); assert.equal(exported.resources.length, 1); assert.equal(exported.format, 'project-cockpit-business-export');
  const destination = join(f.dir, 'backup.sqlite'); backupDatabase(join(f.dir, 'cockpit.sqlite'), destination); assert.throws(() => backupDatabase(join(f.dir, 'cockpit.sqlite'), destination), /已存在/);
  const restored = new DatabaseSync(destination); try { const content = restored.prepare('SELECT content FROM file_bytes WHERE id=?').get(resource.currentVersionId).content; assert.equal(Buffer.from(content).toString(), '可恢复的真实文件'); assert.equal(restored.prepare("SELECT count(*) AS count FROM entities WHERE kind='project'").get().count, 1); } finally { restored.close(); }
});

test('删除团队撤回访问，不能通过团队变更绕开负责人维护权限保护', async t => {
  const f = await fixture(t); let p = await f.project(); const user = await f.member('teamowner@example.com'); const uid = (await user.ok('/api/me')).user.id; let team = await f.owner.ok('/api/teams', 'POST', { name: '维护团队', memberIds: [uid] }); await f.owner.ok('/api/grants', 'POST', { projectId: p.id, subjectType: 'team', subjectId: team.id, role: 'maintainer' }); p = await f.owner.ok(`/api/projects/${p.id}`, 'PATCH', { version: p.version, ownerId: uid });
  assert.equal((await f.owner.req(`/api/teams/${team.id}`, 'PATCH', { version: team.version, memberIds: [] })).data.code, 'OWNER_HANDOFF_REQUIRED');
  assert.equal((await f.owner.req(`/api/teams/${team.id}`, 'PATCH', { version: team.version, deleted: true })).data.code, 'OWNER_HANDOFF_REQUIRED');
  p = await f.owner.ok(`/api/projects/${p.id}`, 'PATCH', { version: p.version, ownerId: (await f.owner.ok('/api/me')).user.id }); await f.owner.ok(`/api/teams/${team.id}`, 'PATCH', { version: team.version, deleted: true }); assert.equal((await user.ok('/api/state')).projects.length, 0);
});

test('所有权转移需再认证，只有一名所有者，重置密码撤销旧会话', async t => {
  const f = await fixture(t); const user = await f.member('successor@example.com'); let successor = (await user.ok('/api/me')).user;
  assert.equal((await f.owner.req(`/api/members/${successor.id}`, 'PATCH', { version: successor.version, workspaceRole: 'owner' })).status, 403);
  successor = await f.owner.ok(`/api/members/${successor.id}`, 'PATCH', { version: successor.version, workspaceRole: 'owner', reauthPassword: secret }); assert.equal(successor.workspaceRole, 'owner');
  const state = await user.ok('/api/state'); assert.equal(state.members.filter(m => m.workspaceRole === 'owner').length, 1); const previous = (await f.owner.ok('/api/me')).user; assert.equal(previous.workspaceRole, 'admin');
  await user.ok(`/api/members/${previous.id}`, 'PATCH', { version: previous.version, password: 'Reset-password-unique!', reauthPassword: secret }); assert.equal((await f.owner.req('/api/state')).status, 401);
  assert.equal((await f.owner.req('/api/login', 'POST', { email: 'owner@example.com', password: secret })).status, 401); await f.owner.ok('/api/login', 'POST', { email: 'owner@example.com', password: 'Reset-password-unique!' });
});

test('幂等恢复项目重放重新鉴权，撤权后不能读到缓存名称与目标', async t => {
  const f = await fixture(t); let p = await f.project(f.owner, { name: '缓存不可泄露的项目', goal: '缓存不可泄露的目标' }); const other = await f.member('newmaintainer@example.com', 'member', p.id, 'maintainer'); const otherId = (await other.ok('/api/me')).user.id;
  await f.owner.ok(`/api/projects/${p.id}`, 'PATCH', { version: p.version, deleted: true });
  const restore = { kind: 'project', id: p.id, operationId: 'project-restore-once' };
  p = await f.owner.ok('/api/trash', 'POST', restore); assert.equal((await f.owner.ok('/api/trash', 'POST', restore)).id, p.id);
  p = await other.ok(`/api/projects/${p.id}`, 'PATCH', { version: p.version, ownerId: otherId });
  const current = await other.ok('/api/state'); const ownerId = (await f.owner.ok('/api/me')).user.id; const grant = current.grants.find(g => g.projectId === p.id && g.subjectType === 'member' && g.subjectId === ownerId);
  await other.ok(`/api/grants/${grant.id}`, 'DELETE');
  const replay = await f.owner.req('/api/trash', 'POST', restore); assert.equal(replay.status, 404); assert.equal(JSON.stringify(replay.data).includes('缓存不可泄露'), false);
});

test('幂等缓存重放检查当前工作区与项目写权限，降级后拒绝旧成功响应', async t => {
  const f = await fixture(t); const manager = await f.member('cachedmanager@example.com', 'admin'); const teamRequest = { name: '原管理团队', memberIds: [], operationId: 'team-create-once' }; await manager.ok('/api/teams', 'POST', teamRequest);
  const member = (await manager.ok('/api/me')).user; await f.owner.ok(`/api/members/${member.id}`, 'PATCH', { version: member.version, workspaceRole: 'member' }); assert.equal((await manager.req('/api/teams', 'POST', teamRequest)).status, 403);
  const p = await f.project(); await f.owner.ok('/api/grants', 'POST', { projectId: p.id, subjectType: 'member', subjectId: member.id, role: 'collaborator' });
  const taskRequest = { projectId: p.id, title: '仅协作身份可写', operationId: 'task-create-once' }; await manager.ok('/api/tasks', 'POST', taskRequest);
  await f.owner.ok('/api/grants', 'POST', { projectId: p.id, subjectType: 'member', subjectId: member.id, role: 'viewer' }); assert.equal((await manager.req('/api/tasks', 'POST', taskRequest)).status, 403);
});

test('被任务引用的里程碑拒绝删除，解除关联后可删除，包含回收站引用', async t => {
  const f = await fixture(t); const p = await f.project(); const milestone = await f.owner.ok('/api/milestones', 'POST', { projectId: p.id, title: '接口验收' }); let task = await f.owner.ok('/api/tasks', 'POST', { projectId: p.id, title: '接口核对', milestoneId: milestone.id });
  let result = await f.owner.req(`/api/milestones/${milestone.id}`, 'PATCH', { version: milestone.version, deleted: true }); assert.equal(result.status, 409); assert.equal(result.data.code, 'MILESTONE_IN_USE'); assert.equal((await f.owner.ok('/api/state')).milestones[0].version, milestone.version);
  task = await f.owner.ok(`/api/tasks/${task.id}`, 'PATCH', { version: task.version, deleted: true }); assert.equal((await f.owner.req(`/api/milestones/${milestone.id}`, 'PATCH', { version: milestone.version, deleted: true })).status, 409);
  task = await f.owner.ok('/api/trash', 'POST', { kind: 'task', id: task.id }); await f.owner.ok(`/api/tasks/${task.id}`, 'PATCH', { version: task.version, milestoneId: null }); await f.owner.ok(`/api/milestones/${milestone.id}`, 'PATCH', { version: milestone.version, deleted: true }); assert.equal((await f.owner.ok('/api/state')).milestones.length, 0);
});

test('未分配任务更新说明和状态始终保留null，创建省略负责人仍默认创建人', async t => {
  const f = await fixture(t); const p = await f.project(); const collaborator = await f.member('unassigned@example.com', 'member', p.id, 'collaborator'); let task = await collaborator.ok('/api/tasks', 'POST', { projectId: p.id, title: '明确未分配', assigneeId: null });
  task = await collaborator.ok(`/api/tasks/${task.id}`, 'PATCH', { version: task.version, description: '补充说明不应领取任务' }); assert.equal(task.assigneeId, null);
  task = await f.owner.ok(`/api/tasks/${task.id}`, 'PATCH', { version: task.version, status: 'doing' }); assert.equal(task.assigneeId, null);
  const defaultTask = await collaborator.ok('/api/tasks', 'POST', { projectId: p.id, title: '默认本人' }); assert.equal(defaultTask.assigneeId, (await collaborator.ok('/api/me')).user.id);
});

test('协作者新建任务与编辑权限一致，不能写入计划日期优先级或里程碑', async t => {
  const f = await fixture(t); const p = await f.project(); const collaborator = await f.member('plans@example.com', 'member', p.id, 'collaborator'); const milestone = await f.owner.ok('/api/milestones', 'POST', { projectId: p.id, title: '项目验收' });
  for (const fields of [{ dueDate: '2026-11-01' }, { priority: 'high' }, { milestoneId: milestone.id }]) assert.equal((await collaborator.req('/api/tasks', 'POST', { projectId: p.id, title: '不能越权设置计划', ...fields })).status, 403);
  const task = await collaborator.ok('/api/tasks', 'POST', { projectId: p.id, title: '默认计划', priority: 'medium', dueDate: '', milestoneId: null }); assert.equal(task.priority, 'medium'); assert.equal(task.dueDate, ''); assert.equal(task.milestoneId, null); assert.equal((await f.owner.ok('/api/state')).tasks.length, 1);
});

test('资料链接创建和更新均拒绝非字符串、超长与非HTTPS地址', async t => {
  const f = await fixture(t); const p = await f.project(); const resource = await f.owner.ok('/api/resources', 'POST', { projectId: p.id, name: '项目文档', kind: 'link', url: 'https://example.com/old' });
  for (const invalid of [['https://example.com/array'], 'https://example.com/' + 'a'.repeat(2000), 'javascript:alert(1)', '']) assert.equal((await f.owner.req(`/api/resources/${resource.id}`, 'PATCH', { version: resource.version, url: invalid })).status, 400);
  const updated = await f.owner.ok(`/api/resources/${resource.id}`, 'PATCH', { version: resource.version, url: ' https://example.com/new ' }); assert.equal(updated.url, 'https://example.com/new');
});

test('共享反代IP的成功认证不累积失败限流，邮箱失败保护仍有效', async t => {
  const f = await fixture(t); const login = f.client();
  for (let n = 0; n < 42; n++) await login.ok('/api/login', 'POST', { email: 'owner@example.com', password: secret });
  assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM login_attempts WHERE failures>0').get().n, 0);
  for (let n = 0; n < 5; n++) assert.equal((await login.req('/api/login', 'POST', { email: 'owner@example.com', password: 'not-the-password' })).status, 401);
  assert.equal((await login.req('/api/login', 'POST', { email: 'owner@example.com', password: 'not-the-password' })).status, 429);
});

test('重要变更审计保留业务字段前后值及成员前状态，不写入密码', async t => {
  const f = await fixture(t); const p = await f.project(); const member = await f.member('audit-member@example.com'); const uid = (await member.ok('/api/me')).user.id;
  let team = await f.owner.ok('/api/teams', 'POST', { name: '旧团队名', memberIds: [] }); team = await f.owner.ok(`/api/teams/${team.id}`, 'PATCH', { version: team.version, name: '新团队名', memberIds: [uid] });
  let task = await f.owner.ok('/api/tasks', 'POST', { projectId: p.id, title: '旧任务', dueDate: '2026-10-23' }); task = await f.owner.ok(`/api/tasks/${task.id}`, 'PATCH', { version: task.version, title: '新任务', dueDate: '2026-10-24', priority: 'high' });
  let milestone = await f.owner.ok('/api/milestones', 'POST', { projectId: p.id, title: '计划评审', dueDate: '2026-10-25' }); milestone = await f.owner.ok(`/api/milestones/${milestone.id}`, 'PATCH', { version: milestone.version, dueDate: '2026-10-27', status: 'done' });
  let risk = await f.owner.ok('/api/risks', 'POST', { projectId: p.id, title: '需要确认', nextStep: '沟通' }); risk = await f.owner.ok(`/api/risks/${risk.id}`, 'PATCH', { version: risk.version, status: 'closed', resolution: '已确认' });
  const account = (await f.owner.ok('/api/state')).members.find(m => m.id === uid); await f.owner.ok(`/api/members/${uid}`, 'PATCH', { version: account.version, status: 'suspended', password: 'Replacement-secret-unique!', reauthPassword: secret });
  const audit = await f.owner.ok('/api/audit'); const details = (action, objectId) => audit.find(event => event.action === action && event.objectId === objectId).details;
  assert.deepEqual(details('team.updated', team.id).before.memberIds, []); assert.deepEqual(details('team.updated', team.id).after.memberIds, [uid]); assert.equal(details('team.updated', team.id).before.name, '旧团队名');
  assert.equal(details('task.updated', task.id).before.dueDate, '2026-10-23'); assert.equal(details('task.updated', task.id).after.dueDate, '2026-10-24'); assert.equal(details('task.updated', task.id).after.priority, 'high');
  assert.equal(details('milestone.updated', milestone.id).before.status, 'pending'); assert.equal(details('milestone.updated', milestone.id).after.status, 'done'); assert.equal(details('risk.updated', risk.id).before.status, 'open'); assert.equal(details('risk.updated', risk.id).after.resolution, '已确认');
  assert.equal(details('member.updated', uid).beforeStatus, 'active'); assert.equal(details('member.updated', uid).status, 'suspended'); assert.equal(JSON.stringify(audit).includes(secret), false); assert.equal(JSON.stringify(audit).includes('Replacement-secret-unique!'), false);
});

test('审计先过滤授权再截取500条，其他项目高频事件不挤掉自己的记录', async t => {
  const f = await fixture(t); const visible = await f.project(); const member = await f.member('private-audit@example.com'); const hidden = await f.project(member, { name: '不可见项目' });
  const statement = f.app.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)');
  for (let n = 0; n < 505; n++) statement.run('private-audit-' + n, hidden.id, (await member.ok('/api/me')).user.id, 'private.event', 'project', hidden.id, '2099-01-01T00:00:00.000Z', JSON.stringify({ secret: '不应显示' }));
  const audit = await f.owner.ok('/api/audit'); assert.equal(audit.some(event => event.action === 'project.created' && event.projectId === visible.id), true); assert.equal(audit.some(event => event.projectId === hidden.id), false);
});

test('进度按有效任务计算：空分母、1/3、取消删除恢复和199/200向下取整', async t => {
  const f = await fixture(t); const p = await f.project();
  const current = async projectId => (await f.owner.ok('/api/state')).projects.find(project => project.id === projectId);
  let metrics = await current(p.id); assert.equal(metrics.total, 0); assert.equal(metrics.done, 0); assert.equal(metrics.progress, null);
  let completed = await f.owner.ok('/api/tasks', 'POST', { projectId: p.id, title: '完成的一项', status: 'done' });
  let cancelled = await f.owner.ok('/api/tasks', 'POST', { projectId: p.id, title: '准备取消' });
  let deleted = await f.owner.ok('/api/tasks', 'POST', { projectId: p.id, title: '准备删除和恢复' });
  metrics = await current(p.id); assert.deepEqual([metrics.done, metrics.total, metrics.progress], [1, 3, 33]);
  cancelled = await f.owner.ok(`/api/tasks/${cancelled.id}`, 'PATCH', { version: cancelled.version, status: 'cancelled' });
  metrics = await current(p.id); assert.deepEqual([metrics.done, metrics.total, metrics.progress], [1, 2, 50]);
  deleted = await f.owner.ok(`/api/tasks/${deleted.id}`, 'PATCH', { version: deleted.version, deleted: true });
  metrics = await current(p.id); assert.deepEqual([metrics.done, metrics.total, metrics.progress], [1, 1, 100]);
  deleted = await f.owner.ok('/api/trash', 'POST', { kind: 'task', id: deleted.id });
  metrics = await current(p.id); assert.deepEqual([metrics.done, metrics.total, metrics.progress], [1, 2, 50]);
  completed = await f.owner.ok(`/api/tasks/${completed.id}`, 'PATCH', { version: completed.version, status: 'cancelled' });
  metrics = await current(p.id); assert.deepEqual([metrics.done, metrics.total, metrics.progress], [0, 1, 0]);
  await f.owner.ok(`/api/tasks/${deleted.id}`, 'PATCH', { version: deleted.version, deleted: true });
  metrics = await current(p.id); assert.deepEqual([metrics.done, metrics.total, metrics.progress], [0, 0, null]);

  const large = await f.project(f.owner, { name: '百分比边界项目' });
  for (let n = 1; n <= 199; n++) await f.owner.ok('/api/tasks', 'POST', { projectId: large.id, title: `已完成任务${n}`, status: 'done' });
  let last = await f.owner.ok('/api/tasks', 'POST', { projectId: large.id, title: '最后一项未完成' });
  metrics = await current(large.id); assert.deepEqual([metrics.done, metrics.total, metrics.progress], [199, 200, 99]);
  last = await f.owner.ok(`/api/tasks/${last.id}`, 'PATCH', { version: last.version, status: 'done' });
  metrics = await current(large.id); assert.deepEqual([metrics.done, metrics.total, metrics.progress], [200, 200, 100]);
  assert.equal(metrics.lifecycle, 'planned', '任务100%不得自动完成项目');
});

test('完成项目逐项校验闭环与摘要，完成和归档禁止资源评论写入但允许撤权', async t => {
  const f = await fixture(t); let p = await f.project();
  let task = await f.owner.ok('/api/tasks', 'POST', { projectId: p.id, title: '需要交付的任务' });
  let milestone = await f.owner.ok('/api/milestones', 'POST', { projectId: p.id, title: '交付验收' });
  let risk = await f.owner.ok('/api/risks', 'POST', { projectId: p.id, title: '验收风险' });
  const resourceBody = { projectId: p.id, kind: 'file', name: '交付文件', file: { name: '交付.txt', mime: 'text/plain', base64: Buffer.from('交付内容').toString('base64') } };
  const resource = await f.owner.ok('/api/resources', 'POST', resourceBody);
  const viewer = await f.member('completion-reader@example.com', 'member', p.id, 'viewer'); const viewerId = (await viewer.ok('/api/me')).user.id;
  const complete = summary => f.owner.req(`/api/projects/${p.id}`, 'PATCH', { version: p.version, lifecycle: 'completed', summary });
  assert.equal((await complete('尚未满足条件')).status, 409, '未完成任务时不能完成');
  task = await f.owner.ok(`/api/tasks/${task.id}`, 'PATCH', { version: task.version, status: 'done' });
  assert.equal((await complete('任务已完成')).status, 409, '未完成里程碑时不能完成');
  milestone = await f.owner.ok(`/api/milestones/${milestone.id}`, 'PATCH', { version: milestone.version, status: 'done' });
  assert.equal((await complete('任务和里程碑已完成')).status, 409, '开放风险时不能完成');
  risk = await f.owner.ok(`/api/risks/${risk.id}`, 'PATCH', { version: risk.version, status: 'closed', resolution: '验收依据已确认' });
  assert.equal((await complete('   ')).status, 400, '全部闭环后仍须完成摘要');
  p = (await complete('任务、里程碑和风险已闭环，验收完成')).data; assert.equal(p.lifecycle, 'completed');

  for (const lifecycle of ['completed', 'archived']) {
    if (lifecycle === 'archived') {
      await f.owner.ok('/api/grants', 'POST', { projectId: p.id, subjectType: 'member', subjectId: viewerId, role: 'viewer' });
      p = await f.owner.ok(`/api/projects/${p.id}`, 'PATCH', { version: p.version, lifecycle: 'archived' });
    }
    assert.equal((await f.owner.req('/api/resources', 'POST', resourceBody)).status, 409, `${lifecycle}不能新增资源`);
    assert.equal((await f.owner.req(`/api/resources/${resource.id}`, 'PATCH', { version: resource.version, description: '不应保存' })).status, 409, `${lifecycle}不能编辑资源`);
    assert.equal((await f.owner.req('/api/comments', 'POST', { projectId: p.id, taskId: task.id, text: '不应保存的评论' })).status, 409, `${lifecycle}不能新增评论`);
    const state = await f.owner.ok('/api/state'); const grant = state.grants.find(item => item.projectId === p.id && item.subjectType === 'member' && item.subjectId === viewerId);
    await f.owner.ok(`/api/grants/${grant.id}`, 'DELETE');
    assert.equal((await viewer.ok('/api/state')).projects.some(project => project.id === p.id), false, `${lifecycle}仍须允许撤权`);
    assert.equal((await f.owner.ok('/api/state')).resources[0].description, '', '失败编辑不得修改资料');
  }
});

test('实际文件超过10MiB和非法base64均回滚，路径文件名不产生物理路径', async t => {
  const f = await fixture(t); const p = await f.project();
  assert.equal((await f.owner.ok('/api/bootstrap')).limits.maxFileBytes, 10 * 1024 * 1024);
  const beforeFiles = readdirSync(f.dir).sort();
  const upload = file => f.owner.req('/api/resources', 'POST', { projectId: p.id, name: '上传校验', kind: 'file', file });
  const overLimit = { name: '超限.bin', mime: 'application/octet-stream', base64: Buffer.alloc(10 * 1024 * 1024 + 1, 65).toString('base64') };
  const rejected = await upload(overLimit); assert.equal(rejected.status, 413); assert.equal(rejected.data.code, 'TOO_LARGE');
  assert.equal((await upload({ name: '非法.txt', mime: 'text/plain', base64: '@@不是base64@@' })).status, 400);
  let state = await f.owner.ok('/api/state'); assert.equal(state.resources.length, 0); assert.equal(state.versions.length, 0);
  assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM file_bytes').get().n, 0, '失败上传不得留下字节');

  const content = '路径片段只作为显示名，不作为物理路径';
  const result = await upload({ name: '../../越界目录/子目录\\资料.txt', mime: 'text/plain', base64: Buffer.from(content).toString('base64') }); assert.equal(result.status, 200);
  state = await f.owner.ok('/api/state'); const version = state.versions.find(item => item.id === result.data.currentVersionId);
  assert.equal(/[\\/\r\n]/.test(version.fileName), false, '下载文件名不得保留路径分隔符');
  assert.equal((await f.owner.req(`/api/files/${version.id}`)).data, content);
  assert.deepEqual(readdirSync(f.dir).sort(), beforeFiles, '文件存储为SQLite字节，不以输入文件名创建文件或目录');
  assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM file_bytes').get().n, 1);
});

test('恰好10MiB合法文件可上传并原样下载，非规范base64不留半成品', async t => {
  const f = await fixture(t); const p = await f.project();
  const original = Buffer.alloc(10 * 1024 * 1024, 0xab);
  const resource = await f.owner.ok('/api/resources', 'POST', { projectId: p.id, name: '上限边界文件', kind: 'file', file: { name: '上限边界.bin', mime: 'application/octet-stream', base64: original.toString('base64') } });
  const state = await f.owner.ok('/api/state'); const version = state.versions.find(item => item.id === resource.currentVersionId); assert.equal(version.size, original.length);
  const downloaded = await fetch(f.origin + '/api/files/' + version.id, { headers: { Cookie: f.owner.identity.cookie } }); assert.equal(downloaded.status, 200); assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), original);
  const beforeVersion = resource.version;
  for (const malformed of ['A===', '=AAA', 'AAAA====', 'Zh==']) assert.equal((await f.owner.req(`/api/resources/${resource.id}/versions`, 'POST', { version: beforeVersion, file: { name: '错误.bin', mime: 'application/octet-stream', base64: malformed } })).status, 400);
  const after = await f.owner.ok('/api/state'); assert.equal(after.resources[0].version, beforeVersion); assert.equal(after.versions.length, 1); assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM file_bytes').get().n, 1);
});

test('旧账号库原位迁移默认时区，个人IANA偏好持久化且不改计划日历日期', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'cockpit-timezone-legacy-'));
  const legacy = new DatabaseSync(join(directory, 'cockpit.sqlite'));
  legacy.exec("CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,workspace_role TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',version INTEGER NOT NULL DEFAULT 1)");
  const salt = randomBytes(16).toString('hex');
  legacy.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run('legacy-owner', '原有所有者', 'legacy@example.test', salt + ':' + scryptSync(secret, salt, 64).toString('hex'), 'owner', 'active', 1); legacy.close();
  let app = createApp({ dataDir: directory });
  try {
    await new Promise(ready => app.server.listen(0, '127.0.0.1', ready));
    const origin = 'http://127.0.0.1:' + app.server.address().port;
    const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'legacy@example.test', password: secret }) }); assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0]; const identity = await login.json(); assert.equal(identity.user.timeZone, 'Asia/Shanghai'); assert.equal(identity.user.id, 'legacy-owner');
    const headers = { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': identity.csrfToken };
    let response = await fetch(origin + '/api/me', { method: 'PATCH', headers, body: JSON.stringify({ timeZone: 'America/Los_Angeles' }) }); assert.equal(response.status, 200); assert.equal((await response.json()).user.timeZone, 'America/Los_Angeles');
    for (const zone of ['Invalid/Zone', '+08:00', '']) { response = await fetch(origin + '/api/me', { method: 'PATCH', headers, body: JSON.stringify({ timeZone: zone }) }); assert.equal(response.status, 400); }
    response = await fetch(origin + '/api/projects', { method: 'POST', headers, body: JSON.stringify({ name: '日期不漂移', goal: '按日历日管理', targetDate: '2026-10-23' }) }); assert.equal(response.status, 200); assert.equal((await response.json()).targetDate, '2026-10-23');
    await app.close(); app = createApp({ dataDir: directory }); await new Promise(ready => app.server.listen(0, '127.0.0.1', ready));
    const persisted = await fetch('http://127.0.0.1:' + app.server.address().port + '/api/me', { headers: { Cookie: cookie } }); assert.equal(persisted.status, 200); assert.equal((await persisted.json()).user.timeZone, 'America/Los_Angeles');
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('个人改密、管理重置、所有权转移和应急接管的密码失败明确要求再次认证', async t => {
  const f = await fixture(t); const member = await f.member('reauth@example.com'); const account = (await member.ok('/api/me')).user;
  const assertReauth = response => { assert.equal(response.status, 403); assert.equal(response.data.code, 'REAUTH_REQUIRED'); };
  assertReauth(await f.owner.req('/api/me', 'PATCH', { password: 'New-personal-secret!', currentPassword: 'incorrect' }));
  assertReauth(await f.owner.req(`/api/members/${account.id}`, 'PATCH', { version: account.version, password: 'New-member-secret!', reauthPassword: 'incorrect' }));
  assertReauth(await f.owner.req(`/api/members/${account.id}`, 'PATCH', { version: account.version, workspaceRole: 'owner', reauthPassword: 'incorrect' }));
  const privateProject = await f.project(member); assertReauth(await f.owner.req(`/api/projects/${privateProject.id}/recover`, 'POST', { reason: '验证再次认证反馈', reauthPassword: 'incorrect' }));
  assert.equal((await f.owner.ok('/api/me')).user.workspaceRole, 'owner'); assert.equal((await member.ok('/api/me')).user.version, account.version);
  await f.owner.ok('/api/me', 'PATCH', { name: '认证失败后仍有有效会话' });
});

function zipFixture(entries) {
  const local = [], directory = []; let offset = 0;
  const crc32 = bytes => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; };
  for (const [filename, content] of entries) {
    const name = Buffer.from(filename), data = Buffer.from(content), checksum = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(checksum, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt32LE(checksum, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42); directory.push(record, name); offset += header.length + name.length + data.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, central, end]);
}

test('真实签名识别PDF图片文本Office ZIP，声明不符拒绝且未知二进制标明边界', async t => {
  const f = await fixture(t); const p = await f.project();
  const upload = (bytes, mime, name = '文件') => f.owner.req('/api/resources', 'POST', { projectId: p.id, name, kind: 'file', file: { name, mime, base64: bytes.toString('base64') } });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');
  const text = Buffer.from('真实中文资料\n日期：2026-10-23');
  const svg = Buffer.from('<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "https://example.invalid/svg.dtd">\n<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>');
  const xml = Buffer.from('<!-- 导出配置省略XML声明 -->\n<config><enabled>true</enabled></config>');
  for (const [bytes, mime, detected] of [[png, 'image/png', 'png'], [pdf, 'application/pdf', 'pdf'], [text, 'text/markdown', 'text'], [svg, 'image/svg+xml', 'svg'], [xml, 'application/xml', 'xml'], [xml, 'text/xml', 'xml']]) { const response = await upload(bytes, mime); assert.equal(response.status, 200); const state = await f.owner.ok('/api/state'); const version = state.versions.find(v => v.id === response.data.currentVersionId); assert.equal(version.detectedType, detected); assert.equal(version.typeVerified, true); }
  for (const [path, mime, detected] of [['word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'], ['xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'], ['ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx']]) {
    const zip = zipFixture([['[Content_Types].xml', '<Types/>'], [path, '<document/>']]); const response = await upload(zip, mime); assert.equal(response.status, 200); const state = await f.owner.ok('/api/state'); assert.equal(state.versions.find(v => v.id === response.data.currentVersionId).detectedType, detected);
  }
  const count = (await f.owner.ok('/api/state')).versions.length;
  for (const [bytes, mime] of [[png, 'application/pdf'], [text, 'image/png'], [pdf, 'text/plain'], [zipFixture([['xl/workbook.xml', '<workbook/>'], ['[Content_Types].xml', '<Types/>']]), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']]) { const response = await upload(bytes, mime); assert.equal(response.status, 400); assert.equal(response.data.code, 'FILE_TYPE_MISMATCH'); }
  assert.equal((await f.owner.ok('/api/state')).versions.length, count);
  const unknown = await upload(Buffer.from([0, 255, 1, 2]), 'application/octet-stream'); assert.equal(unknown.status, 200); const version = (await f.owner.ok('/api/state')).versions.find(v => v.id === unknown.data.currentVersionId); assert.equal(version.detectedType, 'unknown'); assert.equal(version.detectedMime, null); assert.equal(version.typeVerified, false);
});

test('AC15真实SQLite trigger注入关联阻塞写入失败，任务版本风险审计与幂等同事务回滚', async t => {
  const f = await fixture(t, undefined, 1); const p = await f.project(); const task = await f.owner.ok('/api/tasks', 'POST', { projectId: p.id, title: '验证原子阻塞写入', status: 'doing' });
  const before = await f.owner.ok('/api/state'); const auditCount = before.audit.length;
  f.app.db.exec("CREATE TRIGGER ac15_reject_blocker BEFORE INSERT ON entities WHEN NEW.kind='risk' AND json_extract(NEW.payload,'$.taskId') IS NOT NULL BEGIN SELECT RAISE(ABORT,'AC15 injected failure'); END");
  const request = { version: task.version, status: 'blocked', blockReason: '等待接口提供', operationId: 'ac15-retry-after-storage-failure' };
  const failure = await f.owner.req(`/api/tasks/${task.id}`, 'PATCH', request); assert.equal(failure.status, 500); assert.equal(failure.data.code, 'INTERNAL_ERROR'); assert.equal(JSON.stringify(failure.data).includes('injected'), false);
  let state = await f.owner.ok('/api/state'); const unchanged = state.tasks.find(item => item.id === task.id); assert.equal(unchanged.status, 'doing'); assert.equal(unchanged.version, task.version); assert.equal(state.risks.length, 0); assert.equal(state.audit.length, auditCount); assert.equal(state.projects[0].health, 'normal'); assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM operations WHERE key=?').get(request.operationId).n, 0);
  f.app.db.exec('DROP TRIGGER ac15_reject_blocker'); const saved = await f.owner.ok(`/api/tasks/${task.id}`, 'PATCH', request); assert.equal(saved.status, 'blocked'); await f.owner.ok(`/api/tasks/${task.id}`, 'PATCH', request);
  state = await f.owner.ok('/api/state'); assert.equal(state.tasks.find(item => item.id === task.id).version, task.version + 1); assert.equal(state.risks.filter(item => item.taskId === task.id && item.status === 'open').length, 1); assert.equal(state.projects[0].health, 'blocked');
});

test('里程碑重开保留完成事实并记录reopenedAt，完整历史仍限维护者', async t => {
  const f = await fixture(t); const p = await f.project(); const collaborator = await f.member('milestone-history@example.com', 'member', p.id, 'collaborator');
  let milestone = await f.owner.ok('/api/milestones', 'POST', { projectId: p.id, title: '里程碑历史', status: 'done' }); const completedAt = milestone.completedAt; assert.ok(completedAt);
  milestone = await f.owner.ok(`/api/milestones/${milestone.id}`, 'PATCH', { version: milestone.version, status: 'pending' }); assert.equal(milestone.completedAt, completedAt); assert.ok(milestone.reopenedAt);
  const event = (await f.owner.ok('/api/audit')).find(entry => entry.action === 'milestone.updated' && entry.objectId === milestone.id); assert.equal(event.details.before.status, 'done'); assert.equal(event.details.after.status, 'pending'); assert.equal(event.details.after.reopenedAt, milestone.reopenedAt);
  const visible = await collaborator.ok('/api/state'); assert.equal(visible.milestones[0].reopenedAt, milestone.reopenedAt); assert.equal(visible.audit.some(entry => entry.projectId === p.id), false);
});

test('对象历史供有效读取角色查看全部自身变更，超过500条仍完整且撤权不泄露', async t => {
  const f = await fixture(t); const p = await f.project(); const viewer = await f.member('history-reader@example.com', 'member', p.id, 'viewer'); const stranger = await f.member('history-private@example.com'); const hidden = await f.project(stranger);
  const task = await f.owner.ok('/api/tasks', 'POST', { projectId: p.id, title: '长期任务历史' }); let milestone = await f.owner.ok('/api/milestones', 'POST', { projectId: p.id, title: '长期里程碑', status: 'done' }); milestone = await f.owner.ok(`/api/milestones/${milestone.id}`, 'PATCH', { version: milestone.version, status: 'pending' });
  const insert = f.app.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)');
  for (let n = 0; n < 505; n++) insert.run('history-' + n, p.id, task.createdBy, 'task.updated', 'task', task.id, '2020-01-01T00:00:00.000Z', JSON.stringify({ before: { description: 'old-' + n }, after: { description: 'new-' + n } }));
  insert.run('wrong-project-history', hidden.id, task.createdBy, 'task.updated', 'task', task.id, '2020-01-01T00:00:00.000Z', JSON.stringify({ secret: '不可返回的其他项目历史' }));
  const history = await viewer.ok(`/api/tasks/${task.id}/history`); assert.equal(history.length, 506); assert.equal(history[0].id, 'history-0'); assert.equal(history.at(-1).action, 'task.created'); assert.equal(history.every(event => event.projectId === p.id && event.objectId === task.id && event.kind === 'task'), true); assert.equal(JSON.stringify(history).includes('不可返回'), false);
  const milestoneHistory = await viewer.ok(`/api/milestones/${milestone.id}/history`); assert.deepEqual(milestoneHistory.map(event => event.action), ['milestone.created', 'milestone.updated']);
  assert.equal((await stranger.req(`/api/tasks/${task.id}/history`)).status, 404);
  const state = await f.owner.ok('/api/state'); const uid = (await viewer.ok('/api/me')).user.id; const grant = state.grants.find(item => item.projectId === p.id && item.subjectId === uid); await f.owner.ok(`/api/grants/${grant.id}`, 'DELETE'); assert.equal((await viewer.req(`/api/tasks/${task.id}/history`)).status, 404);
});

test('评论本人或维护者可编辑软删除，保留作者和审计，拒绝越权冲突与只读写入', async t => {
  const f = await fixture(t); const p = await f.project(); const author = await f.member('comment-author@example.com', 'member', p.id, 'collaborator'); const other = await f.member('comment-other@example.com', 'member', p.id, 'collaborator'); const task = await f.owner.ok('/api/tasks', 'POST', { projectId: p.id, title: '评论测试' });
  let comment = await author.ok('/api/comments', 'POST', { projectId: p.id, taskId: task.id, text: '原始讨论' }); const createdBy = comment.createdBy, initialVersion = comment.version;
  assert.equal((await other.req(`/api/comments/${comment.id}`, 'PATCH', { version: comment.version, text: '不能篡改' })).status, 403);
  comment = await author.ok(`/api/comments/${comment.id}`, 'PATCH', { version: comment.version, text: '本人补充说明' }); assert.equal(comment.createdBy, createdBy); assert.ok(comment.editedAt);
  assert.equal((await author.req(`/api/comments/${comment.id}`, 'PATCH', { version: initialVersion, text: '旧表单' })).status, 409);
  const archived = await f.owner.ok(`/api/projects/${p.id}`, 'PATCH', { version: p.version, lifecycle: 'archived' }); assert.equal((await author.req(`/api/comments/${comment.id}`, 'PATCH', { version: comment.version, deleted: true })).status, 409); await f.owner.ok(`/api/projects/${p.id}`, 'PATCH', { version: archived.version, lifecycle: 'active' });
  comment = await f.owner.ok(`/api/comments/${comment.id}`, 'PATCH', { version: comment.version, text: '维护者修正' }); assert.equal(comment.createdBy, createdBy);
  const deletion = { version: comment.version, deleted: true, operationId: 'comment-soft-delete' }; await author.ok(`/api/comments/${comment.id}`, 'PATCH', deletion); await author.ok(`/api/comments/${comment.id}`, 'PATCH', deletion);
  const state = await f.owner.ok('/api/state'); assert.equal(state.comments.length, 0); assert.ok(f.app.db.prepare('SELECT deleted_at FROM entities WHERE id=?').get(comment.id).deleted_at);
  const events = state.audit.filter(event => event.objectId === comment.id); assert.equal(events.some(event => event.action === 'comment.updated' && event.details.before.text === '原始讨论' && event.details.after.text === '本人补充说明'), true); assert.equal(events.filter(event => event.action === 'comment.deleted').length, 1);
});
