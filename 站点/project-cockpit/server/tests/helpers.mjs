import { DatabaseSync } from 'node:sqlite';
import { Buffer } from 'node:buffer';
import { TABLES, PRIMARY_KEYS } from '../memory-store.mjs';

// Test-only D1 adapter: the real SQLite engine runs each D1 batch inside a
// transaction, including constraints and fault-injection triggers. No SQL mock
// invents success, and no test route is present in the deployed worker.
export function createTestBindings() {
  const db = new DatabaseSync(':memory:');
  for (const [table, columns] of Object.entries(TABLES)) {
    const keys = PRIMARY_KEYS[table];
    const integer = new Set(['expires', 'version', 'used', 'revoked', 'failures', 'reset_at', 'size']);
    db.exec(`CREATE TABLE ${table}(${columns.map(column => `${column} ${integer.has(column) ? 'INTEGER' : 'TEXT'}${['project_id','kind','object_id','deleted_at'].includes(column) ? '' : ' NOT NULL'}`).join(',')}, PRIMARY KEY(${keys.join(',')}))`);
  }
  db.exec('CREATE UNIQUE INDEX users_email ON users(email); CREATE UNIQUE INDEX invitations_token ON invitations(token_hash); CREATE UNIQUE INDEX files_object ON files(object_key); CREATE TABLE cloud_revision(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL); CREATE TABLE upload_cleanup(object_key TEXT PRIMARY KEY,next_attempt_at INTEGER NOT NULL,attempts INTEGER NOT NULL,created_at TEXT NOT NULL)');
  const binding = {
    sessions: [], failNextBatch: null, afterBatch: null,
    withSession(bookmark) { this.sessions.push(bookmark); return this; },
    prepare(sql) {
      let values = [];
      const statement = {
        sql,
        bind(...args) { values = args; return this; },
        _execute() {
          const query = db.prepare(sql);
          if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return { success: true, results: query.all(...values).map(row => ({ ...row })), meta: {} };
          return { success: true, results: [], meta: query.run(...values) };
        },
        async all() { return this._execute(); },
        async first(column) { const row = this._execute().results[0]; return column ? row?.[column] ?? null : row ?? null; },
        async run() { return this._execute(); },
      };
      return statement;
    },
    async batch(statements) {
      if (this.failNextBatch) { const error = this.failNextBatch; this.failNextBatch = null; throw error; }
      db.exec('BEGIN'); let results;
      try { results = statements.map(statement => statement._execute()); db.exec('COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
      if (this.afterBatch) await this.afterBatch(statements, results);
      return results;
    },
  };
  const objects = new Map();
  const bucket = {
    failPut: false, failDelete: false, objects,
    async put(key, value) { if (this.failPut) throw new Error('injected R2 failure'); objects.set(key, Buffer.from(value)); return { key }; },
    async get(key) { const value = objects.get(key); if (!value) return null; return { body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(value)); controller.close(); } }), async arrayBuffer() { return Uint8Array.from(value).buffer; } }; },
    async delete(key) { if (this.failDelete) throw new Error('injected cleanup failure'); objects.delete(key); },
  };
  return { db, binding, bucket, env: { DB: binding, BUCKET: bucket, BOOTSTRAP_TOKEN: 'Cloud-test-bootstrap-256bit-token-'.repeat(2) } };
}
