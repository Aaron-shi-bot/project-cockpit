import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupDatabase } from '../开发/server/backup.mjs';
import { createApp } from '../开发/server/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sourceDir = resolve(process.argv[2] || join(here, '运行数据-final'));
const ownerEmail = process.argv[3] || process.env.QA_RESTORE_EMAIL;
const ownerPassword = process.env.QA_RESTORE_PASSWORD;
if (!ownerEmail || !ownerPassword) throw new Error('需要提供账号参数及QA_RESTORE_PASSWORD环境变量；密码不写入结果文件。');
const sourceFile = join(sourceDir, 'cockpit.sqlite');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function businessSnapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('BEGIN');
    const hasTimeZone = db.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'time_zone');
    const users = db.prepare(`SELECT id,name,email,password_hash,workspace_role,status,version,${hasTimeZone ? 'time_zone' : "'Asia/Shanghai' AS time_zone"} FROM users ORDER BY id`).all();
    const entities = db.prepare('SELECT kind,id,project_id,version,deleted_at,payload FROM entities ORDER BY id').all();
    const files = db.prepare('SELECT id,content FROM file_bytes ORDER BY id').all().map(row => ({ id: row.id, size: row.content.length, sha256: sha256(row.content) }));
    db.exec('COMMIT');
    const fingerprint = sha256(JSON.stringify({ users, entities, files }));
    return { users, entities: entities.map(row => ({ ...JSON.parse(row.payload), kind: row.kind, deletedAt: row.deleted_at })), files, fingerprint };
  } finally { db.close(); }
}
function roleFor(user, projectId, baseline) {
  if (user.status !== 'active') return null;
  const rank = { viewer: 1, collaborator: 2, maintainer: 3 };
  const teams = baseline.entities.filter(item => item.kind === 'team' && !item.deletedAt && item.memberIds.includes(user.id)).map(item => item.id);
  const grants = baseline.entities.filter(item => item.kind === 'grant' && !item.deletedAt && item.projectId === projectId && (item.subjectType === 'member' && item.subjectId === user.id || item.subjectType === 'team' && teams.includes(item.subjectId)));
  return grants.sort((a, b) => rank[b.role] - rank[a.role])[0]?.role ?? null;
}

