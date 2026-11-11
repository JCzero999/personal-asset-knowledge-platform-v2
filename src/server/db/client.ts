import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import * as schema from "./schema";

/**
 * SQLite 连接。
 *
 * 运行时只走 `getDb()` 单例（挂在 globalThis 上，避免 Next dev 的 HMR
 * 每次重新求值模块都开一条新连接）；测试里用 `openDatabase` 自己建内存库，
 * 不触碰真实文件。
 */

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  db: AppDatabase;
  /** 底层 better-sqlite3 连接；只在确实需要原样 SQL（例如测试约束）时使用。 */
  sqlite: Database.Database;
  /** 关闭底层连接；内存库测试结束时调用。 */
  close: () => void;
}

/**
 * 迁移目录默认跟随进程工作目录，但允许用 MIGRATIONS_FOLDER 覆盖：
 * 以 `next start` 从其他目录启动时，cwd/drizzle 可能不存在。
 */
function defaultMigrationsFolder(): string {
  const configured = process.env.MIGRATIONS_FOLDER?.trim();
  return path.resolve(configured || path.resolve(process.cwd(), "drizzle"));
}

export interface OpenDatabaseOptions {
  /** 文件路径，或 `:memory:`。 */
  file: string;
  /** 是否执行迁移，默认 true。 */
  migrate?: boolean;
  migrationsFolder?: string;
}

export function openDatabase({
  file,
  migrate: shouldMigrate = true,
  migrationsFolder = defaultMigrationsFolder(),
}: OpenDatabaseOptions): DatabaseHandle {
  if (file !== ":memory:") {
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }

  if (shouldMigrate && !existsSync(path.join(migrationsFolder, "meta", "_journal.json"))) {
    throw new Error(
      `找不到迁移目录：${migrationsFolder}（可用 MIGRATIONS_FOLDER 指定仓库内的 drizzle 目录）`,
    );
  }

  const sqlite = new Database(file);

  // WAL 提升并发读；外键约束必须显式打开；busy_timeout 缓解写锁冲突。
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");

  const db = drizzle(sqlite, { schema });

  if (shouldMigrate) {
    migrate(db, { migrationsFolder });
  }

  return {
    db,
    sqlite,
    close: () => {
      sqlite.close();
    },
  };
}

const globalForDb = globalThis as unknown as {
  __appDatabase?: DatabaseHandle;
};

/** 应用运行时单例。数据库文件固定为 data/app.db（可用 DATABASE_PATH 覆盖）。 */
export function getDb(): AppDatabase {
  if (!globalForDb.__appDatabase) {
    const file = process.env.DATABASE_PATH ?? path.resolve(process.cwd(), "data", "app.db");
    globalForDb.__appDatabase = openDatabase({ file });
  }

  return globalForDb.__appDatabase.db;
}
