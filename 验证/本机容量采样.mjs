import { createApp } from '../开发/server/index.mjs';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';

// An isolated, single-request local sample. Never starts either product port.
const output = join(dirname(fileURLToPath(import.meta.url)), '本机容量检查.json');
const compare = process.argv.includes('--compare');
if (existsSync(output) && !compare) throw new Error('结果已存在；如需保留基线并追加优化后样本，请使用 --compare。');
const existing = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : null;
const sampleDir = mkdtempSync(join(tmpdir(), 'cockpit-capacity-'));
const app = createApp({ dataDir: sampleDir, secureCookie: false });
let report;
try {
  await new Promise((ready, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', ready); });
  const port = app.server.address().port;
  assert.notEqual(port, 4173); assert.notEqual(port, 4174);
  const origin = 'http://127.0.0.1:' + port;
  const response = await fetch(origin + '/api/setup', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '容量样本所有者', email: 'capacity-owner@sample.invalid', password: randomBytes(24).toString('base64url') }) });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0], identity = await response.json();
  const timestamp = new Date().toISOString();
  const insert = app.db.prepare('INSERT INTO entities(kind,id,project_id,version,deleted_at,payload) VALUES(?,?,?,?,?,?)');
  const seed = (kind, id, projectId, payload) => insert.run(kind, id, projectId, 1, null, JSON.stringify({ ...payload, id, version: 1, createdBy: identity.user.id, createdAt: timestamp, updatedAt: timestamp, deletedAt: null }));
  app.db.exec('BEGIN IMMEDIATE');
  for (let index = 1; index <= 100; index++) {
    const projectId = 'capacity-project-' + index;
    seed('project', projectId, projectId, { name: '容量样本项目 ' + index, goal: '隔离临时数据，仅做本机单请求采样', ownerId: identity.user.id, color: 'lilac', stage: '开发', lifecycle: 'active', targetDate: '2026-12-31', startDate: '2026-10-01' });
    seed('grant', 'capacity-grant-' + index, projectId, { projectId, subjectType: 'member', subjectId: identity.user.id, role: 'maintainer' });
    for (let item = 1; item <= 50; item++) seed('task', projectId + '-task-' + item, projectId, { projectId, title: '交付任务 ' + item, description: '容量检查虚构记录，不含客户资料或真实凭据。', assigneeId: identity.user.id, status: item <= 30 ? 'done' : 'doing', priority: 'medium', dueDate: '2026-12-31', milestoneId: null, completedAt: item <= 30 ? timestamp : null });
  }
  app.db.exec('COMMIT');
  const start = performance.now();
  const stateResponse = await fetch(origin + '/api/state', { headers: { Cookie: cookie } });
  const body = Buffer.from(await stateResponse.arrayBuffer());
  const received = performance.now();
  const state = JSON.parse(body.toString('utf8'));
  const parsed = performance.now();
  assert.equal(stateResponse.status, 200); assert.equal(state.projects.length, 100); assert.equal(state.tasks.length, 5000); assert.equal(state.grants.length, 100);
  assert.ok(state.projects.every(project => project.role === 'maintainer' && project.total === 50 && project.done === 30 && project.progress === 60));
  report = { checkedAt: new Date().toISOString(), kind: '本机单次真实HTTP容量采样，非生产性能承诺', runtime: process.version, platform: process.platform, dataPreparation: '全新临时SQLite库；100项目、5000任务、100条有效直接维护授权；初始化后直接夹具事务写入', projects: 100, tasks: 5000, grants: 100, completedTasks: 3000, endpoint: 'GET /api/state', requestsMeasured: 1, status: stateResponse.status, durationUntilBodyReceivedMs: Number((received - start).toFixed(2)), jsonParseMs: Number((parsed - received).toFixed(2)), responseBytes: body.length, responseMiB: Number((body.length / 1048576).toFixed(3)), roleAndMetricsVerified: true, loopbackPort: port, formal4173AndPreview4174Untouched: true, limitations: ['一次本机回环请求，不是并发或公网压测', '完整state响应包含所有5000任务，没有据此证明分页或可承受的生产容量', '没有文件字节、团队多源授权或复杂风险样本；业务权限未绕过'] };
} finally {
  await app.close();
  const resolvedSample = resolve(sampleDir);
  if (!resolvedSample.startsWith(resolve(tmpdir()) + sep) || !basename(resolvedSample).startsWith('cockpit-capacity-')) throw new Error('临时库清理路径不匹配');
  rmSync(resolvedSample, { recursive: true, force: true });
  if (report) report.tempDatabaseRemoved = !existsSync(resolvedSample);
}
const result = compare && existing ? { kind: '同协议优化前后本机单次样本对比，非生产性能承诺', beforeOptimization: existing.beforeOptimization || existing, afterOptimization: report } : report;
writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
