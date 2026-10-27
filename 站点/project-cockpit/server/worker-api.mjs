import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { MemoryStore } from './memory-store.mjs';
import { createKernel } from './kernel.mjs';
import { readSnapshot, commitStore, prepareUploads, cleanupKnownRollback, retryCleanup } from './d1-store.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const denied = (status, message, code) => Object.assign(new Error(message), { status, code });
const commonHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' };
async function parseBody(request, maximum) {
  if (!request.body) return {};
  const reader = request.body.getReader(); const chunks = []; let length = 0;
  while (true) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength; if (length > maximum * 1.4 + 262144) { await reader.cancel(); throw denied(413, '请求超过允许大小', 'TOO_LARGE'); } chunks.push(value); }
  if (!length) return {};
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw denied(415, '请使用JSON请求', 'INVALID_REQUEST');
  try { const body = JSON.parse(Buffer.concat(chunks).toString()); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body; } catch { throw denied(400, 'JSON对象格式不正确', 'INVALID_REQUEST'); }
}
function responseShim() {
  return { headers: new Headers(commonHeaders), statusCode: 200, writableEnded: false, body: null, setHeader(name, value) { this.headers.set(name, String(value)); }, end(value) { this.body = value ?? null; this.writableEnded = true; } };
}
export async function handleApi(request, env, executionContext) {
  const url = new URL(request.url);
  const localTest = env.LOCAL_WORKER_TEST === '1' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localTest) return Response.json({ error: '平台只接受HTTPS访问', code: 'HTTPS_REQUIRED' }, { status: 400, headers: commonHeaders });
  if (!env.DB || !env.BUCKET) return Response.json({ error: '平台持久化尚未配置', code: 'STORAGE_UNAVAILABLE' }, { status: 503, headers: commonHeaders });
  const maxFileBytes = Number(env.MAX_FILE_BYTES ?? 10485760);
  let body;
  try { body = !['GET', 'HEAD', 'OPTIONS'].includes(request.method) ? await parseBody(request, maxFileBytes) : {}; }
  catch (error) { return Response.json({ error: error.message, code: error.code }, { status: error.status ?? 400, headers: commonHeaders }); }
  for (let attempt = 0; attempt < 3; attempt++) {
    let snapshot, store, uploaded = [], kernel, req, authenticationRequest = false;
    try {
      snapshot = await readSnapshot(env.DB); store = new MemoryStore(snapshot, { bucket: env.BUCKET });
      kernel = createKernel(store, { maxFileBytes, publicOrigin: url.origin, bootstrapToken: env.BOOTSTRAP_TOKEN });
      req = { method: request.method, headers: Object.fromEntries(request.headers), socket: { remoteAddress: request.headers.get('cf-connecting-ip') || 'edge' } };
      // Host comes from the actual platform request URL, never a caller-supplied
      // forwarded host. HTTPS sessions always use Secure in the kernel.
      req.headers.host = url.host;
      const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method); if (write) kernel.checkOrigin(req);
      authenticationRequest = write && ['/api/setup', '/api/login', '/api/join'].includes(url.pathname);
      const authenticated = kernel.auth(req), res = responseShim();
      if (authenticationRequest) { const counter = store.prepare('SELECT * FROM login_attempts WHERE key=?').get(hash(`auth-ip|${req.socket.remoteAddress}`)); if (counter && counter.reset_at > Date.now() && counter.failures >= 40) throw denied(429, '认证失败次数过多，请稍后重试', 'RATE_LIMITED'); }
      const publicWrite = ['/api/setup', '/api/login', '/api/join'].includes(url.pathname);
      if (write && !publicWrite && authenticated && req.headers['x-csrf-token'] !== authenticated.session.csrf) throw denied(403, '会话校验失败，请刷新后重试', 'CSRF_REJECTED');
      if (url.pathname === '/api/demo') throw denied(403, '公网平台不导入演示数据', 'DEMO_DISABLED');
      let operation;
      const operationKey = req.headers['x-operation-id'] ?? body.operationId;
      if (write && authenticated && operationKey && !['/api/login', '/api/logout', '/api/join', '/api/setup', '/api/me'].includes(url.pathname)) {
        if (typeof operationKey !== 'string' || operationKey.length > 100) throw denied(400, '操作标识不正确', 'INVALID_REQUEST');
        const requestHash = hash(`${req.method}|${url.pathname}|${JSON.stringify(body)}`);
        const previous = store.prepare('SELECT * FROM operations WHERE user_id=? AND key=?').get(authenticated.actor.id, operationKey);
        if (previous) { if (previous.request_hash !== requestHash) throw denied(409, '操作标识已被其他请求使用', 'OPERATION_CONFLICT'); const result = JSON.parse(previous.response); kernel.authorizeReplay(authenticated.actor, url.pathname, req.method, body, result); return Response.json(result, { headers: commonHeaders }); }
        operation = { key: operationKey, requestHash };
      }
      const result = await kernel.route(req, res, url, body, authenticated);
      if (authenticationRequest && result?.__status >= 400) kernel.authFailure(req);
      if (operation) store.prepare('INSERT INTO operations VALUES(?,?,?,?)').run(authenticated.actor.id, operation.key, operation.requestHash, JSON.stringify(result));
      uploaded = await prepareUploads(env, store);
      await commitStore(snapshot, store);
      if (authenticated?.actor.workspace_role === 'owner') { const cleanup = retryCleanup(env).catch(() => {}); if (executionContext?.waitUntil) executionContext.waitUntil(cleanup); else await cleanup; }
      if (res.writableEnded) return new Response(res.body, { status: res.statusCode, headers: res.headers });
      const status = result?.__status ?? 200; if (result?.__status) delete result.__status;
      return Response.json(result, { status, headers: res.headers });
    } catch (error) {
      if (uploaded.length && error.definiteRollback) await cleanupKnownRollback(env, uploaded);
      // Unknown commit outcomes retain their pre-registered cleanup jobs. A
      // delayed reconciliation checks D1 references before deleting R2 bytes.
      if (error.code === 'REVISION_CONFLICT' && attempt < 2) continue;
      if (authenticationRequest && error.status >= 400 && error.status !== 429 && snapshot && kernel && req) {
        try { const fresh = await readSnapshot(env.DB), counterStore = new MemoryStore(fresh, { bucket: env.BUCKET }); createKernel(counterStore).authFailure(req); await commitStore(fresh, counterStore); } catch {}
      }
      const status = error.status ?? 503;
      return Response.json({ error: error.status ? error.message : '服务暂时不可用，请重试', code: error.status ? error.code : 'INTERNAL_ERROR', ...(error.details ? { details: error.details } : {}) }, { status, headers: commonHeaders });
    }
  }
}
