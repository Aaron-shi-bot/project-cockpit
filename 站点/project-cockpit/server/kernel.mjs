import { Buffer } from 'node:buffer';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { inspectFileType } from './file-types.mjs';

const ranks = { viewer: 1, collaborator: 2, maintainer: 3 };
const colors = ['lilac', 'blush', 'mint', 'sky', 'butter', 'neutral'];
const now = () => new Date().toISOString();
const id = () => randomBytes(12).toString('hex');
const hash = value => createHash('sha256').update(value).digest('hex');
const publicUser = row => row && ({ id: row.id, name: row.name, email: row.email, workspaceRole: row.workspace_role, status: row.status, version: row.version, timeZone: row.time_zone || 'Asia/Shanghai' });
const fail = (status, error, code = 'INVALID_REQUEST', details) => { throw Object.assign(new Error(error), { status, code, details }); };
function text(value, label, max = 5000, required = false) {
  if (value == null) { if (required) fail(400, `${label}不能为空`); return ''; }
  if (typeof value !== 'string' || value.length > max) fail(400, `${label}格式或长度不正确`);
  const result = value.trim(); if (required && !result) fail(400, `${label}不能为空`); return result;
}
function choice(value, allowed, fallback) { const result = value ?? fallback; if (!allowed.includes(result)) fail(400, '选项不正确'); return result; }
function date(value) { if (!value) return ''; const parsed = new Date(value); if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail(400, '日期格式不正确'); return value; }
function email(value) { const result = text(value, '邮箱', 254, true).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) fail(400, '请输入有效邮箱'); return result; }
function password(value) { if (typeof value !== 'string' || value.length < 10 || value.length > 256) fail(400, '密码需要10至256个字符'); return value; }
function passwordHash(value) { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password(value), salt, 64).toString('hex')}`; }
function passwordMatches(value, stored) { if (typeof value !== 'string' || value.length > 256 || !stored) return false; const [salt, digest] = stored.split(':'); const actual = scryptSync(value, salt, 64); const expected = Buffer.from(digest, 'hex'); return expected.length === actual.length && timingSafeEqual(actual, expected); }
function fields(body, allowed) { for (const key of Object.keys(body)) if (!allowed.includes(key) && !['version', 'operationId'].includes(key)) fail(400, `不能写入字段：${key}`); }
function changes(before, after, keys) { const pick = item => Object.fromEntries(keys.map(key => [key, item?.[key] ?? null])); return { before: pick(before), after: pick(after) }; }
function timeZone(value) { const zone = text(value, '时区', 100, true); if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(zone)) fail(400, '请选择有效的IANA时区', 'INVALID_TIME_ZONE'); try { return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone; } catch { fail(400, '请选择有效的IANA时区', 'INVALID_TIME_ZONE'); } }

export function createKernel(db, options = {}) {
  const maxFileBytes = options.maxFileBytes ?? 10 * 1024 * 1024;
  const sessionHours = 8;
  const publicOrigin = options.publicOrigin;
  const secureCookie = true;
  const getUser = uid => typeof uid === 'string' ? db.prepare('SELECT * FROM users WHERE id=?').get(uid) : null;
  const users = () => db.prepare('SELECT * FROM users ORDER BY name').all();
  const parse = row => row && ({ ...JSON.parse(row.payload), id: row.id, version: row.version, deletedAt: row.deleted_at });
  const get = (kind, eid, includeDeleted = false) => { if (typeof eid !== 'string') return null; const row = db.prepare('SELECT * FROM entities WHERE kind=? AND id=?').get(kind, eid); if (!row || (!includeDeleted && row.deleted_at)) return null; return parse(row); };
  const all = (kind, includeDeleted = false) => db.prepare(`SELECT * FROM entities WHERE kind=? ${includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY rowid`).all(kind).map(parse);
  function save(kind, item, actor, existing = null) {
    const result = { ...item, id: existing?.id ?? item.id ?? id(), version: (existing?.version ?? 0) + 1, createdBy: existing?.createdBy ?? actor.id, createdAt: existing?.createdAt ?? now(), updatedAt: now(), deletedAt: item.deletedAt ?? null };
    db.prepare('INSERT INTO entities(kind,id,project_id,version,deleted_at,payload) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,version=excluded.version,deleted_at=excluded.deleted_at,payload=excluded.payload').run(kind, result.id, kind === 'project' ? result.id : (result.projectId ?? null), result.version, result.deletedAt, JSON.stringify(result)); return result;
  }
  function audit(actor, action, kind = null, objectId = null, projectId = null, details = {}) { db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run(id(), projectId, actor?.id ?? 'anonymous', action, kind, objectId, now(), JSON.stringify(details)); }
  function conflict(item, body) { if (!Number.isInteger(body.version) || body.version !== item.version) fail(409, '内容已被更新，请重新加载后保存', 'VERSION_CONFLICT', { currentVersion: item.version }); }
  const admin = actor => ['owner', 'admin'].includes(actor.workspace_role);
  function requireAdmin(actor) { if (!admin(actor)) fail(403, '需要工作区管理权限', 'FORBIDDEN'); }
  function role(actor, projectId) {
    if (!actor || actor.status !== 'active') return null;
    const teamIds = new Set(all('team').filter(t => t.memberIds.includes(actor.id)).map(t => t.id));
    let result = null;
    for (const grant of all('grant')) if (grant.projectId === projectId && ((grant.subjectType === 'member' && grant.subjectId === actor.id) || (grant.subjectType === 'team' && teamIds.has(grant.subjectId)))) if ((ranks[grant.role] ?? 0) > (ranks[result] ?? 0)) result = grant.role;
    return result;
  }
  function requireProject(actor, projectId, min = 'viewer', writable = false, includeDeleted = false) {
    const project = get('project', projectId, includeDeleted); const actual = role(actor, projectId);
    if (!project || !actual) fail(404, '内容不存在或无权访问', 'NOT_FOUND');
    if (ranks[actual] < ranks[min]) fail(403, '项目权限不足', 'FORBIDDEN');
    if (writable && ['archived', 'completed'].includes(project.lifecycle)) fail(409, '已归档或完成的项目需先重新打开', 'PROJECT_READONLY');
    return project;
  }
  function maintainerCount(projectId) { return users().filter(u => u.status === 'active' && role(u, projectId) === 'maintainer').length; }
  function protectMaintainers(projectIds) { for (const pid of projectIds) { const project = get('project', pid); if (!project) continue; if (!maintainerCount(pid)) fail(409, '不能移除最后一名有效项目维护者，请先交接', 'LAST_MAINTAINER'); const owner = getUser(project.ownerId); if (owner?.status === 'active' && role(owner, pid) !== 'maintainer') fail(409, '请先交接项目负责人，再撤销其维护权限', 'OWNER_HANDOFF_REQUIRED'); } }
  function assignee(actorId, projectId) { if (!actorId) return null; const user = getUser(actorId); if (!user || user.status !== 'active' || ranks[role(user, projectId)] < 2 || !role(user, projectId)) fail(400, '负责人必须是有效的项目协作成员或维护者'); return actorId; }
  function projectView(project, actor) { const tasks = all('task').filter(t => t.projectId === project.id && t.status !== 'cancelled'); const done = tasks.filter(t => t.status === 'done').length; const risks = all('risk').filter(r => r.projectId === project.id && r.status === 'open'); return { ...project, role: role(actor, project.id), total: tasks.length, done, progress: tasks.length ? Math.floor(done * 100 / tasks.length) : null, health: risks.some(r => r.level === 'blocked') ? 'blocked' : risks.length ? 'risk' : 'normal' }; }
  function auth(req) { const cookies = (req.headers.cookie ?? '').split(';').map(s => s.trim()); const raw = cookies.find(s => s.startsWith('cockpit_session='))?.slice(16); if (!raw || raw.length > 256) return null; const session = db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires>?').get(hash(raw), Date.now()); if (!session) return null; const actor = getUser(session.user_id); return actor?.status === 'active' ? { actor, session } : null; }
  function session(res, actor) { const raw = randomBytes(32).toString('hex'); const csrfToken = randomBytes(24).toString('hex'); db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(raw), actor.id, csrfToken, Date.now() + sessionHours * 3600000); res.setHeader('Set-Cookie', `cockpit_session=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionHours * 3600}${secureCookie ? '; Secure' : ''}`); return { user: publicUser(actor), csrfToken }; }
  function checkOrigin(req) { const origin = req.headers.origin; if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, '不接受跨站写入', 'ORIGIN_REJECTED'); if (origin && origin !== publicOrigin && origin !== `${secureCookie ? 'https' : 'http'}://${req.headers.host}`) fail(403, '请求来源不正确', 'ORIGIN_REJECTED'); }
  async function bodyOf(req) { let size = 0; const buffers = []; for await (const chunk of req) { size += chunk.length; if (size > maxFileBytes * 1.4 + 262144) fail(413, '请求超过允许大小', 'TOO_LARGE'); buffers.push(chunk); } if (!size) return {}; if (!req.headers['content-type']?.startsWith('application/json')) fail(415, '请使用JSON请求'); try { const b = JSON.parse(Buffer.concat(buffers).toString()); if (!b || typeof b !== 'object' || Array.isArray(b)) fail(400, 'JSON对象格式不正确'); return b; } catch (error) { if (error.status) throw error; fail(400, 'JSON格式不正确'); } }
  async function putFile(resource, file, actor, note = '', restoreVersionId = null) {
    let bytes, fileName, mime;
    if (restoreVersionId) { const old = get('version', restoreVersionId); if (!old || old.resourceId !== resource.id) fail(400, '恢复版本不存在或不属于该资料'); bytes = await db.readFile(old.id); fileName = old.fileName; mime = old.mime; }
    else {
      if (!file || typeof file.base64 !== 'string') fail(400, '文件编码不正确');
      const encoded = file.base64;
      // Bound allocation before decoding. Avoid repeated capture groups: valid
      // multi-megabyte input can exhaust the regexp stack even without attacks.
      if (encoded.length > Math.ceil(maxFileBytes / 3) * 4) fail(413, '文件超过上传上限', 'TOO_LARGE');
      if (encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded)) fail(400, '文件编码不正确');
      bytes = Buffer.from(encoded, 'base64');
      if (bytes.length > maxFileBytes) fail(413, '文件超过上传上限', 'TOO_LARGE');
      // Buffer decoding is deliberately permissive; a round-trip rejects
      // misplaced padding, nonzero padding bits and truncated encodings.
      if (bytes.toString('base64') !== encoded) fail(400, '文件编码不正确');
      fileName = text(file.name, '文件名', 200, true).replace(/[\\/\r\n]/g, '_');
      mime = text(file.mime || 'application/octet-stream', '文件类型', 100);
      if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime)) fail(400, '文件类型不正确');
    }
    if (!bytes || bytes.length > maxFileBytes) fail(413, '文件超过上传上限', 'TOO_LARGE');
    const inspected = inspectFileType(Buffer.from(bytes), mime);
    if (!inspected.compatible) fail(400, '文件实际类型与声明类型不符，请检查文件后重试', 'FILE_TYPE_MISMATCH', { detectedMime: inspected.detectedMime });
    const version = save('version', { resourceId: resource.id, projectId: resource.projectId, number: all('version').filter(v => v.resourceId === resource.id).length + 1, fileName, mime, detectedMime: inspected.detectedMime, detectedType: inspected.detectedType, typeVerified: inspected.typeVerified, size: bytes.length, note: text(note, '版本说明', 1000), restoredFrom: restoreVersionId }, actor);
    db.stageFile(version.id, bytes); return version;
  }
  const auditView = row => ({ id: row.id, projectId: row.project_id, actorId: row.actor_id, action: row.action, kind: row.kind, objectId: row.object_id, createdAt: row.created_at, details: JSON.parse(row.details) });
  function auditList(actor) { return db.prepare('SELECT * FROM audit ORDER BY created_at DESC,rowid DESC').all().filter(row => row.project_id ? role(actor, row.project_id) === 'maintainer' : admin(actor)).slice(0, 500).map(auditView); }
  function authFailure(req) { const key = hash(`auth-ip|${req.socket.remoteAddress}`); const attempt = db.prepare('SELECT * FROM login_attempts WHERE key=?').get(key); db.prepare('INSERT INTO login_attempts VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET failures=excluded.failures,reset_at=excluded.reset_at').run(key, attempt && attempt.reset_at > Date.now() ? attempt.failures + 1 : 1, attempt && attempt.reset_at > Date.now() ? attempt.reset_at : Date.now() + 900000); }
  function invitations(actor, resolveRole = projectId => role(actor, projectId)) { if (!admin(actor)) return []; return db.prepare('SELECT * FROM invitations ORDER BY rowid DESC').all().map(row => ({ row, info: JSON.parse(row.payload) })).filter(({ info }) => actor.workspace_role === 'owner' || info.workspaceRole === 'member').map(({ row, info }) => ({ id: row.id, email: row.email, name: info.name, workspaceRole: info.workspaceRole, projectId: info.projectId && resolveRole(info.projectId) ? info.projectId : null, projectRole: info.projectId && resolveRole(info.projectId) ? info.projectRole : null, expiresAt: new Date(row.expires).toISOString(), status: row.revoked ? 'revoked' : row.used ? 'accepted' : row.expires < Date.now() ? 'expired' : 'pending', inviterId: info.inviterId })); }
  function state(actor, csrfToken) {
    // Request-local snapshot only: every entity is read/parsed once. There is
    // no cross-request cache; the next request recomputes current permissions.
    const collections = new Map();
    for (const row of db.prepare('SELECT * FROM entities WHERE deleted_at IS NULL ORDER BY rowid').all()) {
      if (!collections.has(row.kind)) collections.set(row.kind, []);
      collections.get(row.kind).push(parse(row));
    }
    const collection = kind => collections.get(kind) ?? [];
    const teams = collection('team');
    const memberRows = users();
    const teamIds = new Set(teams.filter(team => team.memberIds.includes(actor.id)).map(team => team.id));
    const roles = new Map();
    if (actor.status === 'active') for (const grant of collection('grant')) {
      if (!(grant.subjectType === 'member' && grant.subjectId === actor.id) && !(grant.subjectType === 'team' && teamIds.has(grant.subjectId))) continue;
      if ((ranks[grant.role] ?? 0) > (ranks[roles.get(grant.projectId)] ?? 0)) roles.set(grant.projectId, grant.role);
    }
    const projectRows = collection('project').filter(project => roles.has(project.id));
    const projectIds = new Set(projectRows.map(project => project.id));
    const visible = kind => collection(kind).filter(item => projectIds.has(item.projectId));
    const tasks = visible('task'), risks = visible('risk');
    const counts = new Map();
    for (const task of tasks) {
      if (task.status === 'cancelled') continue;
      const count = counts.get(task.projectId) ?? { total: 0, done: 0 };
      count.total++; if (task.status === 'done') count.done++;
      counts.set(task.projectId, count);
    }
    const health = new Map();
    for (const risk of risks) if (risk.status === 'open') {
      if (risk.level === 'blocked') health.set(risk.projectId, 'blocked');
      else if (!health.has(risk.projectId)) health.set(risk.projectId, 'risk');
    }
    const projects = projectRows.map(project => {
      const { total, done } = counts.get(project.id) ?? { total: 0, done: 0 };
      return { ...project, role: roles.get(project.id), total, done, progress: total ? Math.floor(done * 100 / total) : null, health: health.get(project.id) ?? 'normal' };
    });
    const resources = visible('resource'), resourceIds = new Set(resources.map(resource => resource.id));
    const taskIds = new Set(collection('task').map(task => task.id));
    const audit = db.prepare('SELECT * FROM audit ORDER BY created_at DESC,rowid DESC').all().filter(row => row.project_id ? roles.get(row.project_id) === 'maintainer' : admin(actor)).slice(0, 500).map(auditView);
    return { user: publicUser(actor), csrfToken, projects, tasks, milestones: visible('milestone'), risks, updates: visible('update'), comments: visible('comment').filter(comment => taskIds.has(comment.taskId)), resources, versions: visible('version').filter(version => resourceIds.has(version.resourceId)), members: memberRows.map(member => admin(actor) || member.id === actor.id ? publicUser(member) : ({ id: member.id, name: member.name, status: member.status })), teams, grants: visible('grant'), audit, invitations: invitations(actor, projectId => roles.get(projectId)) };
  }
  function previewInvitation(token) { if (typeof token !== 'string' || token.length > 200) fail(404, '邀请无效或已过期', 'INVALID_INVITATION'); const row = db.prepare('SELECT * FROM invitations WHERE token_hash=?').get(hash(token)); if (!row || row.used || row.revoked || row.expires < Date.now()) fail(404, '邀请无效或已过期', 'INVALID_INVITATION'); const info = JSON.parse(row.payload); const inviter = getUser(info.inviterId); if (!inviter || inviter.status !== 'active' || !admin(inviter) || (info.workspaceRole === 'admin' && inviter.workspace_role !== 'owner')) fail(404, '邀请人已无授权能力', 'INVALID_INVITATION'); if (info.projectId && (!get('project', info.projectId) || role(inviter, info.projectId) !== 'maintainer')) fail(404, '项目邀请已失效', 'INVALID_INVITATION'); return { row, info }; }
  function authorizeReplay(actor, path, method, body, cached) {
    // A cached successful write is still protected by the caller's current rights.
    // Resolve object ownership from the original route, including responses without projectId.
    if (path === '/api/trash') {
      const kind = choice(body.kind, ['project', 'task', 'milestone', 'risk', 'resource']);
      const item = get(kind, body.id, true);
      if (!item) fail(404, '内容不存在或无权访问', 'NOT_FOUND');
      requireProject(actor, kind === 'project' ? item.id : item.projectId, 'maintainer', false, kind === 'project');
      return;
    }
    if (/^\/api\/members\//.test(path)) {
      requireAdmin(actor);
      const member = getUser(path.split('/').at(-1));
      if (!member) fail(404, '成员不存在');
      if (actor.workspace_role === 'admin' && (member.workspace_role !== 'member' || (body.workspaceRole && body.workspaceRole !== 'member'))) fail(403, '管理员只能维护普通成员');
      if (body.password !== undefined || body.workspaceRole === 'owner') {
        if (actor.workspace_role !== 'owner') fail(403, '需要所有者权限');
        if (!passwordMatches(body.reauthPassword, actor.password_hash)) fail(403, '需要所有者再次认证', 'REAUTH_REQUIRED');
      }
      return;
    }
    if (/^\/api\/teams(?:\/|$)/.test(path)) { requireAdmin(actor); return; }
    if (/^\/api\/invitations(?:\/|$)/.test(path)) {
      requireAdmin(actor);
      if ((cached.workspaceRole === 'admin' || body.workspaceRole === 'admin') && actor.workspace_role !== 'owner') fail(403, '仅所有者可处理管理员邀请');
      if (body.projectId) requireProject(actor, body.projectId, 'maintainer');
      return;
    }
    if (path === '/api/demo') { if (actor.workspace_role !== 'owner') fail(403, '仅所有者可导入样例'); return; }
    const grantMatch = path.match(/^\/api\/grants(?:\/([^/]+))?$/);
    if (grantMatch) {
      const grant = grantMatch[1] ? get('grant', grantMatch[1], true) : cached;
      if (!grant) fail(404, '授权不存在');
      requireProject(actor, grant.projectId, 'maintainer');
      return;
    }
    if (/^\/api\/projects(?:\/|$)/.test(path)) {
      if (path.endsWith('/recover')) { if (actor.workspace_role !== 'owner') fail(403, '需要所有者权限'); if (!passwordMatches(body.reauthPassword, actor.password_hash)) fail(403, '需要所有者再次认证', 'REAUTH_REQUIRED'); }
      requireProject(actor, cached.id, 'maintainer', false, Boolean(body.deleted));
      return;
    }
    const entityMatch = path.match(/^\/api\/(tasks|milestones|risks|resources|updates|comments)(?:\/([^/]+)(?:\/versions)?)?$/);
    if (entityMatch) {
      const kind = { tasks: 'task', milestones: 'milestone', risks: 'risk', resources: 'resource', updates: 'update', comments: 'comment' }[entityMatch[1]];
      const item = get(kind, entityMatch[2] ?? cached.id, true);
      if (!item) fail(404, '内容不存在或无权访问', 'NOT_FOUND');
      requireProject(actor, item.projectId, kind === 'milestone' || (body.deleted && kind !== 'comment') ? 'maintainer' : 'collaborator');
      const maintainer = role(actor, item.projectId) === 'maintainer';
      if (kind === 'task' && method === 'PATCH' && !maintainer && !(item.assigneeId === actor.id || (!item.assigneeId && item.createdBy === actor.id))) fail(403, '只能更新本人负责的任务');
      if (kind === 'resource' && !maintainer && item.createdBy !== actor.id) fail(403, '只能维护本人上传的资料');
      if (kind === 'comment') { if (!get('task', item.taskId)) fail(404, '任务不存在或无权访问', 'NOT_FOUND'); if (method === 'PATCH' && !maintainer && item.createdBy !== actor.id) fail(403, '只能编辑本人评论'); }
      if (kind === 'risk' && !maintainer && (body.status === 'closed' || item.createdBy !== actor.id)) fail(403, '项目风险关闭与维护需要维护权限');
      return;
    }
    fail(403, '无法验证此历史操作的当前权限', 'FORBIDDEN');
  }

  async function route(req, res, url, body, authenticated) {
    const path = url.pathname; const method = req.method; const actor = authenticated?.actor;
    if (method === 'GET' && path === '/api/bootstrap') return { initialized: !!db.prepare('SELECT id FROM users LIMIT 1').get(), limits: { maxFileBytes }, setupProtected: true };
    if (method === 'POST' && path === '/api/setup') {
      if (db.prepare('SELECT id FROM users LIMIT 1').get()) fail(409, '工作区已初始化', 'ALREADY_INITIALIZED');
      const configured = options.bootstrapToken; const supplied = req.headers['x-bootstrap-token'];
      if (typeof configured !== 'string' || configured.length < 43 || typeof supplied !== 'string' || !timingSafeEqual(Buffer.from(hash(configured),'hex'), Buffer.from(hash(supplied),'hex'))) fail(403, '仅持有一次性初始化凭据的管理员可建立平台', 'SETUP_FORBIDDEN');
      const member = { id: id(), name: text(body.name, '姓名', 80, true), email: email(body.email), password_hash: passwordHash(body.password), workspace_role: 'owner', status: 'active', version: 1 };
      db.prepare('INSERT INTO users(id,name,email,password_hash,workspace_role,status,version) VALUES(?,?,?,?,?,?,?)').run(member.id, member.name, member.email, member.password_hash, member.workspace_role, member.status, member.version); audit(member, 'workspace.setup'); return session(res, member);
    }
    if (method === 'POST' && path === '/api/login') {
      const key = hash(`${req.socket.remoteAddress}|${String(body.email).toLowerCase()}`); const attempts = db.prepare('SELECT * FROM login_attempts WHERE key=?').get(key); if (attempts && attempts.reset_at > Date.now() && attempts.failures >= 5) fail(429, '尝试次数过多，请15分钟后重试', 'RATE_LIMITED');
      const member = db.prepare('SELECT * FROM users WHERE email=?').get(String(body.email ?? '').toLowerCase().trim());
      if (!member || member.status !== 'active' || !passwordMatches(body.password, member.password_hash)) {
        db.prepare('INSERT INTO login_attempts VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET failures=excluded.failures,reset_at=excluded.reset_at').run(key, attempts && attempts.reset_at > Date.now() ? attempts.failures + 1 : 1, attempts && attempts.reset_at > Date.now() ? attempts.reset_at : Date.now() + 900000);
        audit(null, 'auth.failed'); return { __status: 401, error: '邮箱或密码不正确，或账号已停用', code: 'INVALID_CREDENTIALS' };
      }
      db.prepare('DELETE FROM login_attempts WHERE key=?').run(key); audit(member, 'auth.login'); return session(res, member);
    }
    if (method === 'GET' && path === '/api/invitations' && url.searchParams.has('token')) { const { row, info } = previewInvitation(url.searchParams.get('token')); const project = info.projectId ? get('project', info.projectId) : null; return { email: row.email, name: info.name, workspaceRole: info.workspaceRole, projectName: project?.name, projectRole: info.projectRole, expiresAt: new Date(row.expires).toISOString() }; }
    if (method === 'POST' && path === '/api/join') {
      const { row, info } = previewInvitation(body.token); if (db.prepare('SELECT id FROM users WHERE email=?').get(row.email)) fail(409, '此邮箱已有账号，请使用现有账号登录后由维护者授权', 'ACCOUNT_EXISTS');
      const member = { id: id(), name: text(body.name || info.name, '姓名', 80, true), email: row.email, password_hash: passwordHash(body.password), workspace_role: info.workspaceRole, status: 'active', version: 1 };
      db.prepare('INSERT INTO users(id,name,email,password_hash,workspace_role,status,version) VALUES(?,?,?,?,?,?,?)').run(member.id, member.name, member.email, member.password_hash, member.workspace_role, member.status, member.version); db.prepare('UPDATE invitations SET used=1 WHERE id=?').run(row.id);
      if (info.projectId) save('grant', { projectId: info.projectId, subjectType: 'member', subjectId: member.id, role: info.projectRole }, getUser(info.inviterId)); audit(member, 'invitation.accepted', 'invitation', row.id); return session(res, member);
    }
    if (!actor) fail(401, '请先登录', 'UNAUTHENTICATED');
    if (method === 'GET' && path === '/api/invitations') { requireAdmin(actor); return invitations(actor); }
    if (method === 'GET' && path === '/api/me') return { user: publicUser(actor), csrfToken: authenticated.session.csrf };
    if (method === 'GET' && path === '/api/state') return state(actor, authenticated.session.csrf);
    const history = path.match(/^\/api\/(tasks|milestones)\/([^/]+)\/history$/);
    if (method === 'GET' && history) { const kind = history[1] === 'tasks' ? 'task' : 'milestone'; const item = get(kind, history[2]); if (!item) fail(404, '内容不存在或无权访问', 'NOT_FOUND'); requireProject(actor, item.projectId); return db.prepare('SELECT * FROM audit WHERE project_id=? AND kind=? AND object_id=? ORDER BY created_at ASC,rowid ASC').all(item.projectId, kind, item.id).map(auditView); }
    if (method === 'POST' && path === '/api/logout') { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(authenticated.session.token_hash); res.setHeader('Set-Cookie', 'cockpit_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure'); return { ok: true }; }
    if (method === 'PATCH' && path === '/api/me') { fields(body, ['name', 'currentPassword', 'password', 'timeZone']); const name = body.name == null ? actor.name : text(body.name, '姓名', 80, true); const zone = body.timeZone === undefined ? actor.time_zone : timeZone(body.timeZone); let digest = actor.password_hash; if (body.password != null) { if (!passwordMatches(body.currentPassword, actor.password_hash)) fail(403, '当前密码不正确', 'REAUTH_REQUIRED'); digest = passwordHash(body.password); db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(actor.id, authenticated.session.token_hash); } db.prepare('UPDATE users SET name=?,password_hash=?,time_zone=?,version=version+1 WHERE id=?').run(name, digest, zone, actor.id); audit(actor, 'member.selfUpdated', 'member', actor.id, null, { before: { name: actor.name, timeZone: actor.time_zone }, after: { name, timeZone: zone } }); return { user: publicUser(getUser(actor.id)), csrfToken: authenticated.session.csrf }; }
    if (method === 'GET' && path === '/api/audit') return auditList(actor);
    if (method === 'GET' && path === '/api/trash') return ['project', 'task', 'milestone', 'risk', 'resource'].flatMap(kind => all(kind, true).filter(x => x.deletedAt && role(actor, kind === 'project' ? x.id : x.projectId) === 'maintainer').map(item => ({ ...item, kind })));
    if (method === 'POST' && path === '/api/trash') { const kind = choice(body.kind, ['project', 'task', 'milestone', 'risk', 'resource']); const item = get(kind, body.id, true); if (!item?.deletedAt) fail(404, '回收项不存在'); const pid = kind === 'project' ? item.id : item.projectId; requireProject(actor, pid, 'maintainer', kind !== 'project', kind === 'project'); if (!maintainerCount(pid)) fail(409, '请先恢复有效维护者'); const restored = save(kind, { ...item, deletedAt: null }, actor, item); if (kind === 'task' && restored.status === 'blocked') { const blocker = all('risk').find(r => r.taskId === restored.id); save('risk', { ...blocker, projectId: pid, title: restored.title, description: restored.blockReason || '任务已恢复，请跟进阻塞', level: 'blocked', status: 'open', taskId: restored.id, ownerId: restored.assigneeId, resolution: '', closedAt: null }, actor, blocker); } audit(actor, 'trash.restored', kind, item.id, pid); return kind === 'project' ? projectView(restored, actor) : restored; }
    if (method === 'POST' && path === '/api/projects') {
      fields(body, ['name', 'goal', 'ownerId', 'color', 'stage', 'lifecycle', 'targetDate', 'startDate']);
      const owner = body.ownerId ?? actor.id; if (!getUser(owner) || getUser(owner).status !== 'active') fail(400, '负责人账号不可用');
      const project = save('project', { name: text(body.name, '项目名称', 80, true), goal: text(body.goal, '项目目标', 500, true), ownerId: owner, color: choice(body.color, colors, 'lilac'), stage: text(body.stage || '待启动', '阶段', 80, true), lifecycle: choice(body.lifecycle, ['active', 'planned'], 'planned'), targetDate: date(body.targetDate), startDate: date(body.startDate) }, actor);
      if (project.startDate && project.targetDate && project.startDate > project.targetDate) fail(400, '目标日期不能早于开始日期');
      for (const uid of new Set([actor.id, owner])) save('grant', { projectId: project.id, subjectType: 'member', subjectId: uid, role: 'maintainer' }, actor); audit(actor, 'project.created', 'project', project.id, project.id); return projectView(project, actor);
    }
    let match = path.match(/^\/api\/projects\/([^/]+)\/recover$/);
    if (method === 'POST' && match) { if (actor.workspace_role !== 'owner') fail(403, '需要所有者权限'); if (!passwordMatches(body.reauthPassword, actor.password_hash)) fail(403, '需要所有者再次认证', 'REAUTH_REQUIRED'); const p = get('project', match[1], true); if (!p) fail(404, '项目不存在'); if (maintainerCount(p.id)) fail(409, '项目已有有效维护者，应由其授权'); const reason = text(body.reason, '接管原因', 1000, true); save('grant', { projectId: p.id, subjectType: 'member', subjectId: actor.id, role: 'maintainer' }, actor); audit(actor, 'project.emergencyRecovery', 'project', p.id, p.id, { reason }); return projectView(p, actor); }
    match = path.match(/^\/api\/projects\/([^/]+)\/export$/);
    if (method === 'GET' && match) { const project = requireProject(actor, match[1], 'maintainer'); const visible = kind => all(kind).filter(x => x.projectId === project.id); const resources = visible('resource'); const resourceIds = new Set(resources.map(r => r.id)); const versions = visible('version').filter(v => resourceIds.has(v.resourceId)); audit(actor, 'project.exported', 'project', project.id, project.id); res.setHeader('Content-Disposition', `attachment; filename="project-${project.id}.json"`); return { format: 'project-cockpit-business-export', formatVersion: 1, exportedAt: now(), note: '业务数据导出，文件仅含元信息；文件字节可逐项下载。完整系统恢复请使用数据库备份。', project: projectView(project, actor), tasks: visible('task'), milestones: visible('milestone'), risks: visible('risk'), updates: visible('update'), comments: visible('comment').filter(c => get('task', c.taskId)), resources, versions }; }
    match = path.match(/^\/api\/projects\/([^/]+)$/);
    if (method === 'PATCH' && match) {
      fields(body, ['name', 'goal', 'ownerId', 'color', 'stage', 'lifecycle', 'targetDate', 'startDate', 'deleted', 'summary', 'changeReason']); const project = requireProject(actor, match[1], 'maintainer'); conflict(project, body);
      if (['archived', 'completed'].includes(project.lifecycle) && !(body.lifecycle && (['active', 'planned'].includes(body.lifecycle) || (project.lifecycle === 'completed' && body.lifecycle === 'archived')) && Object.keys(body).every(k => ['version', 'operationId', 'lifecycle'].includes(k)))) fail(409, '需先单独重新打开项目', 'PROJECT_READONLY');
      const next = { ...project }; for (const k of ['name', 'goal', 'stage']) if (body[k] != null) next[k] = text(body[k], k, k === 'goal' ? 500 : 80, true); for (const k of ['targetDate', 'startDate']) if (body[k] != null) next[k] = date(body[k]); if (next.startDate && next.targetDate && next.startDate > next.targetDate) fail(400, '目标日期不能早于开始日期');
      if (body.ownerId != null) { if (role(getUser(body.ownerId), project.id) !== 'maintainer') fail(400, '新负责人必须有有效维护权限'); next.ownerId = body.ownerId; }
      if (body.color != null) next.color = choice(body.color, colors); if (body.lifecycle != null) next.lifecycle = choice(body.lifecycle, ['active', 'planned', 'completed', 'archived']);
      if (body.lifecycle === 'archived' && project.lifecycle !== 'archived') next.archiveFromLifecycle = project.lifecycle;
      if (project.lifecycle === 'archived' && body.lifecycle && body.lifecycle !== 'archived') next.lifecycle = project.archiveFromLifecycle ?? 'active';
      if (next.lifecycle === 'completed' && project.lifecycle !== 'completed' && project.lifecycle !== 'archived') { const p = projectView(project, actor); if ((p.total && p.total !== p.done) || p.health !== 'normal' || all('milestone').some(m => m.projectId === project.id && m.status !== 'done')) fail(409, '任务、里程碑或风险尚未闭环'); next.completionSummary = text(body.summary, '完成总结', 5000, true); next.completedAt = now(); }
      if (body.deleted) next.deletedAt = now(); const changed = save('project', next, actor, project); audit(actor, body.deleted ? 'project.deleted' : 'project.updated', 'project', project.id, project.id, { before: { lifecycle: project.lifecycle, targetDate: project.targetDate }, after: { lifecycle: next.lifecycle, targetDate: next.targetDate }, reason: text(body.changeReason, '改期说明', 1000) }); return projectView(changed, actor);
    }
    const entityRoute = path.match(/^\/api\/(tasks|milestones|risks)(?:\/([^/]+))?$/);
    if (entityRoute && ['POST', 'PATCH'].includes(method)) {
      const kind = { tasks: 'task', milestones: 'milestone', risks: 'risk' }[entityRoute[1]]; const existing = entityRoute[2] ? get(kind, entityRoute[2]) : null; if (method === 'PATCH' && !existing) fail(404, '内容不存在或无权访问', 'NOT_FOUND'); if (method === 'POST' && entityRoute[2]) fail(404, '接口不存在');
      const projectId = existing?.projectId ?? body.projectId; const project = requireProject(actor, projectId, kind === 'milestone' ? 'maintainer' : 'collaborator', true); const isMaintainer = role(actor, project.id) === 'maintainer'; if (existing) conflict(existing, body); if (existing && body.projectId && body.projectId !== projectId) fail(400, '不能跨项目移动对象');
      if (kind === 'task') {
        fields(body, ['projectId', 'title', 'description', 'assigneeId', 'status', 'dueDate', 'priority', 'milestoneId', 'blockReason', 'resolution', 'deleted']);
        if (existing && !isMaintainer) { if (!(existing.assigneeId === actor.id || (!existing.assigneeId && existing.createdBy === actor.id))) fail(403, '只能更新本人负责的任务'); if (Object.keys(body).some(k => !['version', 'operationId', 'description', 'status', 'blockReason', 'resolution'].includes(k))) fail(403, '此字段需要项目维护权限'); }
        if (existing?.status === 'done' && body.status && body.status !== 'done' && !isMaintainer) fail(403, '重开已完成任务需要维护权限');
        const task = { ...existing, projectId, title: body.title == null ? existing?.title : text(body.title, '任务标题', 120, true), description: body.description == null ? existing?.description ?? '' : text(body.description, '任务说明'), assigneeId: body.assigneeId === undefined ? (existing ? existing.assigneeId : actor.id) : assignee(body.assigneeId, projectId), status: choice(body.status, ['todo', 'doing', 'blocked', 'done', 'cancelled'], existing?.status ?? 'todo'), dueDate: body.dueDate === undefined ? existing?.dueDate ?? '' : date(body.dueDate), priority: choice(body.priority, ['low', 'medium', 'high'], existing?.priority ?? 'medium'), milestoneId: body.milestoneId === undefined ? existing?.milestoneId ?? null : body.milestoneId };
        if (!existing && !isMaintainer && (task.dueDate || task.priority !== 'medium' || task.milestoneId)) fail(403, '协作成员新建任务需使用默认优先级且不设置计划日期或里程碑');
        if (!task.title) fail(400, '任务标题不能为空'); if (!isMaintainer && !existing && (task.assigneeId && task.assigneeId !== actor.id)) fail(403, '协作成员只能创建本人或未分配任务'); if (!isMaintainer && task.status === 'cancelled') fail(403, '取消任务需要维护权限'); if (task.milestoneId && get('milestone', task.milestoneId)?.projectId !== projectId) fail(400, '里程碑必须属于同一项目');
        if (body.deleted && !isMaintainer) fail(403, '删除需要维护权限'); if (body.deleted) task.deletedAt = now(); if (task.status === 'done' && existing?.status !== 'done') task.completedAt = now(); if (existing?.status === 'done' && task.status !== 'done') task.reopenedAt = now();
        const leavingBlocked = existing?.status === 'blocked' && (task.status !== 'blocked' || body.deleted); const reason = task.status === 'blocked' && !body.deleted ? text(body.blockReason || (existing?.status === 'blocked' ? existing.blockReason : ''), '阻塞原因', 5000, true) : ''; const resolution = leavingBlocked ? text(body.resolution, '处理说明', 5000, true) : '';
        task.blockReason = reason; const changed = save('task', task, actor, existing); const blocker = all('risk').find(r => r.taskId === changed.id && r.status === 'open');
        if (reason) { save('risk', { ...blocker, projectId, title: changed.title, description: reason, level: 'blocked', status: 'open', taskId: changed.id, ownerId: changed.assigneeId, nextStep: '', followUpDate: '' }, actor, blocker); }
        if (leavingBlocked && blocker) save('risk', { ...blocker, status: 'closed', resolution, closedAt: now() }, actor, blocker);
        audit(actor, body.deleted ? 'task.deleted' : existing ? 'task.updated' : 'task.created', 'task', changed.id, projectId, { status: changed.status, previousStatus: existing?.status ?? null, ...changes(existing, changed, ['title', 'description', 'assigneeId', 'status', 'dueDate', 'priority', 'milestoneId', 'blockReason', 'completedAt', 'reopenedAt', 'deletedAt']) }); return changed;
      }
      if (kind === 'milestone') { fields(body, ['projectId', 'title', 'dueDate', 'status', 'deleted']); const milestone = { ...existing, projectId, title: body.title == null ? existing?.title : text(body.title, '里程碑名称', 120, true), dueDate: body.dueDate === undefined ? existing?.dueDate ?? '' : date(body.dueDate), status: choice(body.status, ['pending', 'done'], existing?.status ?? 'pending') }; if (!milestone.title) fail(400, '里程碑名称不能为空'); if (milestone.status === 'done' && existing?.status !== 'done') milestone.completedAt = now(); if (existing?.status === 'done' && milestone.status !== 'done') milestone.reopenedAt = now(); if (body.deleted) { if (all('task', true).some(task => task.milestoneId === existing?.id)) fail(409, '此里程碑仍被任务引用，请先解除任务关联；回收站任务需恢复后处理', 'MILESTONE_IN_USE'); milestone.deletedAt = now(); } const changed = save(kind, milestone, actor, existing); audit(actor, `milestone.${body.deleted ? 'deleted' : existing ? 'updated' : 'created'}`, kind, changed.id, projectId, changes(existing, changed, ['title', 'dueDate', 'status', 'completedAt', 'reopenedAt', 'deletedAt'])); return changed; }
      fields(body, ['projectId', 'title', 'description', 'level', 'status', 'ownerId', 'nextStep', 'followUpDate', 'resolution', 'deleted']); if (existing?.taskId) fail(409, '任务阻塞请在对应任务中处理'); if (existing && !isMaintainer && (body.status === 'closed' || body.deleted || existing.createdBy !== actor.id)) fail(403, '项目风险关闭与维护需要维护权限');
      const risk = { ...existing, projectId, title: body.title === undefined ? existing?.title : text(body.title, '风险标题', 120, true), description: body.description === undefined ? existing?.description ?? '' : text(body.description, '风险说明'), level: choice(body.level, ['risk', 'blocked'], existing?.level ?? 'risk'), status: choice(body.status, ['open', 'closed'], existing?.status ?? 'open'), ownerId: body.ownerId === undefined ? existing?.ownerId ?? actor.id : assignee(body.ownerId, projectId), nextStep: body.nextStep === undefined ? existing?.nextStep ?? '' : text(body.nextStep, '下一步'), followUpDate: body.followUpDate === undefined ? existing?.followUpDate ?? '' : date(body.followUpDate) };
      if (!risk.title) fail(400, '风险标题不能为空'); if (risk.status === 'closed' && !isMaintainer) fail(403, '关闭风险需要维护权限'); if (risk.status === 'closed' && existing?.status !== 'closed') { risk.resolution = text(body.resolution, '关闭说明', 5000, true); risk.closedAt = now(); } if (body.deleted) risk.deletedAt = now(); const changed = save(kind, risk, actor, existing); audit(actor, `risk.${body.deleted ? 'deleted' : existing ? 'updated' : 'created'}`, kind, changed.id, projectId, changes(existing, changed, ['title', 'description', 'level', 'status', 'ownerId', 'nextStep', 'followUpDate', 'resolution', 'closedAt', 'deletedAt'])); return changed;
    }
    if (method === 'POST' && path === '/api/updates') { fields(body, ['projectId', 'text', 'nextStep']); requireProject(actor, body.projectId, 'collaborator', true); const update = save('update', { projectId: body.projectId, text: text(body.text, '进展说明', 5000, true), nextStep: text(body.nextStep, '下一步') }, actor); audit(actor, 'update.created', 'update', update.id, body.projectId); return update; }
    if (method === 'POST' && path === '/api/comments') { fields(body, ['projectId', 'taskId', 'text']); requireProject(actor, body.projectId, 'collaborator', true); const task = get('task', body.taskId); if (!task || task.projectId !== body.projectId) fail(404, '任务不存在或无权访问'); const comment = save('comment', { projectId: body.projectId, taskId: task.id, text: text(body.text, '讨论内容', 5000, true) }, actor); audit(actor, 'comment.created', 'comment', comment.id, task.projectId); return comment; }
    const commentMatch = path.match(/^\/api\/comments\/([^/]+)$/);
    if (method === 'PATCH' && commentMatch) {
      fields(body, ['text', 'deleted']); const comment = get('comment', commentMatch[1]); if (!comment) fail(404, '内容不存在或无权访问', 'NOT_FOUND');
      requireProject(actor, comment.projectId, 'collaborator', true);
      const task = get('task', comment.taskId); if (!task || task.projectId !== comment.projectId) fail(404, '任务不存在或无权访问', 'NOT_FOUND');
      if (comment.createdBy !== actor.id && role(actor, comment.projectId) !== 'maintainer') fail(403, '只能编辑本人评论，或由项目维护者管理', 'FORBIDDEN');
      conflict(comment, body); const next = { ...comment };
      if (body.text !== undefined) { next.text = text(body.text, '讨论内容', 5000, true); next.editedAt = now(); }
      if (body.deleted) next.deletedAt = now();
      const changed = save('comment', next, actor, comment); audit(actor, body.deleted ? 'comment.deleted' : 'comment.updated', 'comment', changed.id, comment.projectId, changes(comment, changed, ['text', 'editedAt', 'deletedAt'])); return changed;
    }
    if (method === 'POST' && path === '/api/resources') {
      fields(body, ['projectId', 'name', 'description', 'kind', 'url', 'file']); requireProject(actor, body.projectId, 'collaborator', true); const kind = choice(body.kind, ['file', 'link'], 'file'); const urlValue = kind === 'link' ? text(body.url, '链接', 2000, true) : ''; if (kind === 'link') { try { if (new URL(urlValue).protocol !== 'https:') fail(400, '资料链接仅支持HTTPS'); } catch { fail(400, '资料链接仅支持有效HTTPS地址'); } }
      let resource = save('resource', { projectId: body.projectId, name: text(body.name || body.file?.name, '资料名称', 200, true), description: text(body.description, '资料说明'), kind, url: urlValue }, actor); if (kind === 'file') { const version = await putFile(resource, body.file, actor); resource = save('resource', { ...resource, currentVersionId: version.id }, actor, resource); } audit(actor, 'resource.created', 'resource', resource.id, body.projectId); return resource;
    }
    match = path.match(/^\/api\/resources\/([^/]+)(\/versions)?$/);
    if (match && ['POST', 'PATCH'].includes(method)) {
      const resource = get('resource', match[1]); if (!resource) fail(404, '内容不存在或无权访问'); requireProject(actor, resource.projectId, 'collaborator', true); const isMaintainer = role(actor, resource.projectId) === 'maintainer'; if (!isMaintainer && resource.createdBy !== actor.id) fail(403, '只能维护本人上传的资料'); conflict(resource, body);
      if (method === 'POST' && match[2]) { fields(body, ['file', 'note', 'restoreVersionId']); if (resource.kind !== 'file') fail(400, '链接不支持文件版本'); if (body.restoreVersionId && !isMaintainer) fail(403, '恢复版本需要维护权限'); const version = await putFile(resource, body.file, actor, body.note, body.restoreVersionId); const changed = save('resource', { ...resource, currentVersionId: version.id }, actor, resource); audit(actor, body.restoreVersionId ? 'resource.versionRestored' : 'resource.versionAdded', 'resource', resource.id, resource.projectId, { versionId: version.id }); return { ...changed, newVersion: version }; }
      if (method !== 'PATCH' || match[2]) fail(404, '接口不存在'); fields(body, ['name', 'description', 'url', 'deleted']); if (body.deleted && !isMaintainer) fail(403, '删除资料需要维护权限'); const changed = { ...resource }; if (body.name !== undefined) changed.name = text(body.name, '资料名称', 200, true); if (body.description !== undefined) changed.description = text(body.description, '资料说明'); if (body.url !== undefined) { if (resource.kind !== 'link') fail(400, '文件不支持链接地址'); const urlValue = text(body.url, '链接', 2000, true); try { if (new URL(urlValue).protocol !== 'https:') fail(400, '资料链接仅支持HTTPS'); } catch { fail(400, '链接地址无效'); } changed.url = urlValue; } if (body.deleted) changed.deletedAt = now(); const result = save('resource', changed, actor, resource); audit(actor, body.deleted ? 'resource.deleted' : 'resource.updated', 'resource', resource.id, resource.projectId); return result;
    }
    match = path.match(/^\/api\/files\/([^/]+)$/);
    if (method === 'GET' && match) { const version = get('version', match[1]); if (!version) fail(404, '内容不存在或无权访问'); requireProject(actor, version.projectId); if (!get('resource', version.resourceId)) fail(404, '内容不存在或无权访问'); const blob = await db.fileObject(version.id); if (!blob) fail(404, '文件不可用'); audit(actor, 'resource.downloaded', 'version', version.id, version.projectId); res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(version.fileName)}`); res.setHeader('Content-Length', version.size); res.end(blob.body); return null; }
    match = path.match(/^\/api\/members\/([^/]+)$/);
    if (method === 'PATCH' && match) {
      requireAdmin(actor); fields(body, ['name', 'status', 'workspaceRole', 'password', 'reauthPassword']); const member = getUser(match[1]); if (!member) fail(404, '成员不存在'); conflict(member, body); if (actor.workspace_role === 'admin' && (member.workspace_role !== 'member' || (body.workspaceRole && body.workspaceRole !== 'member'))) fail(403, '管理员只能维护普通成员');
      const workspaceRole = choice(body.workspaceRole, ['owner', 'admin', 'member'], member.workspace_role); const status = choice(body.status, ['active', 'suspended'], member.status); if (member.workspace_role === 'owner' && (status !== 'active' || workspaceRole !== 'owner')) fail(409, '不能移除最后所有者，请先转移所有权', 'LAST_OWNER');
      if (workspaceRole === 'owner' && member.workspace_role !== 'owner') { if (actor.workspace_role !== 'owner' || status !== 'active') fail(403, '转移所有权需要所有者权限且目标账号有效'); if (!passwordMatches(body.reauthPassword, actor.password_hash)) fail(403, '转移所有权需要所有者再次认证', 'REAUTH_REQUIRED'); db.prepare("UPDATE users SET workspace_role='admin',version=version+1 WHERE id=?").run(actor.id); }
      let digest = member.password_hash; if (body.password !== undefined) { if (actor.workspace_role !== 'owner') fail(403, '重置密码需要所有者权限'); if (!passwordMatches(body.reauthPassword, actor.password_hash)) fail(403, '重置密码需要所有者再次认证', 'REAUTH_REQUIRED'); digest = passwordHash(body.password); }
      db.prepare('UPDATE users SET name=?,status=?,workspace_role=?,password_hash=?,version=version+1 WHERE id=?').run(body.name === undefined ? member.name : text(body.name, '姓名', 80, true), status, workspaceRole, digest, member.id); if (status === 'suspended' || body.password !== undefined) db.prepare('DELETE FROM sessions WHERE user_id=?').run(member.id); audit(actor, 'member.updated', 'member', member.id, null, { beforeRole: member.workspace_role, role: workspaceRole, beforeStatus: member.status, status, ...changes(publicUser(member), publicUser(getUser(member.id)), ['name', 'workspaceRole', 'status']) }); return publicUser(getUser(member.id));
    }
    match = path.match(/^\/api\/teams(?:\/([^/]+))?$/);
    if (match && ['POST', 'PATCH'].includes(method)) { requireAdmin(actor); fields(body, ['name', 'memberIds', 'deleted']); const existing = match[1] ? get('team', match[1]) : null; if (method === 'PATCH' && !existing) fail(404, '团队不存在'); if (existing) conflict(existing, body); const memberIds = body.memberIds ?? existing?.memberIds ?? []; if (!Array.isArray(memberIds) || memberIds.some(uid => !getUser(uid) || (getUser(uid).status !== 'active' && !existing?.memberIds.includes(uid)))) fail(400, '团队新增成员必须为有效账号'); const changed = save('team', { name: body.name === undefined ? existing?.name : text(body.name, '团队名称', 80, true), memberIds: [...new Set(memberIds)], deletedAt: body.deleted ? now() : null }, actor, existing); if (!changed.name) fail(400, '团队名称不能为空'); protectMaintainers(all('grant').filter(g => g.subjectType === 'team' && g.subjectId === changed.id).map(g => g.projectId)); audit(actor, body.deleted ? 'team.deleted' : 'team.updated', 'team', changed.id, null, changes(existing, changed, ['name', 'memberIds', 'deletedAt'])); return changed; }
    if (method === 'POST' && path === '/api/grants') { fields(body, ['projectId', 'subjectType', 'subjectId', 'role']); requireProject(actor, body.projectId, 'maintainer'); const subjectType = choice(body.subjectType, ['member', 'team']); if (subjectType === 'member' ? !getUser(body.subjectId) || getUser(body.subjectId).status !== 'active' : !get('team', body.subjectId)) fail(400, '授权对象不可用'); const previous = all('grant').find(g => g.projectId === body.projectId && g.subjectType === subjectType && g.subjectId === body.subjectId); const grant = save('grant', { projectId: body.projectId, subjectType, subjectId: body.subjectId, role: choice(body.role, Object.keys(ranks)) }, actor, previous); protectMaintainers([body.projectId]); audit(actor, 'grant.updated', 'grant', grant.id, body.projectId, { subjectType, subjectId: grant.subjectId, previousRole: previous?.role ?? null, role: grant.role }); return grant; }
    match = path.match(/^\/api\/grants\/([^/]+)$/);
    if (method === 'DELETE' && match) { const grant = get('grant', match[1]); if (!grant) fail(404, '授权不存在'); requireProject(actor, grant.projectId, 'maintainer'); save('grant', { ...grant, deletedAt: now() }, actor, grant); protectMaintainers([grant.projectId]); audit(actor, 'grant.revoked', 'grant', grant.id, grant.projectId, { subjectId: grant.subjectId }); return { ok: true, remainingRole: grant.subjectType === 'member' ? role(getUser(grant.subjectId), grant.projectId) : null }; }
    if (method === 'POST' && path === '/api/invitations') { requireAdmin(actor); fields(body, ['email', 'name', 'workspaceRole', 'projectId', 'projectRole']); const roleValue = choice(body.workspaceRole, ['member', 'admin'], 'member'); if (roleValue === 'admin' && actor.workspace_role !== 'owner') fail(403, '仅所有者可邀请管理员'); if (body.projectId) requireProject(actor, body.projectId, 'maintainer'); const mail = email(body.email); if (db.prepare('SELECT id FROM users WHERE email=?').get(mail)) fail(409, '此邮箱已加入'); const token = randomBytes(32).toString('hex'); const invitationId = id(); const expires = Date.now() + 7 * 86400000; const info = { inviterId: actor.id, workspaceRole: roleValue, name: text(body.name, '姓名', 80), projectId: body.projectId ?? null, projectRole: body.projectId ? choice(body.projectRole, Object.keys(ranks), 'collaborator') : null }; db.prepare('INSERT INTO invitations VALUES(?,?,?,?,?,0,0)').run(invitationId, hash(token), mail, JSON.stringify(info), expires); audit(actor, 'invitation.created', 'invitation', invitationId, null, { email: mail, workspaceRole: roleValue }); return { id: invitationId, email: mail, ...info, token, expiresAt: new Date(expires).toISOString() }; }
    match = path.match(/^\/api\/invitations\/([^/]+)$/);
    if (method === 'DELETE' && match) { requireAdmin(actor); const invitation = db.prepare('SELECT * FROM invitations WHERE id=?').get(match[1]); if (!invitation) fail(404, '邀请不存在'); const info = JSON.parse(invitation.payload); if (info.workspaceRole === 'admin' && actor.workspace_role !== 'owner') fail(403, '仅所有者可处理管理员邀请'); db.prepare('UPDATE invitations SET revoked=1 WHERE id=?').run(invitation.id); audit(actor, 'invitation.revoked', 'invitation', invitation.id); return { ok: true }; }
    if (method === 'POST' && path === '/api/demo') fail(403, '公网平台不导入演示数据', 'DEMO_DISABLED');
    fail(404, '接口不存在', 'NOT_FOUND');
  }
  return { route, auth, checkOrigin, authFailure, authorizeReplay };
}
