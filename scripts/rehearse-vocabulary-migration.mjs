/**
 * 迁移演练（ADR-016 风险 R1/R2）：在 **数据库副本** 上跑一遍 0005 词表迁移，
 * 断言对象数、format 分布、外键自检都符合预期，不触碰源库。
 *
 * 用法：
 *   node scripts/rehearse-vocabulary-migration.mjs                    # 演练 data/app.db
 *   node scripts/rehearse-vocabulary-migration.mjs path/to/app.db     # 演练指定库
 *
 * 输出副本路径与前后指标；演练通过后再启动应用，由 openDatabase() 处理真实库。
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { copyFileSync, existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const source = path.resolve(process.argv[2] ?? "data/app.db");
const migrationsFolder = path.resolve("drizzle");
const work = `${source}.rehearsal-${Date.now()}.db`;

if (!existsSync(source)) {
  console.error(`源库不存在：${source}`);
  process.exit(1);
}

// WAL 库要连 -wal 一起复制，否则会漏掉未 checkpoint 的写入。
copyFileSync(source, work);
for (const suffix of ["-wal", "-shm"]) {
  if (existsSync(source + suffix)) copyFileSync(source + suffix, work + suffix);
}

const sqlite = new Database(work);
const db = drizzle(sqlite);

const snapshot = () => ({
  objects: sqlite.prepare("select count(*) as n from objects").get().n,
  works: sqlite.prepare("select count(*) as n from objects where type = 'work'").get().n,
  formats: sqlite
    .prepare("select format, count(*) as n from objects where type = 'work' group by format order by format")
    .all()
    .map((row) => `${row.format}:${row.n}`)
    .join(", "),
  tags: (() => {
    try {
      return sqlite.prepare("select count(*) as n from tags").get().n;
    } catch {
      return "n/a";
    }
  })(),
});

const before = snapshot();
const startedAt = Date.now();

sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = OFF");
let migrated = false;

try {
  migrate(db, { migrationsFolder });
  migrated = true;
} finally {
  sqlite.pragma("foreign_keys = ON");
}

const violations = sqlite.pragma("foreign_key_check");
const after = snapshot();
const elapsed = Date.now() - startedAt;
const sizeKb = Math.round(statSync(work).size / 1024);

console.log(
  JSON.stringify(
    {
      source,
      work,
      migrated,
      elapsedMs: elapsed,
      sizeKb,
      before,
      after,
      foreignKeyCheck: violations.length,
      formatRows: sqlite
        .prepare("select code, label, sort_order, state from work_formats order by sort_order")
        .all(),
      tagRows: sqlite.prepare("select label, normalized from tags order by label").all(),
      objectTags: (() => {
        try {
          return sqlite.prepare("select count(*) as n from object_tags").get().n;
        } catch {
          return "n/a";
        }
      })(),
    },
    null,
    2,
  ),
);

sqlite.close();
rmSync(work, { force: true });
for (const suffix of ["-wal", "-shm"]) rmSync(work + suffix, { force: true });

process.exit(violations.length === 0 ? 0 : 2);
