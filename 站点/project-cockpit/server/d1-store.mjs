import { TABLES, PRIMARY_KEYS } from './memory-store.mjs';

const safeColumn = name => '"' + name + '"';
export async function readSnapshot(binding) {
  const session = binding.withSession ? binding.withSession('first-primary') : binding;
  const names = Object.keys(TABLES);
  const results = await session.batch([session.prepare('SELECT revision FROM cloud_revision WHERE id=1'), ...names.map(table => session.prepare(`SELECT rowid AS __rowid,* FROM ${table} ORDER BY rowid`))]);
  return { session, revision: results[0].results?.[0]?.revision ?? null, tables: Object.fromEntries(names.map((name, index) => [name, results[index + 1].results ?? []])) };
}
export async function commitStore(snapshot, store) {
  const changes = store.changes();
  if (!changes.length) return;
  const session = snapshot.session;
  const guard = snapshot.revision == null ? session.prepare('INSERT INTO cloud_revision(id,revision) VALUES(1,1)') : session.prepare('UPDATE cloud_revision SET revision=CASE WHEN revision=? THEN revision+1 ELSE NULL END WHERE id=1').bind(snapshot.revision);
  const statements = [guard];
  for (const change of changes) {
    const columns = TABLES[change.table], keys = PRIMARY_KEYS[change.table];
    if (change.type === 'delete') statements.push(session.prepare(`DELETE FROM ${change.table} WHERE ${keys.map(key => safeColumn(key) + '=?').join(' AND ')}`).bind(...keys.map(key => change.row[key])));
    else {
      const encoded = JSON.stringify(change.row);
      if (new TextEncoder().encode(encoded).length > 1500000) throw Object.assign(new Error('单条数据超过云端存储上限'), { status: 413, code: 'ROW_TOO_LARGE', definiteRollback: true });
      const updates = columns.filter(column => !keys.includes(column)).map(column => `${safeColumn(column)}=excluded.${safeColumn(column)}`).join(',');
      statements.push(session.prepare(`INSERT INTO ${change.table}(${columns.map(safeColumn).join(',')}) VALUES(${columns.map(() => '?').join(',')}) ON CONFLICT(${keys.map(safeColumn).join(',')}) DO ${updates ? 'UPDATE SET ' + updates : 'NOTHING'}`).bind(...columns.map(column => change.row[column])));
    }
  }
  for (const objectKey of store.pendingFiles.keys()) statements.push(session.prepare('DELETE FROM upload_cleanup WHERE object_key=?').bind(objectKey));
  try { await session.batch(statements); }
  catch (error) {
    const message = String(error?.message ?? error);
    if (/cloud_revision\.(?:revision|id)/i.test(message)) throw Object.assign(new Error('数据已被其他请求更新，请重试'), { status: 409, code: 'REVISION_CONFLICT', definiteRollback: true });
    if (/constraint|SQLITE_|D1_EXEC_ERROR|D1_ERROR.*(?:syntax|no such|datatype)/i.test(message)) error.definiteRollback = true;
    throw error;
  }
}

export async function prepareUploads(env, store) {
  const uploaded = [];
  try {
    for (const [key, bytes] of store.pendingFiles) {
      // Register cleanup before the external write, so isolate termination also
      // leaves a durable reconciliation job. It is never a visible resource.
      await env.DB.prepare('INSERT INTO upload_cleanup(object_key,next_attempt_at,attempts,created_at) VALUES(?,?,0,?) ON CONFLICT(object_key) DO NOTHING').bind(key, Date.now() + 3600000, new Date().toISOString()).run();
      const result = await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: 'application/octet-stream' } });
      if (!result) throw new Error('私有文件上传未完成');
      uploaded.push(key);
    }
    return uploaded;
  } catch (error) { await cleanupKnownRollback(env, [...store.pendingFiles.keys()]); throw error; }
}
export async function cleanupKnownRollback(env, keys) {
  for (const key of keys) {
    try { await env.BUCKET.delete(key); await env.DB.prepare('DELETE FROM upload_cleanup WHERE object_key=?').bind(key).run(); }
    catch { /* durable upload_cleanup row remains for later retry */ }
  }
}
export async function retryCleanup(env, maximum = 2) {
  const session = env.DB.withSession ? env.DB.withSession('first-primary') : env.DB;
  const pending = await session.prepare('SELECT * FROM upload_cleanup WHERE next_attempt_at<=? ORDER BY next_attempt_at LIMIT ?').bind(Date.now(), maximum).all();
  for (const job of pending.results ?? []) {
    try {
      const reference = await session.prepare('SELECT id FROM files WHERE object_key=?').bind(job.object_key).first();
      if (!reference) await env.BUCKET.delete(job.object_key);
      await session.prepare('DELETE FROM upload_cleanup WHERE object_key=?').bind(job.object_key).run();
    } catch { await session.prepare('UPDATE upload_cleanup SET attempts=attempts+1,next_attempt_at=? WHERE object_key=?').bind(Date.now() + 300000, job.object_key).run().catch(() => {}); }
  }
}
