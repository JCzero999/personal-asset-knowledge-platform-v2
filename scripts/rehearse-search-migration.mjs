/**
 * 迁移演练（ADR-024 第 2 条）：先在 **数据库副本** 上跑一遍 0008 检索影子列迁移，
 * 核对对象数、影子列回填、索引与外键，再决定是否对真实库执行。
 *
 * 0008 是纯加列 + 加索引，`ALTER TABLE ... ADD COLUMN` 不需要重建表；
 * 唯一不能在 SQL 里做的是 NFKC 归一化，由应用启动时的 `backfillSearchNorm`
 * 用 TS 函数补齐——这里用同一个算法先演练一遍，确认存量行都能填满。
 *
 * 用法：
 *   node scripts/rehearse-search-migration.mjs                 # 演练 data/app.db 与 data/dev.db
 *   node scripts/rehearse-search-migration.mjs path/to/app.db  # 只演练指定库
 *
 * 产物：data/backups/<时间戳>/<库名>.db 与同名 .report.json。源库只读。
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const migrationsFolder = path.resolve("drizzle");
const backupRoot = path.resolve("data", "backups", timestamp());
const sources = process.argv.length > 2 ? process.argv.slice(2) : ["data/app.db", "data/dev.db"];

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/** 与 src/lib/search-query.ts 的 normalizeSearchText 完全一致。 */
function normalizeSearchText(raw) {
  return String(raw).normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function count(sqlite, sql) {
  try {
    return sqlite.prepare(sql).get()?.n ?? 0;
  } catch {
    return "n/a";
  }
}

function backup(source, target) {
  mkdirSync(path.dirname(target), { recursive: true });
  const sqlite = new Database(source, { readonly: true });
  try {
    // 一致快照，WAL 里未 checkpoint 的写入也会落到备份文件。
    sqlite.prepare("VACUUM INTO ?").run(target);
  } finally {
    sqlite.close();
  }
}

function snapshot(sqlite) {
  return {
    objects: count(sqlite, "select count(*) as n from objects"),
    works: count(sqlite, "select count(*) as n from objects where type = 'work'"),
    assets: count(sqlite, "select count(*) as n from objects where type = 'asset'"),
    tags: count(sqlite, "select count(*) as n from tags"),
    objectTags: count(sqlite, "select count(*) as n from object_tags"),
    migrations: count(sqlite, "select count(*) as n from __drizzle_migrations"),
  };
}

function backfill(sqlite) {
  const rows = sqlite
    .prepare(
      `select id, title, description from objects
        where title_norm is null
           or (description is not null and description_norm is null)`,
    )
    .all();
  const update = sqlite.prepare(
    "update objects set title_norm = ?, description_norm = ? where id = ?",
  );
  const run = sqlite.transaction((items) => {
    for (const row of items) {
      update.run(
        normalizeSearchText(row.title),
        row.description === null ? null : normalizeSearchText(row.description),
        row.id,
      );
    }
  });
  run(rows);
  return rows.length;
}

function rehearse(source) {
  const name = path.basename(source);
  const backupFile = path.join(backupRoot, name);
  backup(source, backupFile);

  const work = path.join(tmpdir(), `pakp-search-rehearsal-${process.pid}-${name}`);
  copyFileSync(backupFile, work);

  const sqlite = new Database(work);
  const failures = [];
  let before;
  let after;

  try {
    before = snapshot(sqlite);

    sqlite.pragma("foreign_keys = OFF");
    try {
      migrate(drizzle(sqlite), { migrationsFolder });
    } finally {
      sqlite.pragma("foreign_keys = ON");
    }

    const backfilled = backfill(sqlite);
    const violations = sqlite.pragma("foreign_key_check");
    after = {
      ...snapshot(sqlite),
      backfilled,
      columns: sqlite
        .prepare("select name from pragma_table_info('objects') where name in ('title_norm','description_norm')")
        .all()
        .map((row) => row.name),
      index: sqlite
        .prepare("select name from sqlite_master where type = 'index' and name = 'objects_owner_scope_idx'")
        .get()?.name ?? null,
      missingNorms: count(sqlite, "select count(*) as n from objects where title_norm is null"),
      descriptionMismatch: count(
        sqlite,
        `select count(*) as n from objects
          where (description is null and description_norm is not null)
             or (description is not null and description_norm is null)`,
      ),
      foreignKeyCheck: Array.isArray(violations) ? violations.length : "n/a",
      sample: sqlite
        .prepare("select title, description, title_norm from objects where title_norm is not null limit 3")
        .all(),
    };

    if (before.objects !== after.objects) failures.push("对象数在迁移中发生变化");
    if (after.columns.length !== 2) failures.push("影子列缺失");
    if (after.index !== "objects_owner_scope_idx") failures.push("缺少 owner/scope 索引");
    if (after.missingNorms !== 0) failures.push(`仍有 ${after.missingNorms} 行 title_norm 为空`);
    if (after.descriptionMismatch !== 0) failures.push("description 与影子列不一致");
    if (after.foreignKeyCheck !== 0) failures.push("foreign_key_check 非空");
    if (!["n/a", null].includes(after.descriptionMismatch)) {
      for (const row of after.sample) {
        if (normalizeSearchText(row.title) !== row.title_norm) {
          failures.push(`样品归一化不一致：${row.title}`);
          break;
        }
      }
    }
  } finally {
    sqlite.close();
    rmSync(work, { force: true });
  }

  const report = {
    source: path.resolve(source),
    backup: backupFile,
    backupSizeKb: Math.round(readFileSync(backupFile).length / 1024),
    before,
    after,
    failures,
    ok: failures.length === 0,
  };

  writeFileSync(path.join(backupRoot, `${name}.report.json`), JSON.stringify(report, null, 2));

  return report;
}

for (const source of sources) {
  const report = rehearse(source);
  console.log(
    `[rehearse] ${report.source} → ${report.ok ? "OK" : "FAILED"}`,
    JSON.stringify({ before: report.before, after: report.after }),
  );

  if (!report.ok) {
    console.error(`[rehearse] 失败项：${report.failures.join("；")}`);
    process.exitCode = 1;
  }
}

console.log(`[rehearse] 备份与报告：${backupRoot}`);
