/**
 * 迁移演练（ADR-023 M1–M8）：先在 **数据库副本** 上跑一遍 0007 分类统一迁移，
 * 用 ADR 验收查询核对对象数、分类分布、自由值归宿、外键与权限键，再决定是否
 * 对真实库执行。整个过程不改源库；备份用 `VACUUM INTO`，WAL 里未 checkpoint
 * 的写入也会一起落到备份文件。
 *
 * 用法：
 *   node scripts/rehearse-categories-migration.mjs                    # 演练 data/app.db 与 data/dev.db
 *   node scripts/rehearse-categories-migration.mjs path/to/app.db     # 只演练指定库
 *
 * 产物：data/backups/<时间戳>/<库名>.db（备份）与同名 .report.json（报告）。
 * 演练副本放在系统临时目录，结束后删除；备份永远保留。
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const migrationsFolder = path.resolve("drizzle");
const backupRoot = path.resolve("data", "backups", timestamp());
const sources = process.argv.length > 2 ? process.argv.slice(2) : ["data/app.db", "data/dev.db"];

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function count(sqlite, sql, params = []) {
  try {
    return sqlite.prepare(sql).get(...params)?.n ?? 0;
  } catch {
    return "n/a";
  }
}

function backup(source, target) {
  mkdirSync(path.dirname(target), { recursive: true });

  // VACUUM INTO 生成一致快照，且备份文件不带 WAL 旁文件。
  const sqlite = new Database(source, { readonly: true });
  try {
    sqlite.prepare("VACUUM INTO ?").run(target);
  } finally {
    sqlite.close();
  }
}

function rehearse(source) {
  const name = path.basename(source);
  const backupFile = path.join(backupRoot, name);
  backup(source, backupFile);

  const work = path.join(tmpdir(), `pakp-categories-rehearsal-${process.pid}-${name}`);
  copyFileSync(backupFile, work);

  const sqlite = new Database(work);
  const db = drizzle(sqlite);
  const failures = [];

  const snapshot = () => ({
    objects: count(sqlite, "select count(*) as n from objects"),
    works: count(sqlite, "select count(*) as n from objects where type = 'work'"),
    assets: count(sqlite, "select count(*) as n from objects where type = 'asset'"),
    tags: count(sqlite, "select count(*) as n from tags"),
    objectTags: count(sqlite, "select count(*) as n from object_tags"),
    categories: count(sqlite, "select count(*) as n from categories"),
  });

  const before = {
    ...snapshot(),
    formatDistribution: safeAll(
      sqlite,
      "select coalesce(format, '(null)') as code, count(*) as n from objects where type = 'work' group by format order by code",
    ),
    categoriesJson: safeAll(
      sqlite,
      "select categories, count(*) as n from objects where trim(coalesce(categories, '[]')) not in ('', '[]') group by categories",
    ),
  };

  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = OFF");
  let migrated = false;

  try {
    migrate(db, { migrationsFolder });
    migrated = true;
    // 幂等：再跑一次不应改变任何数据。
    migrate(db, { migrationsFolder });
  } finally {
    sqlite.pragma("foreign_keys = ON");
  }

  const after = {
    ...snapshot(),
    distribution: safeAll(
      sqlite,
      `select coalesce(c.label, '(null)') as label, o.category_code as code, count(*) as n
       from objects o left join categories c on c.code = o.category_code
       group by o.category_code order by label`,
    ),
    unreferencedCategories: safeAll(
      sqlite,
      `select c.code, c.label from categories c
       where not exists (select 1 from objects o where o.category_code = c.code)`,
    ),
    legacyBackupRows: count(sqlite, "select count(*) as n from objects_category_legacy_backup"),
    permissions: safeAll(sqlite, "select key, label from permissions order by key"),
    categoryGrants: safeAll(
      sqlite,
      "select role_key from role_permissions where permission_key = 'vocabulary:category:write' order by role_key",
    ),
    foreignKeyCheck: sqlite.pragma("foreign_key_check").length,
  };

  // ---- ADR 验收查询 -------------------------------------------------------
  const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures.push({ label, actual, expected });
  };

  check("对象总数不变", after.objects, before.objects);
  check("作品没有空分类", count(sqlite, "select count(*) as n from objects where type = 'work' and category_code is null"), 0);
  check(
    "没有失联的分类码",
    count(
      sqlite,
      `select count(*) as n from objects o
       where o.category_code is not null
         and not exists (select 1 from categories c where c.code = o.category_code)`,
    ),
    0,
  );
  check(
    "分类 normalized 唯一",
    count(
      sqlite,
      "select count(*) as n from (select normalized from categories group by normalized having count(*) > 1)",
    ),
    0,
  );
  check(
    "自由值都有归宿（分类或标签）",
    count(
      sqlite,
      `select count(*) as n from (
         select distinct lower(trim(j.value)) as norm
         from objects_category_legacy_backup b, json_each(b.categories) j
         where trim(j.value) <> ''
       ) v
       where not exists (select 1 from categories c where c.normalized = v.norm)
         and not exists (select 1 from tags t where t.normalized = v.norm)`,
    ),
    0,
  );
  check(
    "作品旧 format 都在分类词表里",
    count(
      sqlite,
      `select count(*) as n from objects_category_legacy_backup b
       where b.format is not null
         and not exists (select 1 from categories c where c.code = b.format)`,
    ),
    0,
  );
  check("旧值留档行数等于对象数", after.legacyBackupRows, before.objects);
  check("外键自检为空", after.foreignKeyCheck, 0);
  check(
    "权限键已改名",
    after.permissions.filter((row) => row.key.includes("vocabulary:")),
    [
      { key: "vocabulary:category:write", label: "管理分类词表" },
      { key: "vocabulary:tag:write", label: "管理标签词表" },
    ],
  );
  check("分类权限授予 owner/admin", after.categoryGrants.map((row) => row.role_key), ["admin", "owner"]);

  const report = {
    source: path.resolve(source),
    backup: backupFile,
    backupSizeKb: Math.round(statSync(backupFile).size / 1024),
    rehearsalCopy: work,
    migrated,
    before,
    after,
    failures,
    ok: failures.length === 0,
  };

  sqlite.close();
  rmSync(work, { force: true });
  for (const suffix of ["-wal", "-shm"]) rmSync(work + suffix, { force: true });

  writeFileSync(
    path.join(backupRoot, `${name}.report.json`),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  return report;
}

function safeAll(sqlite, sql) {
  try {
    return sqlite.prepare(sql).all();
  } catch {
    return "n/a";
  }
}

let failed = false;

for (const source of sources) {
  if (!existsSync(source)) {
    console.error(`跳过（不存在）：${source}`);
    continue;
  }

  const report = rehearse(source);
  if (!report.ok) failed = true;

  console.log(JSON.stringify(report, null, 2));
}

process.exit(failed ? 2 : 0);
