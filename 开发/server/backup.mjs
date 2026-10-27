import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function backupDatabase(source, destination) {
  const input = resolve(source);
  const output = resolve(destination);
  if (!existsSync(input)) throw new Error('待备份的数据库不存在');
  if (existsSync(output)) throw new Error('目标文件已存在；备份不会覆盖已有文件');
  mkdirSync(dirname(output), { recursive: true });
  const db = new DatabaseSync(input);
  try { db.exec('PRAGMA busy_timeout=10000'); db.prepare('VACUUM INTO ?').run(output); } finally { db.close(); }
  const check = new DatabaseSync(output, { readOnly: true });
  try { const result = check.prepare('PRAGMA integrity_check').get(); if (Object.values(result)[0] !== 'ok') throw new Error('备份完整性检查失败'); } finally { check.close(); }
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = process.argv[2];
  const destination = process.argv[3];
  if (!source || !destination) { console.error('用法：node server/backup.mjs <数据目录/cockpit.sqlite> <新备份文件.sqlite>'); process.exitCode = 1; }
  else { try { console.log(`备份完成且完整性检查通过：${backupDatabase(source, destination)}`); } catch (error) { console.error(error.message); process.exitCode = 1; } }
}
