import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * SQLite 备份与恢复检查能力。备份使用 SQLite 原生 backup API，避免直接复制 WAL
 * 文件造成不完整快照；恢复检查只读目标文件并执行 integrity_check，不修改线上库。
 */
export async function backupDatabase(source: string, target: string): Promise<void> {
  mkdirSync(dirname(target), { recursive: true });
  const database = new Database(source, { readonly: true });
  try {
    await database.backup(target);
  } finally {
    database.close();
  }
}

export function checkDatabase(source: string): string {
  const database = new Database(source, { readonly: true });
  try {
    return database.pragma('integrity_check', { simple: true }) as string;
  } finally {
    database.close();
  }
}

async function main(): Promise<void> {
  const [command, sourceArg, targetArg] = process.argv.slice(2);
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const source = resolve(sourceArg ?? process.env.DATABASE_PATH ?? resolve(projectRoot, 'data/picknext.db'));

  if (!command || !['backup', 'check'].includes(command)) {
    console.error('用法：node apps/server/dist/backup.js backup [源数据库] [备份文件] 或 check [数据库文件]');
    process.exitCode = 2;
    return;
  }

  if (command === 'backup') {
    const target = resolve(targetArg ?? `${source}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await backupDatabase(source, target);
    console.log(`SQLite 备份完成：${target}`);
    return;
  }

  const result = checkDatabase(source);
  if (result !== 'ok') {
    console.error(`SQLite 恢复检查失败：${result}`);
    process.exitCode = 1;
  } else {
    console.log(`SQLite 恢复检查通过：${source}`);
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main();
