import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../开发/server/index.mjs';

const origin = 'http://127.0.0.1:4174';
const checks = {};
const page = await fetch(origin + '/');
assert.equal(page.status, 200);
const cookieHeader = page.headers.get('set-cookie');
assert.match(cookieHeader, /^cockpit_design_session=/);
assert.ok(cookieHeader?.includes('HttpOnly'));
assert.ok(cookieHeader.includes('SameSite=Lax'));
await page.arrayBuffer();
const cookie = cookieHeader.split(';')[0];
const stateResponse = await fetch(origin + '/api/state', { headers: { Cookie: cookie } });
assert.equal(stateResponse.status, 200);
const state = await stateResponse.json();
assert.equal(state.user.email, 'design-review@example.test');
assert.equal(state.projects.length, 6);
assert.equal(state.tasks.length, 93);
checks.freshCookieLessDocumentCreatesRealDemoSession = true;
const bootstrap = await (await fetch(origin + '/api/bootstrap')).json();
assert.equal(bootstrap.designPreview, true);
assert.equal(bootstrap.loginPreviewUrl, '/auth-preview');
checks.bootstrapMarksOnlyLocalDesignPreview = true;
const stale = await fetch(origin + '/', { headers: { Cookie: 'cockpit_design_session=expired-preview-session' } });
assert.equal(stale.status, 200);
const renewed = stale.headers.get('set-cookie');
assert.ok(renewed?.includes('HttpOnly'));
await stale.arrayBuffer();
assert.equal((await fetch(origin + '/api/me', { headers: { Cookie: renewed.split(';')[0] } })).status, 200);
checks.expiredSessionDocumentRefreshCreatesNewRealSession = true;
for (const pathname of ['/auth-preview', '/login-preview']) {
  const preview = await fetch(origin + pathname);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('set-cookie'), null);
  await preview.arrayBuffer();
  const existing = await fetch(origin + pathname, { headers: { Cookie: cookie } });
  assert.equal(existing.status, 200);
  assert.equal(existing.headers.get('set-cookie'), null);
  await existing.arrayBuffer();
}
checks.explicitLoginPreviewDoesNotAutoLoginOrLogout = true;
assert.equal((await fetch(origin + '/api/me', { headers: { Cookie: cookie } })).status, 200);
assert.equal((await fetch(origin + '/api/state')).status, 401);
checks.apiStillRejectsAnonymousRequests = true;
const productionBootstrap = await (await fetch('http://127.0.0.1:4173/api/bootstrap')).json();
assert.equal(productionBootstrap.designPreview, undefined);
checks.formal4173HasNoDesignPreviewFlag = true;
// Use a separate temporary formal app rather than initialize/change the real
// empty 4173 database. Both ordinary and design cookies share one simulated jar.
const formalDir = mkdtempSync(join(tmpdir(), 'cockpit-cookie-isolation-'));
const formal = createApp({ dataDir: formalDir, secureCookie: false });
try {
  await new Promise(ready => formal.server.listen(0, '127.0.0.1', ready));
  const formalOrigin = 'http://127.0.0.1:' + formal.server.address().port;
  const setup = await fetch(formalOrigin + '/api/setup', { method: 'POST', headers: { Origin: formalOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '独立正式会话验证', email: 'formal-cookie-isolation@example.test', password: randomBytes(24).toString('base64url') }) });
  assert.equal(setup.status, 200);
  const formalCookie = setup.headers.get('set-cookie').split(';')[0];
  await setup.arrayBuffer();
  assert.match(formalCookie, /^cockpit_session=/);
  assert.equal((await fetch(origin + '/api/me', { headers: { Cookie: formalCookie } })).status, 401, '预览必须忽略内核/正式会话名');
  const formalOnlyDocument = await fetch(origin + '/', { headers: { Cookie: formalCookie } });
  assert.equal(formalOnlyDocument.status, 200);
  assert.match(formalOnlyDocument.headers.get('set-cookie'), /^cockpit_design_session=/, '预览不得设置正式Cookie名称');
  await formalOnlyDocument.arrayBuffer();
  for (const combined of [formalCookie + '; ' + cookie, cookie + '; ' + formalCookie]) {
    const previewMe = await fetch(origin + '/api/me', { headers: { Cookie: combined } });
    const formalMe = await fetch(formalOrigin + '/api/me', { headers: { Cookie: combined } });
    assert.equal(previewMe.status, 200); assert.equal(formalMe.status, 200);
    assert.equal((await previewMe.json()).user.email, 'design-review@example.test');
    assert.equal((await formalMe.json()).user.email, 'formal-cookie-isolation@example.test');
  }
  checks.designAndFormalCookiesResolveSeparateUsersInEitherOrder = true;
  checks.designWrapperIgnoresFormalCookieAndNeverOverwritesIt = true;
  const loginResponse = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, Cookie: formalCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'design-review@example.test', password: 'Review-Only-2026!' }) });
  assert.equal(loginResponse.status, 200);
  const designLoginCookie = loginResponse.headers.get('set-cookie');
  assert.match(designLoginCookie, /^cockpit_design_session=/);
  assert.equal(/; Secure(?:;|$)/.test(designLoginCookie), false, '独立HTTP预览不继承生产Secure配置');
  const previewIdentity = await loginResponse.json();
  const logout = await fetch(origin + '/api/logout', { method: 'POST', headers: { Origin: origin, Cookie: formalCookie + '; ' + designLoginCookie.split(';')[0], 'X-CSRF-Token': previewIdentity.csrfToken } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /^cockpit_design_session=;/);
  await logout.arrayBuffer();
  assert.equal((await fetch(formalOrigin + '/api/me', { headers: { Cookie: formalCookie } })).status, 200);
  checks.previewLoginAndLogoutOnlySetIndependentDesignCookie = true;
} finally {
  await formal.close();
  rmSync(formalDir, { recursive: true, force: true });
}
const result = { checkedAt: new Date().toISOString(), origin, checks, passed: true, note: '使用无Cookie及无效Cookie真实HTTP请求；不保存会话凭据或密码。浏览器布局另由前端验收。' };
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), '设计预览会话检查.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
