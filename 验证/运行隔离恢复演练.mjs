import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../开发/server/index.mjs';

// Rebuild the source fixture from scratch on a random local port. Neither
// product data directory/port is read or changed, and no password is persisted.
const here = dirname(fileURLToPath(import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'cockpit-timezone-restore-source-'));
const email = 'timezone-restore-owner@example.test';
const password = 'Restore-fixture-' + randomBytes(24).toString('base64url');
const app = createApp({ dataDir: directory, secureCookie: false });
const resultPath = join(here, '备份恢复检查.json');
let result;
try {
  await new Promise((ready, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', ready); });
  const port = app.server.address().port;
  assert.notEqual(port, 4173); assert.notEqual(port, 4174);
  const origin = 'http://127.0.0.1:' + port;
  function client() {
    let cookie = '', csrf = '';
    return async (path, method = 'GET', body) => {
      const response = await fetch(origin + '/api' + path, { method, headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const data = await response.json(); assert.equal(response.status, 200, `${path}: ${data.error || response.status}`);
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      if (data.csrfToken) csrf = data.csrfToken;
      return data;
    };
  }
  const owner = client();
  await owner('/setup', 'POST', { name: '独立恢复时区夹具', email, password });
  const me = await owner('/me', 'PATCH', { timeZone: 'America/New_York' }); assert.equal(me.user.timeZone, 'America/New_York');
  const project = await owner('/projects', 'POST', { name: '隔离恢复与历史资料', goal: '核对非默认时区、角色、多源授权和真实文件字节' });
  const invitation = await owner('/invitations', 'POST', { name: '授权对照成员', email: 'timezone-restore-member@example.test', projectId: project.id, projectRole: 'viewer' });
  const member = client();
  const joined = await member('/join', 'POST', { token: invitation.token, name: '授权对照成员', password: randomBytes(24).toString('base64url') });
  const team = await owner('/teams', 'POST', { name: '恢复演练团队', memberIds: [joined.user.id] });
  await owner('/grants', 'POST', { projectId: project.id, subjectType: 'team', subjectId: team.id, role: 'collaborator' });
  assert.equal((await member('/state')).projects[0].role, 'collaborator');
  const hidden = await member('/projects', 'POST', { name: '所有者无权的夹具项目', goal: '恢复后不得因为工作区所有者身份隐含读取' });
  assert.equal((await owner('/state')).projects.some(item => item.id === hidden.id), false);
  const file = content => ({ name: '恢复验证.md', mime: 'text/markdown', base64: Buffer.from(content).toString('base64') });
  let resource = await owner('/resources', 'POST', { projectId: project.id, name: '恢复验证.md', kind: 'file', file: file('# 恢复演练v1\n\n这是第一个真实版本。\n') });
  resource = await owner(`/resources/${resource.id}/versions`, 'POST', { version: resource.version, note: '第二版内容不同', file: file('# 恢复演练v2\n\n第二版增加：时区为America/New_York，历史版本不得覆盖。\n') });
  assert.equal((await owner('/state')).versions.length, 2);

  const child = spawn(process.execPath, [join(here, 'backup-restore.mjs'), directory, email], { env: { ...process.env, QA_RESTORE_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '', diagnostics = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { diagnostics += chunk; });
  const exitCode = await new Promise((ready, reject) => { child.once('error', reject); child.once('close', ready); });
  assert.equal(exitCode, 0, output + diagnostics);
  result = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.equal(result.passed, true);
  assert.equal(result.checks.originalAccountTimeZonesPreserved, true);
  assert.equal(result.accounts.find(account => account.email === email).timeZone, 'America/New_York');
  assert.equal(result.checks.projectVisibilityAndOriginalGrantSources, true);
  assert.equal(result.files.length, 2);
  assert.equal(result.grants, 3);
  result.sourceFixture = { kind: '本次新建隔离夹具', loopbackPort: port, knownPasswordHeldOnlyInProcess: true, timeZone: 'America/New_York', accountCount: 2, totalProjectCount: 2, ownerVisibleProjectCount: 1, effectiveMemberRoleBeforeBackup: 'collaborator', sameResourceVersions: [1, 2], formal4173AndPreview4174Untouched: true };
} finally {
  await app.close();
  const target = resolve(directory);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('cockpit-timezone-restore-source-')) throw new Error('拒绝清理非预期临时夹具目录');
  rmSync(target, { recursive: true, force: true });
  if (result) {
    result.sourceFixtureRemoved = true;
    writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  }
}
