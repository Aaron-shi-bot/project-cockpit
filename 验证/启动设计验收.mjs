import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../开发/server/index.mjs';

// This explicit fixture is only for local visual acceptance. Production start
// never imports this script or these fictitious credentials/data.
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '设计验收数据');
const origin = 'http://127.0.0.1:4174';
const owner = { name: '林舟', email: 'design-review@example.test', password: 'Review-Only-2026!' };
const kernelRequestSecret = randomBytes(32).toString('hex');
const internalHeaders = { 'X-Design-Kernel-Request': kernelRequestSecret };
mkdirSync(dataDir, { recursive: true });
const app = createApp({ dataDir, staticDir: resolve(here, '../开发/dist'), publicOrigin: origin, secureCookie: false, onError: error => console.error('设计演示服务异常：', error.message) });
const applicationHandler = app.server.listeners('request')[0];
app.server.removeListener('request', applicationHandler);
app.server.on('request', async (req, res) => {
  try {
    // Cookies have host/path scope, not port scope. Keep the browser's preview
    // cookie separate from the formal 4173 application's cockpit_session.
    // Only our in-process HTTP helpers know this ephemeral secret; browser
    // requests always cross the cookie translation boundary.
    const internal = req.headers['x-design-kernel-request'] === kernelRequestSecret;
    delete req.headers['x-design-kernel-request'];
    if (internal) { await applicationHandler(req, res); return; }
    const designCookie = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('cockpit_design_session='));
    req.headers.cookie = designCookie ? 'cockpit_session=' + designCookie.slice('cockpit_design_session='.length) : '';
    const setHeader = res.setHeader;
    res.setHeader = function (name, value) {
      if (name.toLowerCase() === 'set-cookie') {
        const translate = entry => String(entry).replace(/^cockpit_session=/, 'cockpit_design_session=');
        value = Array.isArray(value) ? value.map(translate) : translate(value);
      }
      return setHeader.call(this, name, value);
    };
    const pathname = new URL(req.url, origin).pathname;
    if (req.method === 'GET' && pathname === '/api/design-preview') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end(JSON.stringify({ enabled: true, loginPreviewUrl: '/auth-preview' }));
      return;
    }
    if (req.method === 'GET' && pathname === '/api/bootstrap') {
      const end = res.end;
      res.end = function (chunk, ...args) {
        const bootstrap = JSON.parse(chunk.toString());
        return end.call(this, JSON.stringify({ ...bootstrap, designPreview: true, loginPreviewUrl: '/auth-preview' }), ...args);
      };
    }
    const loginPreview = ['/auth-preview', '/login-preview'].includes(pathname);
    const documentRequest = req.method === 'GET' && !pathname.startsWith('/api/') && !loginPreview && (
      req.headers['sec-fetch-dest'] === 'document' || req.headers.accept?.includes('text/html') ||
      ['/', '/index.html', '/overview', '/projects', '/tasks', '/resources', '/settings'].includes(pathname)
    );
    if (documentRequest) {
      const existing = req.headers.cookie ? await fetch(origin + '/api/me', { headers: { ...internalHeaders, Cookie: req.headers.cookie } }) : null;
      if (existing) await existing.arrayBuffer();
      if (!existing?.ok) {
        // Issue an ordinary application session through the existing real login
        // route. No credentials or auth bypass are shipped to browser code.
        const login = await fetch(origin + '/api/login', { method: 'POST', headers: { ...internalHeaders, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: owner.email, password: owner.password }) });
        if (!login.ok) throw new Error('虚构演示会话无法建立');
        const sessionCookie = login.headers.get('set-cookie');
        if (!sessionCookie) throw new Error('虚构演示会话缺少Cookie');
        res.setHeader('Set-Cookie', sessionCookie);
        req.headers.cookie = sessionCookie.split(';')[0];
        await login.arrayBuffer();
      }
    }
    await applicationHandler(req, res);
  } catch (error) {
    if (!res.writableEnded) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('本机设计预览暂时无法建立会话，请重新启动设计验收脚本。');
    }
    console.error('设计预览包装层异常：', error.message);
  }
});
let cookie = '', csrfToken = '';
async function api(path, method = 'GET', body) {
  const response = await fetch(origin + '/api' + path, {
    method,
    headers: { ...internalHeaders, Origin: origin, Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}：${result.error || response.status}`);
  const session = response.headers.get('set-cookie');
  if (session) cookie = session.split(';')[0];
  if (result.csrfToken) csrfToken = result.csrfToken;
  return result;
}
const contentFile = (name, content) => ({ name, mime: 'text/markdown', base64: Buffer.from(content, 'utf8').toString('base64') });
let exiting = false;
async function stop() { if (!exiting) { exiting = true; await app.close(); } }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop().then(() => process.exit(0)));
try {
  await new Promise((ready, reject) => { app.server.once('error', reject); app.server.listen(4174, '127.0.0.1', ready); });
  const bootstrap = await api('/bootstrap');
  if (!bootstrap.initialized) await api('/setup', 'POST', owner);
  else await api('/login', 'POST', { email: owner.email, password: owner.password });
  let state = await api('/state');
  if (!state.projects.some(project => project.demo)) await api('/demo', 'POST');
  state = await api('/state');
  const ownerCookie = cookie, ownerCsrf = csrfToken;
  const fictional = [
    { name: '陈琳', email: 'design-chenlin@example.test', workspaceRole: 'admin' },
    { name: '周远', email: 'design-zhouyuan@example.test', workspaceRole: 'member' },
    { name: '许宁', email: 'design-xuning@example.test', workspaceRole: 'member' },
  ];
  for (const person of fictional) {
    if (state.members.some(member => member.email === person.email)) continue;
    const invitation = await api('/invitations', 'POST', person);
    // The high entropy invitation is consumed immediately and never printed.
    await api('/join', 'POST', { token: invitation.token, name: person.name, password: randomBytes(24).toString('base64url') });
    cookie = ownerCookie; csrfToken = ownerCsrf;
    state = await api('/state');
  }
  const byEmail = email => state.members.find(member => member.email === email);
  const chen = byEmail(fictional[0].email), zhou = byEmail(fictional[1].email), xu = byEmail(fictional[2].email);
  let team = state.teams.find(item => item.name === '交付协作组');
  if (!team) team = await api('/teams', 'POST', { name: '交付协作组', memberIds: [chen.id, zhou.id].filter(uid => state.members.find(member => member.id === uid)?.status === 'active') });
  async function grant(project, subjectType, subjectId, role) {
    if (!state.grants.some(item => item.projectId === project.id && item.subjectType === subjectType && item.subjectId === subjectId)) {
      await api('/grants', 'POST', { projectId: project.id, subjectType, subjectId, role });
      state = await api('/state');
    }
  }
  for (const project of state.projects.filter(project => project.demo)) await grant(project, 'team', team.id, 'collaborator');
  const portal = state.projects.find(project => project.name === '客户服务门户');
  const device = state.projects.find(project => project.name === '智能设备控制台');
  if (!portal || !device) throw new Error('设计样例项目缺失；脚本不会重置或覆盖既有演示库。');
  await grant(portal, 'member', chen.id, 'maintainer');
  await grant(portal, 'member', xu.id, 'viewer');
  await grant(device, 'member', xu.id, 'viewer');
  const firstRunMarker = state.resources.some(resource => resource.projectId === portal.id && resource.name === '接口说明.md');
  // Assign the original sample rows once; subsequent starts preserve edits.
  if (!firstRunMarker) {
    const assignments = { '完成账户模块联调': zhou.id, '整理接口验收清单': chen.id, '完成页面适配': chen.id };
    for (const task of state.tasks.filter(task => task.projectId === portal.id && assignments[task.title])) {
      await api('/tasks/' + task.id, 'PATCH', { version: task.version, assigneeId: assignments[task.title] });
    }
  }
  async function resource(project, name, content) {
    let existing = state.resources.find(item => item.projectId === project.id && item.name === name);
    if (!existing) {
      existing = await api('/resources', 'POST', { projectId: project.id, name, description: '本机设计验收用虚构资料，可打开下载和版本记录。', kind: 'file', file: contentFile(name, content) });
      state = await api('/state');
    }
    return existing;
  }
  const interfaceDoc = await resource(portal, '接口说明.md', '# 客户服务门户 · 接口说明\n\n这是本机设计验收的虚构资料。\n\n版本：v1\n- 账户查询接口字段待确认。\n- 订单状态映射待评审。\n');
  if (!state.versions.some(version => version.resourceId === interfaceDoc.id && version.number >= 2)) {
    await api('/resources/' + interfaceDoc.id + '/versions', 'POST', { version: interfaceDoc.version, note: 'v2补充字段说明，保留首版供版本验收。', file: contentFile('接口说明.md', '# 客户服务门户 · 接口说明\n\n这是本机设计验收的虚构资料，不对应真实客户或接口。\n\n版本：v2\n- 已补充账户查询字段示例。\n- 订单状态映射仍等待确认。\n- 验收节点：10月27日接口验收。\n') });
    state = await api('/state');
  }
  await resource(device, '设备联调计划.md', '# 智能设备控制台 · 联调计划\n\n本机设计验收的虚构资料。\n\n- 检查设备连接状态。\n- 验证控制指令回执。\n- 11月6日前完成联调。\n');
  if (!state.resources.some(item => item.projectId === portal.id && item.kind === 'link' && item.name === '示例资料链接')) {
    await api('/resources', 'POST', { projectId: portal.id, kind: 'link', name: '示例资料链接', description: 'example.com公共示例站点，用于验收资料链接样式。', url: 'https://example.com' });
  }
  state = await api('/state');
  const report = {
    mode: '仅本机虚构设计验收；未部署', url: origin, host: '127.0.0.1', port: 4174, pid: process.pid,
    dataDir, formalPort4173Unchanged: true, startedAt: new Date().toISOString(),
    projects: state.projects.length, tasks: state.tasks.length, completedTasks: state.tasks.filter(task => task.status === 'done').length,
    members: state.members.map(member => ({ name: member.name, email: member.email, workspaceRole: member.workspaceRole })),
    teams: state.teams.length, resources: state.resources.length, fileVersions: state.versions.length,
    automaticLocalPreviewSession: true, browserCookieName: 'cockpit_design_session', loginPreviewUrl: origin + '/auth-preview',
    note: '账号和资料均为虚构；新浏览器直接进入演示，登录设计另有专用入口。报告不含密码或邀请令牌。',
  };
  writeFileSync(join(here, '设计验收运行.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  console.log('设计验收服务保持运行。全新浏览器直接打开即可进入虚构演示；登录设计入口/auth-preview。正式运行目录与4173未改动。');
} catch (error) {
  console.error('设计验收启动失败：', error.message);
  await stop();
  process.exitCode = 1;
}
