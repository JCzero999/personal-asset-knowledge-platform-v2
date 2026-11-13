import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/server/db/client";
import { SqliteObjectRepository } from "../../src/server/repositories/sqlite-object-repository";

/**
 * 迁移演练的自动化版本（ADR-016 R1/R2、ADR-023 M1–M8）：
 * 先在只应用到 0004 的旧结构上写入「带 tags / categories / format 的存量数据」，
 * 再用完整迁移升级，验证：
 *   - 作品分类 = 原 format；资产分类 = categories[0]（未命中的新建分类）；
 *   - 未成为分类的自由值转成标签，原标签一个不丢；
 *   - work_formats 退场，旧值留档在 objects_category_legacy_backup；
 *   - 权限键 vocabulary:format:write → vocabulary:category:write；
 *   - 外键自检干净，重复打开数据库不会二次执行。
 *
 * 这条用例同时覆盖「事务内外键开关」的回归：事务内 `PRAGMA foreign_keys=OFF`
 * 是空操作，重建 objects 会失败。
 */

const root = process.cwd();
const fullFolder = path.join(root, "drizzle");
const workDir = mkdtempSync(path.join(tmpdir(), "pakp-vocab-migration-"));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** 复制 0000–0004 与截断后的 journal，得到一个「迁移前」的库。 */
function legacyMigrations(dir: string): string {
  mkdirSync(path.join(dir, "meta"), { recursive: true });

  const journal = JSON.parse(readFileSync(path.join(fullFolder, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  const legacy = { ...journal, entries: journal.entries.slice(0, 5) };

  writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify(legacy));

  for (const entry of legacy.entries) {
    copyFileSync(
      path.join(fullFolder, `${entry.tag}.sql`),
      path.join(dir, `${entry.tag}.sql`),
    );
  }

  return dir;
}

describe("0005–0007 词表迁移", () => {
  it("分类统一、自由值转标签、外键自检为空、重复打开不重复执行", async () => {
    const file = path.join(workDir, "legacy.db");
    const legacy = openDatabase({ file, migrationsFolder: legacyMigrations(path.join(workDir, "legacy-migrations")) });

    const at = "2026-11-01T00:00:00.000Z";

    legacy.sqlite
      .prepare(
        `insert into objects
           (id, type, title, library, source, origin, categories, tags, priority,
            owner_sub, revision, created_at, updated_at)
         values ('legacy_asset', 'asset', '旧资产', 'internal', 'handwritten', 'self',
                 '[]', '["smoke","复盘"]', 'medium', 'u1', 1, ?, ?)`,
      )
      .run(at, at);

    // 资产的 categories[0] 不在内置词表里：迁移后应新建分类「方法论」，「复盘」转标签。
    legacy.sqlite
      .prepare(
        `insert into objects
           (id, type, title, library, source, origin, categories, tags, priority,
            owner_sub, revision, created_at, updated_at)
         values ('legacy_asset2', 'asset', '旧资产二', 'external', 'handwritten', 'self',
                 '["方法论","复盘"]', '[]', 'medium', 'u1', 1, ?, ?)`,
      )
      .run(at, at);

    legacy.sqlite
      .prepare(
        `insert into objects
           (id, type, title, library, source, origin, categories, tags, priority,
            owner_sub, revision, created_at, updated_at, format, status)
         values ('legacy_work', 'work', '旧作品', 'external', 'handwritten', 'self',
                 '["课程","写作"]', '["smoke"]', 'medium', 'u1', 1, ?, ?, 'article', 'draft')`,
      )
      .run(at, at);

    // 旧结构里 tags / categories 还是 JSON 列，format 仍在。
    const legacyColumns = legacy.sqlite
      .prepare("select name from pragma_table_info('objects')")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(legacyColumns).toEqual(expect.arrayContaining(["tags", "categories", "format"]));

    legacy.close();

    // 用完整迁移升级同一个文件。
    const upgraded = openDatabase({ file });

    try {
      const counts = upgraded.sqlite
        .prepare("select type, count(*) as n from objects group by type order by type")
        .all();
      expect(counts).toEqual([
        { type: "asset", n: 2 },
        { type: "work", n: 1 },
      ]);

      // 每个作品都有分类，且所有分类码都能在词表里找到。
      expect(
        upgraded.sqlite
          .prepare("select count(*) as n from objects where type = 'work' and category_code is null")
          .get(),
      ).toEqual({ n: 0 });
      expect(
        upgraded.sqlite
          .prepare(
            `select count(*) as n from objects o
             where o.category_code is not null
               and not exists (select 1 from categories c where c.code = o.category_code)`,
          )
          .get(),
      ).toEqual({ n: 0 });

      // work_formats 已退场。
      const legacyTable = upgraded.sqlite
        .prepare("select name from sqlite_master where type = 'table' and name = 'work_formats'")
        .get();
      expect(legacyTable).toBeUndefined();

      // 7 个内置分类原样保留，另加自由值新建的「方法论」。
      const categories = upgraded.sqlite
        .prepare("select code, label, state, is_system from categories order by sort_order, code")
        .all() as Array<{ code: string; label: string; state: string; is_system: number }>;
      expect(categories).toHaveLength(8);
      expect(categories[0]).toMatchObject({ code: "article", label: "文章", state: "active" });
      expect(categories.filter((row) => row.is_system === 1)).toHaveLength(7);

      const method = categories.find((row) => row.label === "方法论");
      expect(method).toBeDefined();
      expect(method?.code).toMatch(/^c-[0-9a-f]{8}$/);
      expect(method?.is_system).toBe(0);

      // 旧值留档：三列原样保留，便于回滚与人工重建。
      const backup = upgraded.sqlite
        .prepare(
          `select object_id, categories, primary_category, format
           from objects_category_legacy_backup order by object_id`,
        )
        .all();
      expect(backup).toEqual([
        { object_id: "legacy_asset", categories: "[]", primary_category: null, format: null },
        {
          object_id: "legacy_asset2",
          categories: '["方法论","复盘"]',
          primary_category: null,
          format: null,
        },
        {
          object_id: "legacy_work",
          categories: '["课程","写作"]',
          primary_category: null,
          format: "article",
        },
      ]);

      // 标签：原标签 + 转义过来的自由值。
      const tagRows = upgraded.sqlite
        .prepare("select label, normalized from tags order by normalized")
        .all();
      expect(tagRows).toEqual([
        { label: "smoke", normalized: "smoke" },
        { label: "写作", normalized: "写作" },
        { label: "复盘", normalized: "复盘" },
        { label: "课程", normalized: "课程" },
      ]);

      // legacy_asset：两个原标签；legacy_asset2：「复盘」转标签；legacy_work：「写作」转标签。
      const links = upgraded.sqlite
        .prepare(
          `select o.id, t.label from object_tags ot
           join objects o on o.id = ot.object_id
           join tags t on t.id = ot.tag_id
           order by o.id, t.normalized`,
        )
        .all();
      expect(links).toEqual([
        { id: "legacy_asset", label: "smoke" },
        { id: "legacy_asset", label: "复盘" },
        { id: "legacy_asset2", label: "复盘" },
        { id: "legacy_work", label: "smoke" },
        { id: "legacy_work", label: "写作" },
        { id: "legacy_work", label: "课程" },
      ]);

      // 权限键改名，角色授权不丢。
      const permissionKeys = upgraded.sqlite
        .prepare("select key from permissions order by key")
        .all()
        .map((row) => (row as { key: string }).key);
      expect(permissionKeys).toContain("vocabulary:category:write");
      expect(permissionKeys).not.toContain("vocabulary:format:write");
      expect(permissionKeys).toHaveLength(15);

      const categoryGrants = upgraded.sqlite
        .prepare("select role_key from role_permissions where permission_key = 'vocabulary:category:write' order by role_key")
        .all()
        .map((row) => (row as { role_key: string }).role_key);
      expect(categoryGrants).toEqual(["admin", "owner"]);

      expect(upgraded.sqlite.pragma("foreign_key_check")).toEqual([]);

      const repo = new SqliteObjectRepository(upgraded.db);
      const asset = await repo.findById("legacy_asset");
      const asset2 = await repo.findById("legacy_asset2");
      const work = await repo.findById("legacy_work");

      expect(asset?.category).toBeNull();
      expect(asset?.tags).toEqual(["smoke", "复盘"]);
      expect(asset2?.category).toBe(method?.code);
      expect(work?.category).toBe("article");
      // 「课程」命中内置分类标签，但它不是该作品的分类，按 M3 落成标签。
      expect(work?.tags).toEqual(["smoke", "写作", "课程"]);
    } finally {
      upgraded.close();
    }

    // 再次打开：迁移已记录，不会二次执行，数据不变。
    const reopened = openDatabase({ file });

    try {
      expect(
        reopened.sqlite.prepare("select count(*) as n from categories").get(),
      ).toEqual({ n: 8 });
      expect(reopened.sqlite.prepare("select count(*) as n from objects").get()).toEqual({ n: 3 });
      expect(reopened.sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally {
      reopened.close();
    }
  });
});
