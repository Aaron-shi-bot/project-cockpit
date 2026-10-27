import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

export const TABLES = {
  users: ['id', 'name', 'email', 'password_hash', 'workspace_role', 'status', 'version', 'time_zone'],
  sessions: ['token_hash', 'user_id', 'csrf', 'expires'],
  entities: ['kind', 'id', 'project_id', 'version', 'deleted_at', 'payload'],
  invitations: ['id', 'token_hash', 'email', 'payload', 'expires', 'used', 'revoked'],
  audit: ['id', 'project_id', 'actor_id', 'action', 'kind', 'object_id', 'created_at', 'details'],
  operations: ['user_id', 'key', 'request_hash', 'response'],
  login_attempts: ['key', 'failures', 'reset_at'],
  settings: ['key', 'value'],
  files: ['id', 'object_key', 'size', 'sha256', 'created_at'],
};
export const PRIMARY_KEYS = { users: ['id'], sessions: ['token_hash'], entities: ['id'], invitations: ['id'], audit: ['id'], operations: ['user_id', 'key'], login_attempts: ['key'], settings: ['key'], files: ['id'] };
const keyOf = (table, row) => JSON.stringify(PRIMARY_KEYS[table].map(key => row[key]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// This is a small repository facade for the kernel's fixed SQL vocabulary.
// It is NOT a SQL execution engine, and never opens SQLite or a filesystem.
// Unsupported statements fail closed; only the D1 persistence adapter runs SQL.
export class MemoryStore {
  constructor(snapshot, options = {}) {
    this.revision = snapshot.revision;
    this.rows = Object.fromEntries(Object.keys(TABLES).map(table => [table, structuredClone(snapshot.tables[table] ?? [])]));
    this.original = structuredClone(this.rows);
    this.pendingFiles = new Map();
    this.bucket = options.bucket;
  }
  stageFile(id, bytes) {
    const content = Buffer.from(bytes), objectKey = 'versions/' + id;
    this.pendingFiles.set(objectKey, content);
    this.rows.files.push({ id, object_key: objectKey, size: content.length, sha256: createHash('sha256').update(content).digest('hex'), created_at: new Date().toISOString(), __rowid: this.rows.files.length + 1 });
  }
  async fileObject(id) { const file = this.rows.files.find(row => row.id === id); return file ? this.bucket.get(file.object_key) : null; }
  async readFile(id) { const file = await this.fileObject(id); return file ? Buffer.from(await file.arrayBuffer()) : null; }
  changes() {
    const result = [];
    for (const [table, columns] of Object.entries(TABLES)) {
      const clean = row => Object.fromEntries(columns.map(column => [column, row[column] ?? null]));
      const before = new Map(this.original[table].map(row => [keyOf(table, row), clean(row)]));
      const after = new Map(this.rows[table].map(row => [keyOf(table, row), clean(row)]));
      for (const [key, row] of before) if (!after.has(key)) result.push({ table, type: 'delete', row });
      for (const [key, row] of after) if (!same(before.get(key), row)) result.push({ table, type: 'put', row });
    }
    return result;
  }
  prepare(source) {
    const sql = source.replace(/\s+/g, ' ').trim();
    let match;
    const tableRows = table => { if (!TABLES[table]) throw new Error('Unsupported repository table'); return this.rows[table]; };
    const predicate = (where, args, cursor = { value: 0 }) => {
      if (!where) return () => true;
      const tests = where.split(/ AND /i).map(condition => {
        const part = condition.trim().match(/^(\w+)\s*(IS NULL|<>|>=|<=|=|>|<)\s*(\?|'.*?'|\d+)?$/i);
        if (!part) throw new Error('Unsupported repository predicate');
        const [, column, rawOperator, expression] = part, operator = rawOperator.toUpperCase();
        const value = expression === '?' ? args[cursor.value++] : expression?.startsWith("'") ? expression.slice(1, -1) : expression == null ? null : Number(expression);
        return row => operator === 'IS NULL' ? row[column] == null : operator === '=' ? row[column] === value : operator === '<>' ? row[column] !== value : operator === '>' ? row[column] > value : operator === '<' ? row[column] < value : operator === '>=' ? row[column] >= value : row[column] <= value;
      });
      return row => tests.every(check => check(row));
    };
    if ((match = sql.match(/^SELECT (.+?) FROM (\w+)(?: WHERE (.*?))?(?: ORDER BY (.*?))?(?: LIMIT (\d+))?$/i))) {
      const [, projection, table, where, order, limit] = match;
      const select = args => {
        let rows = tableRows(table).filter(predicate(where, args));
        if (order) { const ordering = order.split(',').map(term => term.trim().split(/\s+/)); rows = [...rows].sort((a, b) => { for (const [column, direction] of ordering) { const key = column.toLowerCase() === 'rowid' ? '__rowid' : column; const av = a[key], bv = b[key]; const compared = av === bv ? 0 : av == null ? -1 : bv == null ? 1 : av < bv ? -1 : 1; if (compared) return direction?.toUpperCase() === 'DESC' ? -compared : compared; } return 0; }); }
        if (limit) rows = rows.slice(0, Number(limit));
        return rows.map(row => projection === '*' ? { ...row } : Object.fromEntries(projection.split(',').map(column => [column.trim(), row[column.trim()]])));
      };
      return { all: (...args) => select(args), get: (...args) => select(args)[0] };
    }
    if ((match = sql.match(/^INSERT INTO (\w+)(?:\(([^)]+)\))? VALUES\(([^)]+)\)(.*)$/i))) {
      const [, table, names, expressions, suffix] = match, columns = names ? names.split(',').map(name => name.trim()) : TABLES[table];
      tableRows(table);
      return { run: (...args) => {
        let cursor = 0;
        const row = { ...(table === 'users' ? { time_zone: 'Asia/Shanghai' } : {}) };
        expressions.split(',').forEach((expression, index) => { const value = expression.trim(); row[columns[index]] = value === '?' ? args[cursor++] : value.startsWith("'") ? value.slice(1, -1) : Number(value); });
        const rows = this.rows[table], existing = rows.findIndex(item => keyOf(table, item) === keyOf(table, row));
        if (existing >= 0 && !suffix.includes('ON CONFLICT')) throw new Error('Duplicate repository identity');
        row.__rowid = existing >= 0 ? rows[existing].__rowid : rows.reduce((maximum, item) => Math.max(maximum, item.__rowid ?? 0), 0) + 1;
        if (existing >= 0) rows[existing] = row; else rows.push(row);
        return { changes: 1 };
      } };
    }
    if ((match = sql.match(/^UPDATE (\w+) SET (.+?) WHERE (.+)$/i))) {
      const [, table, assignments, where] = match; tableRows(table);
      return { run: (...args) => {
        const cursor = { value: 0 };
        const writes = assignments.split(',').map(assignment => { const part = assignment.trim().match(/^(\w+)=(\?|'.*?'|\d+|\w+\+1)$/); if (!part) throw new Error('Unsupported repository assignment'); const [, column, expression] = part; const value = expression === '?' ? args[cursor.value++] : expression.startsWith("'") ? expression.slice(1, -1) : /^\d+$/.test(expression) ? Number(expression) : null; return { column, value, increment: expression.endsWith('+1') }; });
        const check = predicate(where, args, cursor); let count = 0;
        for (const row of this.rows[table]) if (check(row)) { for (const write of writes) row[write.column] = write.increment ? Number(row[write.column]) + 1 : write.value; count++; }
        return { changes: count };
      } };
    }
    if ((match = sql.match(/^DELETE FROM (\w+) WHERE (.+)$/i))) {
      const [, table, where] = match; tableRows(table);
      return { run: (...args) => { const check = predicate(where, args), previous = this.rows[table]; this.rows[table] = previous.filter(row => !check(row)); return { changes: previous.length - this.rows[table].length }; } };
    }
    throw new Error('Unsupported repository statement');
  }
}
