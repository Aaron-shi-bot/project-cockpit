import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Real stop/start persistence exercise; credentials exist only in this runner's
// memory. Never connects to a public URL or touches the normal 4173/4174 data.
const root = fileURLToPath(new URL('../../', import.meta.url));
const configuration = JSON.parse(readFileSync(resolve(root, '.sites-runtime/workerd-test.json'), 'utf8'));
assert.equal(configuration.dev.ip, '127.0.0.1'); assert.equal(configuration.dev.port, 4181);
assert.equal(configuration.vars.LOCAL_WORKER_TEST, '1');
const config = '.sites-runtime/workerd-test.json';
const persist = '.sites-runtime/workerd-test-state/restart-' + randomBytes(6).toString('hex');
const origin = 'http://127.0.0.1:4181';
const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
const digest = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let processHandle, stopped = false, runtimeLog = '', checks = 0;
const startedAt = Date.now();
function sanitize(value) { return String(value).split(/\r?\n/).map(line => /BOOTSTRAP_TOKEN|token=/i.test(line) ? '[credential line omitted]' : line).join('\n'); }
function client() {
  let cookie = '', csrf = '';
  return {
    async req(path, method = 'GET', body, extra = {}) {
      const response = await fetch(origin + path, { method, headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf, ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
      const newCookie = response.headers.get('set-cookie'); if (newCookie) cookie = newCookie.split(';')[0];
      const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
      if (data?.csrfToken) csrf = data.csrfToken;
      return { status: response.status, data };
    },
    async ok(path, method = 'GET', body, extra) { const result = await this.req(path, method, body, extra); assert.equal(result.status, 200, `${method} ${path}: ${JSON.stringify(result.data)}`); checks++; return result.data; },
  };
}
async function start() {
  processHandle = spawn(process.execPath, [wrangler, 'dev', '--config', config, '--local', '--persist-to', persist, '--ip', '127.0.0.1', '--port', '4181', '--inspector-port', '0'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  for (const stream of [processHandle.stdout, processHandle.stderr]) stream.on('data', data => { runtimeLog = (runtimeLog + sanitize(data)).slice(-18000); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (processHandle.exitCode != null) throw new Error('Isolated workerd exited: ' + runtimeLog);
    try { const response = await fetch(origin + '/api/bootstrap', { signal: AbortSignal.timeout(500) }); if (response.status === 200) { checks++; return; } } catch {}
    await delay(150);
  }
  throw new Error('Isolated workerd did not become ready: ' + runtimeLog);
}
async function stop() {
  if (processHandle && processHandle.exitCode == null) {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(processHandle.pid), '/T', '/F'], { windowsHide: true, stdio: 'pipe' });
    else processHandle.kill('SIGTERM');
    for (let attempt = 0; processHandle.exitCode == null && attempt < 50; attempt++) await delay(100);
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await fetch(origin + '/api/bootstrap', { signal: AbortSignal.timeout(500) }); } catch { checks++; stopped = true; return; }
    await delay(100);
  }
  throw new Error('4181 still responds after stopping isolated process tree');
}
try {
  // Config and migration must already exist; this applies only the committed
  // static migration to this new test-local persistence directory.
  execFileSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'DB', '--config', config, '--local', '--persist-to', persist], { cwd: root, windowsHide: true, stdio: 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  await start();
  const owner = client(), member = client();
  const ownerEmail = 'restart-owner-' + randomBytes(8).toString('hex') + '@example.test';
  const memberEmail = 'restart-member-' + randomBytes(8).toString('hex') + '@example.test';
  const ownerPassword = 'Owner-restart-' + randomBytes(24).toString('hex');
  const memberPassword = 'Member-restart-' + randomBytes(24).toString('hex');
  await owner.ok('/api/setup', 'POST', { name: '停启所有者', email: ownerEmail, password: ownerPassword }, { 'X-Bootstrap-Token': configuration.vars.BOOTSTRAP_TOKEN });
  await owner.ok('/api/me', 'PATCH', { timeZone: 'America/New_York' });
  const project = await owner.ok('/api/projects', 'POST', { name: '停启持久化项目', goal: '比对真实记录与授权' });
  const task = await owner.ok('/api/tasks', 'POST', { projectId: project.id, title: '原任务记录', status: 'doing', dueDate: '2026-11-02' });
  const invitation = await owner.ok('/api/invitations', 'POST', { email: memberEmail, projectId: project.id, projectRole: 'viewer' });
  await member.ok('/api/join', 'POST', { token: invitation.token, name: '停启成员', password: memberPassword });
  const memberId = (await member.ok('/api/me')).user.id;
  const hidden = await member.ok('/api/projects', 'POST', { name: '成员独有项目', goal: '工作区owner也不隐式读取' });
  const team = await owner.ok('/api/teams', 'POST', { name: '停启团队', memberIds: [memberId] });
  await owner.ok('/api/grants', 'POST', { projectId: project.id, subjectType: 'team', subjectId: team.id, role: 'collaborator' });
  const file = bytes => ({ name: '停启真实资料.txt', mime: 'text/plain', base64: Buffer.from(bytes).toString('base64') });
  const v1 = Buffer.from('停启前创建的第一版真实字节\n'); const v2 = Buffer.from('停启前创建的第二版真实字节\n包含修订\n');
  let resource = await owner.ok('/api/resources', 'POST', { projectId: project.id, kind: 'file', file: file(v1) }); const firstId = resource.currentVersionId;
  resource = await owner.ok('/api/resources/' + resource.id + '/versions', 'POST', { version: resource.version, file: file(v2) }); const secondId = resource.currentVersionId;
  const summary = state => ({ user: { id: state.user.id, role: state.user.workspaceRole, zone: state.user.timeZone }, projects: state.projects.map(p => ({ id: p.id, role: p.role, total: p.total, done: p.done, progress: p.progress })).sort((a,b)=>a.id.localeCompare(b.id)), tasks: state.tasks.map(t=>({id:t.id,version:t.version,status:t.status,dueDate:t.dueDate})), grants: state.grants.map(g=>({id:g.id,role:g.role,subjectId:g.subjectId,subjectType:g.subjectType})).sort((a,b)=>a.id.localeCompare(b.id)), versions: state.versions.map(v=>({id:v.id,number:v.number,size:v.size})).sort((a,b)=>a.number-b.number) });
  const ownerBefore = summary(await owner.ok('/api/state')), memberBefore = summary(await member.ok('/api/state'));
  assert.equal(ownerBefore.projects.some(p=>p.id===hidden.id),false); assert.equal(memberBefore.projects.find(p=>p.id===project.id).role,'collaborator');
  assert.equal(digest(await owner.ok('/api/files/'+firstId)),digest(v1)); assert.equal(digest(await owner.ok('/api/files/'+secondId)),digest(v2));
  await stop(); stopped = false; await start();
  // Existing HttpOnly sessions survive, then independent fresh clients prove
  // the same password digests/account records survived as well.
  assert.equal((await owner.ok('/api/me')).user.timeZone,'America/New_York');
  const ownerAfter = client(), memberAfter = client();
  await ownerAfter.ok('/api/login','POST',{email:ownerEmail,password:ownerPassword}); await memberAfter.ok('/api/login','POST',{email:memberEmail,password:memberPassword});
  assert.deepEqual(summary(await ownerAfter.ok('/api/state')),ownerBefore); assert.deepEqual(summary(await memberAfter.ok('/api/state')),memberBefore);
  assert.equal((await ownerAfter.req('/api/projects/'+hidden.id+'/export')).status,404); checks++;
  for (const reader of [ownerAfter,memberAfter]) { assert.equal(digest(await reader.ok('/api/files/'+firstId)),digest(v1)); assert.equal(digest(await reader.ok('/api/files/'+secondId)),digest(v2)); }
  const restoredTask=(await ownerAfter.ok('/api/state')).tasks.find(t=>t.id===task.id); assert.equal(restoredTask.status,'doing'); assert.equal(restoredTask.dueDate,'2026-11-02');
  await stop();
  const report = { runtime:'real-local-workerd-stop-start', checks, elapsedMs:Date.now()-startedAt, samePersistenceDirectory:true, accountPasswordAndTimeZone:true, originalSessionSurvived:true, exactProjectTaskGrantVersions:true, workspaceOwnerCannotReadHiddenProject:true, directAndTeamHighestRole:true, fileV1:{size:v1.length,sha256:digest(v1)},fileV2:{size:v2.length,sha256:digest(v2)},final4181Stopped:stopped, note:'仅本机独立夹具；密码始终只在runner内存；验证停启持久化，不是D1+R2备份恢复'};
  writeFileSync(new URL('./workerd-restart-results.json',import.meta.url),JSON.stringify(report,null,2)+'\n'); console.log(JSON.stringify(report,null,2));
} finally { if (!stopped) await stop().catch(error=>{console.error(error.message);process.exitCode=1;}); }
