import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/server/db/client";
import { SqliteObjectRepository } from "../../src/server/repositories/sqlite-object-repository";

/**
 * 0011 迁移（v2.1 §2/§4）：在只应用到 0010 的旧库上造出内库/外库资产，
 * 再用完整迁移升级，验证：
 *   - objects 新增 5 列，存量行取默认值（锁定 false、快照 NULL）；
 *   - asset_usage_events / value_assessment_history 两表与索引存在；
 *   - 每个已有 value_level 的内库资产补一条 trigger=migration 的历史；
 *   - 外库资产不补；
 *   - 重复打开不会重复回填。
 */

const root = process.cwd();
const fullFolder = path.join(root, "drizzle");
const workDir = mkdtempSync(path.join(tmpdir(), "pakp-usage-migration-"));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** 复制 0000–0010 与截断后的 journal，得到一个「0011 之前」的库。 */
function legacyMigrations(dir: string): string {
  mkdirSync(path.join(dir, "meta"), { recursive: true });

  const journal = JSON.parse(
    readFileSync(path.join(fullFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> };

  const legacy = { ...journal, entries: journal.entries.slice(0, 11) };

  writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify(legacy));

  for (const entry of legacy.entries) {
    copyFileSync(path.join(fullFolder, `${entry.tag}.sql`), path.join(dir, `${entry.tag}.sql`));
  }

  return dir;
}

const T1 = "2026-10-01T00:00:00.000Z";
const T2 = "2026-11-01T09:15:00.000Z";

function columns(sqlite: ReturnType<typeof openDatabase>["sqlite"], table: string) {
  return (sqlite.prepare(`pragma table_info(${table})`).all() as { name: string; dflt_value: string | null }[])
    .map((row) => row.name);
}

describe("0011 使用事件与价值历史迁移", () => {
  it("补列补表，并为内库存量资产评估一条 migration 历史", () => {
    const file = path.join(workDir, "legacy.db");
    const legacyFolder = legacyMigrations(path.join(workDir, "legacy-migrations"));
    const legacy = openDatabase({ file, migrationsFolder: legacyFolder });

    legacy.sqlite
      .prepare(
        `insert into objects
           (id, type, title, library, source, origin, category_code, priority,
            owner_sub, revision, created_at, updated_at,
            value_level, value_scores, value_assessed_at)
         values ('legacy_internal', 'asset', '旧内库资产', 'internal', 'handwritten',
                 'self', 'article', 'high', 'u1', 1, ?, ?, 'A', ?, ?)`,
      )
      .run(T1, T2, JSON.stringify({ dimensions: [], total: 17, source: "rule" }), T1);

    legacy.sqlite
      .prepare(
        `insert into objects
           (id, type, title, library, source, origin, category_code, priority,
            owner_sub, revision, created_at, updated_at, value_level)
         values ('legacy_external', 'asset', '旧外库资产', 'external', 'ai_extracted',
                 'self', 'article', 'medium', 'u1', 1, ?, ?, null)`,
      )
      .run(T1, T1);

    legacy.close();

    const upgraded = openDatabase({ file });
    const sqlite = upgraded.sqlite;

    for (const column of [
      "value_level_locked",
      "content_hash",
      "content_snapshot",
      "content_snapshot_at",
      "last_level_adjust_at",
    ]) {
      expect(columns(sqlite, "objects")).toContain(column);
    }

    const tables = (
      sqlite.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]
    ).map((row) => row.name);
    expect(tables).toContain("asset_usage_events");
    expect(tables).toContain("value_assessment_history");

    const internal = sqlite
      .prepare(
        "select value_level_locked, content_hash, content_snapshot, last_level_adjust_at from objects where id = ?",
      )
      .get("legacy_internal") as Record<string, unknown>;
    expect(internal).toEqual({
      value_level_locked: 0,
      content_hash: null,
      content_snapshot: null,
      last_level_adjust_at: null,
    });

    const history = sqlite
      .prepare(
        `select asset_id, assessed_by, trigger, value_level, prev_level, prev_scores, value_scores
         from value_assessment_history order by asset_id`,
      )
      .all() as Record<string, unknown>[];
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      asset_id: "legacy_internal",
      assessed_by: "migration",
      trigger: "migration",
      value_level: "A",
      prev_level: null,
      prev_scores: null,
    });
    expect(JSON.parse(String(history[0].value_scores))).toMatchObject({ total: 17 });

    // 重复打开不会二次回填。
    upgraded.close();
    const reopened = openDatabase({ file });
    const count = (
      reopened.sqlite.prepare("select count(*) as n from value_assessment_history").get() as { n: number }
    ).n;
    expect(count).toBe(1);
    reopened.close();
  });

  it("新建资产默认未锁定、无快照", async () => {
    const handle = openDatabase({ file: ":memory:" });
    const repo = new SqliteObjectRepository(handle.db);

    const asset = await repo.create({
      type: "asset",
      title: "新资产",
      library: "internal",
      source: "handwritten",
      ownerSub: "u1",
      now: T1,
    });

    expect(asset).toMatchObject({
      valueLevelLocked: false,
      contentHash: null,
      contentSnapshot: null,
      contentSnapshotAt: null,
      lastLevelAdjustAt: null,
    });
    handle.close();
  });
});
