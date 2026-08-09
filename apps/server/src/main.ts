import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppDatabase } from './db.js';
import { buildApp } from './app.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../../..');
const databasePath = process.env.DATABASE_PATH ?? resolve(projectRoot, 'data/picknext.db');
mkdirSync(dirname(databasePath), { recursive: true });

const database = new AppDatabase(databasePath, resolve(projectRoot, 'migrations'));
const app = await buildApp(
  process.env.NODE_ENV === 'development'
    ? { db: database.db, devWebRoot: resolve(projectRoot, 'apps/web') }
    : { db: database.db, webRoot: resolve(projectRoot, 'apps/web/dist') }
);

const shutdown = async () => {
  await app.close();
  database.close();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  await app.listen({ host: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 5560) });
  app.log.info('PickNext 已启动');
} catch (error) {
  app.log.error(error, 'PickNext 启动失败，请检查端口和数据目录权限');
  database.close();
  process.exit(1);
}
