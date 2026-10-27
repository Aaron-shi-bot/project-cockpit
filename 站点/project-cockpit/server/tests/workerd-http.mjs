import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

// Runs against a real local workerd instance with an EMPTY, isolated D1/R2
// persistence directory. It deliberately refuses all public hostnames.
const origin = process.env.CLOUD_TEST_ORIGIN ?? 'http://127.0.0.1:4176';
const parsed = new URL(origin);
assert.ok(['127.0.0.1', 'localhost'].includes(parsed.hostname), '只能连接隔离的本机验收服务');
assert.ok(process.env.BOOTSTRAP_TOKEN?.length >= 43, '必须通过环境提供初始化密钥');
const password = 'Workerd-regression-' + randomBytes(24).toString('hex');
const email = 'worker-' + randomBytes(8).toString('hex') + '@example.test';
let checks = 0;
const startedAt = Date.now();
function client() {
  let cookie = '', csrf = '';
  return {
    async request(path, method = 'GET', body, headers = {}) {
      const response = await fetch(origin + path, { method, headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
      const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
      const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
      if (data?.csrfToken) csrf = data.csrfToken;
      return { response, data };
    },
    async ok(path, method = 'GET', body, headers) { const result = await this.request(path, method, body, headers); assert.equal(result.response.status, 200, `${method} ${path}: ${JSON.stringify(result.data)}`); checks++; return result; },
  };
}
const owner = client(), anonymous = client();
const bootstrap = (await owner.ok('/api/bootstrap')).data;
assert.equal(bootstrap.initialized, false, '验收必须使用全新的隔离数据库'); assert.equal(bootstrap.setupProtected, true);
assert.equal((await anonymous.request('/api/setup', 'POST', { name: '隔离验收', email, password })).response.status, 403); checks++;
const setup = await owner.ok('/api/setup', 'POST', { name: '隔离验收', email, password }, { 'X-Bootstrap-Token': process.env.BOOTSTRAP_TOKEN });
assert.match(setup.response.headers.get('set-cookie'), /Secure/); assert.match(setup.response.headers.get('set-cookie'), /Max-Age=28800/);
await anonymous.ok('/api/login', 'POST', { email, password }); // actual workerd scrypt verify
assert.equal((await client().request('/api/state')).response.status, 401); checks++;
await owner.ok('/api/me', 'PATCH', { timeZone: 'America/New_York' }); assert.equal((await owner.ok('/api/me')).data.user.timeZone, 'America/New_York');
const project = (await owner.ok('/api/projects', 'POST', { name: '隔离云运行时验收', goal: '只验收，不上线业务数据', operationId: 'worker-project' })).data;
const task = (await owner.ok('/api/tasks', 'POST', { projectId: project.id, title: '原子阻塞', status: 'doing' })).data;
const blocked = (await owner.ok('/api/tasks/' + task.id, 'PATCH', { version: task.version, status: 'blocked', blockReason: '等待验收' })).data;
assert.equal((await owner.ok('/api/state')).data.risks.filter(r => r.taskId === task.id && r.status === 'open').length, 1);
await owner.ok('/api/tasks/' + task.id, 'PATCH', { version: blocked.version, status: 'done', resolution: '验收完成' });
const history = (await owner.ok('/api/tasks/' + task.id + '/history')).data; assert.ok(history.length >= 3);
const file = text => ({ name: '真实字节.txt', mime: 'text/plain', base64: Buffer.from(text).toString('base64') });
let resource = (await owner.ok('/api/resources', 'POST', { projectId: project.id, kind: 'file', file: file('workerd v1 中文') })).data;
const firstId = resource.currentVersionId;
resource = (await owner.ok('/api/resources/' + resource.id + '/versions', 'POST', { version: resource.version, file: file('workerd v2 中文') })).data;
assert.equal((await owner.ok('/api/files/' + firstId)).data.toString(), 'workerd v1 中文');
assert.equal((await owner.ok('/api/files/' + resource.currentVersionId)).data.toString(), 'workerd v2 中文');
const invitation = (await owner.ok('/api/invitations', 'POST', { email: 'reader-' + randomBytes(8).toString('hex') + '@example.test', projectId: project.id, projectRole: 'viewer' })).data;
const reader = client(); await reader.ok('/api/join', 'POST', { token: invitation.token, name: '隔离受邀者', password });
assert.equal((await reader.request('/api/tasks', 'POST', { projectId: project.id, title: '越权' })).response.status, 403); checks++;
await reader.ok('/api/files/' + firstId);
const state = (await owner.ok('/api/state')).data;
const grant = state.grants.find(g => g.subjectId === state.members.find(m => m.email === invitation.email).id);
await owner.ok('/api/grants/' + grant.id, 'DELETE'); assert.equal((await reader.request('/api/files/' + firstId)).response.status, 404); checks++;
assert.equal((await owner.request('/api/demo', 'POST', {})).response.status, 403); checks++;
if (process.env.CLOUD_TEST_FILE_BOUNDARY === '1') {
  const bytes = Buffer.alloc(10 * 1024 * 1024, 65);
  const large = (await owner.ok('/api/resources', 'POST', { projectId: project.id, kind: 'file', file: file(bytes) })).data;
  const actual = (await owner.ok('/api/files/' + large.currentVersionId)).data;
  assert.equal(createHash('sha256').update(actual).digest('hex'), createHash('sha256').update(bytes).digest('hex'));
  assert.equal((await owner.request('/api/resources', 'POST', { projectId: project.id, kind: 'file', file: file(Buffer.alloc(bytes.length + 1, 65)) })).response.status, 413); checks++;
}
async function expect(actor, path, method, body, status, headers) {
  const result = await actor.request(path, method, body, headers); assert.equal(result.response.status, status, `${method} ${path}: ${JSON.stringify(result.data)}`); checks++; return result;
}
await expect(owner, '/api/projects', 'POST', { name: '拒绝跨站', goal: '安全检查' }, 403, { Origin: 'https://evil.example.test' });
await expect(owner, '/api/projects', 'POST', { name: '拒绝CSRF', goal: '安全检查' }, 403, { 'X-CSRF-Token': 'wrong' });
const duplicate = (await owner.ok('/api/projects', 'POST', { name: '隔离云运行时验收', goal: '只验收，不上线业务数据', operationId: 'worker-project' })).data; assert.equal(duplicate.id, project.id);
const collaborativeInvite = (await owner.ok('/api/invitations', 'POST', { email: 'collab-' + randomBytes(8).toString('hex') + '@example.test', projectId: project.id, projectRole: 'collaborator' })).data;
assert.equal((await client().ok('/api/invitations?token=' + collaborativeInvite.token)).data.email, collaborativeInvite.email);
const collaborator = client(); await collaborator.ok('/api/join', 'POST', { token: collaborativeInvite.token, name: '协作验收', password });
await expect(client(), '/api/join', 'POST', { token: collaborativeInvite.token, name: '重复接受', password }, 404);
const memberId = (await collaborator.ok('/api/me')).data.user.id;
let ownTask = (await collaborator.ok('/api/tasks', 'POST', { projectId: project.id, title: '协作任务' })).data;
await expect(collaborator, '/api/tasks/' + ownTask.id, 'PATCH', { version: ownTask.version, dueDate: '2026-11-11' }, 403);
ownTask = (await collaborator.ok('/api/tasks/' + ownTask.id, 'PATCH', { version: ownTask.version, status: 'done' })).data;
let comment = (await collaborator.ok('/api/comments', 'POST', { projectId: project.id, taskId: ownTask.id, text: '评论初稿' })).data;
comment = (await collaborator.ok('/api/comments/' + comment.id, 'PATCH', { version: comment.version, text: '编辑后的真实讨论' })).data;
await owner.ok('/api/comments/' + comment.id, 'PATCH', { version: comment.version, deleted: true });
let milestone = (await owner.ok('/api/milestones', 'POST', { projectId: project.id, title: '里程碑验收', dueDate: '2026-11-12' })).data;
let linked = (await owner.ok('/api/tasks', 'POST', { projectId: project.id, title: '关联里程碑', milestoneId: milestone.id })).data;
await expect(owner, '/api/milestones/' + milestone.id, 'PATCH', { version: milestone.version, deleted: true }, 409);
linked = (await owner.ok('/api/tasks/' + linked.id, 'PATCH', { version: linked.version, milestoneId: null })).data;
milestone = (await owner.ok('/api/milestones/' + milestone.id, 'PATCH', { version: milestone.version, status: 'done' })).data;
milestone = (await owner.ok('/api/milestones/' + milestone.id, 'PATCH', { version: milestone.version, status: 'pending' })).data; assert.ok(milestone.reopenedAt);
assert.equal((await collaborator.ok('/api/milestones/' + milestone.id + '/history')).data.length, 3);
let risk = (await collaborator.ok('/api/risks', 'POST', { projectId: project.id, title: '独立风险', description: '等待确认' })).data;
await expect(collaborator, '/api/risks/' + risk.id, 'PATCH', { version: risk.version, status: 'closed', resolution: '越权' }, 403);
risk = (await owner.ok('/api/risks/' + risk.id, 'PATCH', { version: risk.version, status: 'closed', resolution: '已确认' })).data;
await collaborator.ok('/api/updates', 'POST', { projectId: project.id, text: '真实进度更新', nextStep: '验收完成' });
const link = (await owner.ok('/api/resources', 'POST', { projectId: project.id, name: 'HTTPS资料', kind: 'link', url: 'https://example.com' })).data;
await expect(owner, '/api/resources/' + link.id, 'PATCH', { version: link.version, url: 'http://example.com' }, 400);
resource = (await owner.ok('/api/resources/' + resource.id + '/versions', 'POST', { version: resource.version, restoreVersionId: firstId, note: '实际恢复生成新版本' })).data;
assert.equal((await owner.ok('/api/files/' + resource.currentVersionId)).data.toString(), 'workerd v1 中文');
resource = (await owner.ok('/api/resources/' + resource.id, 'PATCH', { version: resource.version, deleted: true })).data;
await expect(owner, '/api/files/' + firstId, 'GET', undefined, 404);
assert.ok((await owner.ok('/api/trash')).data.some(item => item.id === resource.id));
resource = (await owner.ok('/api/trash', 'POST', { kind: 'resource', id: resource.id })).data;
await owner.ok('/api/files/' + firstId);
const exported = (await owner.ok('/api/projects/' + project.id + '/export')).data; assert.equal(exported.project.id, project.id); assert.ok(exported.versions.length >= 3);
const concurrentTask = (await owner.ok('/api/tasks', 'POST', { projectId: project.id, title: '真实D1 CAS竞争' })).data;
const competing = await Promise.all([owner.request('/api/tasks/' + concurrentTask.id, 'PATCH', { version: concurrentTask.version, status: 'doing' }), owner.request('/api/tasks/' + concurrentTask.id, 'PATCH', { version: concurrentTask.version, status: 'done' })]);
assert.deepEqual(competing.map(result => result.response.status).sort(), [200, 409]); checks += 2;
const team = (await owner.ok('/api/teams', 'POST', { name: '授权来源验收', memberIds: [memberId] })).data;
await owner.ok('/api/grants', 'POST', { projectId: project.id, subjectType: 'team', subjectId: team.id, role: 'maintainer' });
assert.equal((await collaborator.ok('/api/state')).data.projects[0].role, 'maintainer');
const changedTeam = (await owner.ok('/api/teams/' + team.id, 'PATCH', { version: team.version, name: '团队改名', memberIds: [memberId] })).data;
await owner.ok('/api/teams/' + team.id, 'PATCH', { version: changedTeam.version, deleted: true });
assert.equal((await collaborator.ok('/api/state')).data.projects[0].role, 'collaborator');
let account = (await owner.ok('/api/state')).data.members.find(member => member.id === memberId);
account = (await owner.ok('/api/members/' + memberId, 'PATCH', { version: account.version, status: 'suspended' })).data;
await expect(collaborator, '/api/state', 'GET', undefined, 401);
await owner.ok('/api/members/' + memberId, 'PATCH', { version: account.version, status: 'active' });
await collaborator.ok('/api/login', 'POST', { email: collaborativeInvite.email, password });
let lifecycle = (await owner.ok('/api/projects', 'POST', { name: '闭环只读验收', goal: '覆盖完整生命周期', lifecycle: 'active' })).data;
lifecycle = (await owner.ok('/api/projects/' + lifecycle.id, 'PATCH', { version: lifecycle.version, lifecycle: 'completed', summary: '本机隔离测试完成' })).data;
await expect(owner, '/api/tasks', 'POST', { projectId: lifecycle.id, title: '已完成不可写' }, 409);
lifecycle = (await owner.ok('/api/projects/' + lifecycle.id, 'PATCH', { version: lifecycle.version, lifecycle: 'archived' })).data;
lifecycle = (await owner.ok('/api/projects/' + lifecycle.id, 'PATCH', { version: lifecycle.version, lifecycle: 'active' })).data; assert.equal(lifecycle.lifecycle, 'completed');
lifecycle = (await owner.ok('/api/projects/' + lifecycle.id, 'PATCH', { version: lifecycle.version, lifecycle: 'active' })).data;
lifecycle = (await owner.ok('/api/projects/' + lifecycle.id, 'PATCH', { version: lifecycle.version, deleted: true })).data;
await owner.ok('/api/trash', 'POST', { kind: 'project', id: lifecycle.id });
const revoked = (await owner.ok('/api/invitations', 'POST', { email: 'revoked-' + randomBytes(8).toString('hex') + '@example.test' })).data;
await owner.ok('/api/invitations/' + revoked.id, 'DELETE'); await expect(client(), '/api/invitations?token=' + revoked.token, 'GET', undefined, 404);
assert.ok((await owner.ok('/api/invitations')).data.some(item => item.id === revoked.id && item.status === 'revoked'));
const audit = (await owner.ok('/api/audit')).data; assert.ok(audit.some(event => event.action === 'team.updated')); assert.equal(JSON.stringify(audit).includes(password), false);
await expect(owner, '/api/me', 'PATCH', { currentPassword: 'wrong', password: 'Invalid-change-' + randomBytes(12).toString('hex') }, 403);
const nextPassword = 'Changed-workerd-fixture-' + randomBytes(24).toString('hex');
await owner.ok('/api/me', 'PATCH', { currentPassword: password, password: nextPassword });
await expect(anonymous, '/api/me', 'GET', undefined, 401);
const finalLogin = client(); await finalLogin.ok('/api/login', 'POST', { email, password: nextPassword }); await finalLogin.ok('/api/logout', 'POST'); await expect(finalLogin, '/api/state', 'GET', undefined, 401);
const report = { runtime: 'real-local-workerd-http', checks, elapsedMs: Date.now() - startedAt, scryptCreateAndVerify: true, fileV1V2AndRestore: true, permissionsAndLifecycle: true, realD1ConcurrentVersionConflict: true, tenMiBBoundary: process.env.CLOUD_TEST_FILE_BOUNDARY === '1', note: '仅隔离本机夹具；未连接公开站点；未输出密码、会话或邀请原令牌' };
writeFileSync(new URL('./workerd-results.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
