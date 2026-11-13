import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import * as schema from "./schema";
import { normalizeSearchText } from "../../lib/search-query";

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

/** 迁移文件里声明的总条数（drizzle journal）。 */
function journalEntries(migrationsFolder: string): number {
  const raw = readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8");
  const journal = JSON.parse(raw) as { entries?: unknown[] };
  return journal.entries?.length ?? 0;
}

/** 已经应用过的迁移条数；迁移表还不存在时视为 0。 */
function appliedMigrations(sqlite: Database.Database): number {
  try {
    const row = sqlite.prepare("select count(*) as count from __drizzle_migrations").get() as
      | { count: number }
      | undefined;
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

/**
 * 有未应用迁移时先备份整库（ADR-016 风险 R2）。
 * `VACUUM INTO` 生成一致快照，且不会把 -wal 里未落盘的数据漏掉。
 */
function backupBeforeMigrate(sqlite: Database.Database, file: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${path.resolve(file)}.bak-${stamp}`;
  sqlite.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  return target;
}

/**
 * 回填检索影子列（ADR-024 迁移 0008）。
 *
 * SQLite 没有 NFKC，只能由 JS 用同一个 `normalizeSearchText()` 回填；
 * 条件只挑 `title_norm` 为空的行，重复执行无副作用。写入路径由
 * `sqlite-object-repository` 负责，这里只补齐迁移前的存量。
 */
export function backfillSearchNorm(sqlite: Database.Database): number {
  // 只迁移到 0007 的旧库没有影子列；用 pragma 判断，避免 backfill 反过来
  // 让「演练到中间版本」的数据库打不开。
  const hasColumn = sqlite
    .prepare("select 1 as ok from pragma_table_info('objects') where name = 'title_norm'")
    .get();

  if (!hasColumn) return 0;

  const rows = sqlite
    .prepare(
      `select id, title, description from objects
        where title_norm is null
           or (description is not null and description_norm is null)`,
    )
    .all() as { id: string; title: string; description: string | null }[];

  if (rows.length === 0) return 0;

  const update = sqlite.prepare(
    "update objects set title_norm = ?, description_norm = ? where id = ?",
  );
  const run = sqlite.transaction(
    (items: { id: string; title: string; description: string | null }[]) => {
      for (const row of items) {
        update.run(
          normalizeSearchText(row.title),
          row.description === null ? null : normalizeSearchText(row.description),
          row.id,
        );
      }
    },
  );
  run(rows);

  return rows.length;
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

  // WAL 提升并发读；busy_timeout 缓解写锁冲突。外键开关见下方迁移分支。
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");

  const db = drizzle(sqlite, { schema });

  if (shouldMigrate) {
    const pending = appliedMigrations(sqlite) < journalEntries(migrationsFolder);

    if (pending && file !== ":memory:") {
      const backup = backupBeforeMigrate(sqlite, file);
      console.info(`[db] 迁移前已备份：${backup}`);
    }

    // SQLite 的 `PRAGMA foreign_keys` 在事务内是空操作，而 drizzle 把整批迁移包在一个
    // BEGIN 里——重建 objects 表会先 DROP，被 library_events 的外键挡住（ADR-016 第 8 条，
    // 已实测）。因此开关必须放在 migrate() 外层；迁移期无并发写（本地启动期），窗口安全。
    sqlite.pragma("foreign_keys = OFF");

    try {
      migrate(db, { migrationsFolder });
    } finally {
      sqlite.pragma("foreign_keys = ON");
    }

    // 0008 起有检索影子列；存量行用 TS 归一化函数回填（SQLite 无 NFKC）。
    backfillSearchNorm(sqlite);

    // 重建表之后必须自证没有留下孤儿外键，非空即拒绝启动。
    const violations = sqlite.pragma("foreign_key_check") as unknown[];

    if (Array.isArray(violations) && violations.length > 0) {
      throw new Error(
        `迁移后外键校验失败（foreign_key_check 返回 ${violations.length} 条），请用备份恢复数据库`,
      );
    }
  } else {
    sqlite.pragma("foreign_keys = ON");
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