const scratch = mkdtempSync(join(tmpdir(), 'cockpit-restore-drill-'));
let app;
const result = { executedAt: new Date().toISOString(), sourceDir, mode: 'live VACUUM INTO; isolated copy; real HTTP verification', checks: {}, files: [] };
try {
  // The browser may still append business data. Retry until the source business
  // projection is stable across the snapshot; sessions/audit writes are ignored.
  let baseline, backupFile;
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = businessSnapshot(sourceFile);
    backupFile = join(scratch, `snapshot-${attempt}.sqlite`);
    backupDatabase(sourceFile, backupFile);
    const copied = businessSnapshot(backupFile);
    const after = businessSnapshot(sourceFile);
    if (before.fingerprint === after.fingerprint && after.fingerprint === copied.fingerprint) { baseline = copied; result.snapshotAttempts = attempt + 1; break; }
  }
  assert.ok(baseline, '源业务连续变化，尚未取得可对照快照，请浏览器提交完成后重试');
  const restoredDir = join(scratch, 'restored');
  mkdirSync(restoredDir);
  copyFileSync(backupFile, join(restoredDir, 'cockpit.sqlite'));
  const restored = businessSnapshot(join(restoredDir, 'cockpit.sqlite'));
  assert.equal(restored.fingerprint, baseline.fingerprint);
  result.checks.accountRolesEntitiesAndFileHashesIdentical = true;
  result.businessFingerprint = baseline.fingerprint;
  app = createApp({ dataDir: restoredDir, onError: error => { throw error; } });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(origin + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ email: ownerEmail, password: ownerPassword }) });
  assert.equal(login.status, 200, '恢复库应能以原所有者密码通过HTTP登录');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const identity = await login.json();
  const originalUser = baseline.users.find(user => user.email === ownerEmail);
  assert.ok(originalUser);
  assert.equal(identity.user.id, originalUser.id);
  assert.equal(identity.user.workspaceRole, originalUser.workspace_role);
  assert.equal(identity.user.status, originalUser.status);
  assert.equal(identity.user.timeZone, originalUser.time_zone);
  result.checks.originalPasswordAndOwnerHttpLogin = true;
  const response = await fetch(origin + '/api/state', { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const state = await response.json();
  const expectedProjects = baseline.entities.filter(item => item.kind === 'project' && !item.deletedAt && roleFor(originalUser, item.id, baseline));
  assert.deepEqual(state.projects.map(p => [p.id, p.name, p.goal, p.role]).sort(), expectedProjects.map(p => [p.id, p.name, p.goal, roleFor(originalUser, p.id, baseline)]).sort());
  const projectIds = new Set(expectedProjects.map(project => project.id));
  const expectedGrants = baseline.entities.filter(item => item.kind === 'grant' && !item.deletedAt && projectIds.has(item.projectId));
  const grantFields = grant => [grant.id, grant.projectId, grant.subjectType, grant.subjectId, grant.role];
  assert.deepEqual(state.grants.map(grantFields).sort(), expectedGrants.map(grantFields).sort());
  result.checks.projectVisibilityAndOriginalGrantSources = true;
  assert.equal(state.members.length, baseline.users.length);
  for (const member of state.members) assert.equal(member.timeZone, baseline.users.find(user => user.id === member.id).time_zone);
  result.checks.originalAccountTimeZonesPreserved = true;
  result.accounts = baseline.users.map(user => ({ email: user.email, workspaceRole: user.workspace_role, status: user.status, timeZone: user.time_zone }));
  result.projects = state.projects.length;
  result.tasks = state.tasks.length;
  result.grants = state.grants.length;
  const pairResource = state.resources.find(resource => state.versions.some(v => v.resourceId === resource.id && v.number === 1) && state.versions.some(v => v.resourceId === resource.id && v.number === 2));
  assert.ok(pairResource, '源数据应包含同一资料的v1和v2，才可完成版本恢复演练');
  assert.ok(state.versions.length >= 2);
  for (const version of state.versions) {
    const expected = baseline.files.find(file => file.id === version.id);
    assert.ok(expected);
    const downloaded = await fetch(origin + '/api/files/' + version.id, { headers: { Cookie: cookie } });
    assert.equal(downloaded.status, 200);
    const bytes = Buffer.from(await downloaded.arrayBuffer());
    assert.equal(bytes.length, expected.size);
    assert.equal(sha256(bytes), expected.sha256);
    const anonymous = await fetch(origin + '/api/files/' + version.id);
    assert.equal(anonymous.status, 401);
    result.files.push({ versionId: version.id, resourceId: version.resourceId, versionNumber: version.number, fileName: version.fileName, size: bytes.length, sha256: expected.sha256, authenticatedDownload: 200, anonymousDownload: 401 });
  }
  const pair = result.files.filter(file => file.resourceId === pairResource.id && [1, 2].includes(file.versionNumber));
  assert.equal(pair.length, 2);
  assert.notEqual(pair[0].sha256, pair[1].sha256, 'v1/v2实际内容应有差别');
  result.checks.realV1V2BytesAndHistoricalDownloads = true;
  result.checks.anonymousHistoricalFileAccessDenied = true;
  assert.equal(businessSnapshot(sourceFile).fingerprint, baseline.fingerprint, '演练期间源业务数据不能被改变');
  result.checks.sourceBusinessUnchanged = true;
  result.passed = true;
} catch (error) {
  result.passed = false;
  result.error = error.message;
  process.exitCode = 1;
} finally {
  if (app) await app.close();
  // Delete only the exact directory returned by mkdtemp, under the OS temp root.
  const tempRoot = resolve(tmpdir());
  if (!resolve(scratch).startsWith(tempRoot + sep) || !scratch.includes('cockpit-restore-drill-')) throw new Error('拒绝清理不在预期临时根内的路径');
  rmSync(scratch, { recursive: true, force: true });
  result.isolatedRestoreDirectoryRemoved = true;
  writeFileSync(join(here, '备份恢复检查.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
