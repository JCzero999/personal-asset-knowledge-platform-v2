import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/server/db/client";
import { SqliteObjectRepository } from "../../src/server/repositories/sqlite-object-repository";

/**
 * 0010 迁移演练（ADR-029）：在只应用到 0009 的旧库上造出
 * 「内库已实践作品 + 内库资产 + 外库资产」，再用完整迁移升级，验证：
 *   - 内库作品整体搬到外库、不归档、回指新资产，并留下 library_events；
 *   - 新资产 source_type = practiced_work、origin_work_id 指回原作品、标签随行；
 *   - 内库存量资产补 5 维兜底（全 2 分 → C，source = migration）与 ai_status = unscored；
 *   - 外库存量资产 value_* 保持 NULL（未入库不评估）；
 *   - 资产的 source_type 按 source 推断（ai_extracted → ai_extract，其余 external_direct）；
 *   - 重复打开不会二次执行（资产数量与 id 稳定）。
 */

const root = process.cwd();
const fullFolder = path.join(root, "drizzle");
const workDir = mkdtempSync(path.join(tmpdir(), "pakp-asset-migration-"));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** 复制 0000–0009 与截断后的 journal，得到一个「0010 之前」的库。 */
function legacyMigrations(dir: string): string {
  mkdirSync(path.join(dir, "meta"), { recursive: true });

  const journal = JSON.parse(
    readFileSync(path.join(fullFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> };

  const legacy = { ...journal, entries: journal.entries.slice(0, 10) };

  writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify(legacy));

  for (const entry of legacy.entries) {
    copyFileSync(path.join(fullFolder, `${entry.tag}.sql`), path.join(dir, `${entry.tag}.sql`));
  }

  return dir;
}

const T1 = "2026-10-01T00:00:00.000Z";
const T2 = "2026-10-20T08:30:00.000Z";

describe("0010 资产流水线迁移", () => {
  it("内库作品沉淀为内库资产，存量资产补齐 5 维兜底，重复打开不重复执行", async () => {
    const file = path.join(workDir, "legacy.db");
    const legacyFolder = legacyMigrations(path.join(workDir, "legacy-migrations"));

    const legacy = openDatabase({ file, migrationsFolder: legacyFolder });

    // 旧模型：内库 + practiced 的作品（0010 之前允许）。
    legacy.sqlite
      .prepare(
        `insert into objects
           (id, type, title, description, library, source, origin, category_code, priority,
            owner_sub, revision, created_at, updated_at, status)
         values ('legacy_work', 'work', '旧课程复盘', '已验证的课程复盘', 'internal',
                 'handwritten', 'self', 'article', 'high', 'u1', 3, ?, ?, 'practiced')`,
      )
      .run(T1, T2);

    // 存量内库资产（手写）与外库资产（AI 提炼）。
    legacy.sqlite
      .prepare(
        `insert into objects
           (id, type, title, library, source, origin, category_code, priority,
            owner_sub, revision, created_at, updated_at)
         values ('legacy_asset_internal', 'asset', '旧内库资产', 'internal', 'handwritten',
                 'self', 'article', 'medium', 'u1', 1, ?, ?)`,
      )
      .run(T1, T1);

    legacy.sqlite
      .prepare(
        `insert into objects
           (id, type, title, library, source, origin, category_code, priority,
            owner_sub, revision, created_at, updated_at)
         values ('legacy_asset_external', 'asset', '旧外库资产', 'external', 'ai_extracted',
                 'self', 'article', 'medium', 'u1', 1, ?, ?)`,
      )
      .run(T1, T1);

    // 作品的标签要跟着「沉淀出的资产」走。
    legacy.sqlite
      .prepare(
        `insert into tags (id, label, normalized, sort_order, created_at, updated_at)
         values ('tag_review', '复盘', '复盘', 0, ?, ?)`,
      )
      .run(T1, T1);
    legacy.sqlite
      .prepare("insert into object_tags (object_id, tag_id) values ('legacy_work', 'tag_review')")
      .run();

    legacy.close();

    // 用完整迁移（含 0010）重新打开同一个库。
    const upgraded = openDatabase({ file });
    const repo = new SqliteObjectRepository(upgraded.db);

    const work = await repo.findById("legacy_work");
    expect(work).toMatchObject({
      id: "legacy_work",
      type: "work",
      library: "external",
      status: "practiced",
      practicedAt: T2,
      practiceMetrics: null,
    });
    // practiced 作品不自动归档：迁移后仍出现在默认列表里。
    expect(work?.archivedAt).toBeNull();
    expect((await repo.list({ ownerSub: "u1" })).map((row) => row.id)).toContain("legacy_work");
    expect(work?.settledAssetId).not.toBeNull();
    // 作品字段不夹带资产字段（CHECK 钉死）
    expect(work?.sourceType).toBeNull();
    expect(work?.valueLevel).toBeNull();

    const settled = await repo.findById(work!.settledAssetId!);
    expect(settled).toMatchObject({
      type: "asset",
      library: "internal",
      sourceType: "practiced_work",
      originWorkId: "legacy_work",
      aiStatus: "unscored",
      aiScore: null,
      valueLevel: "C",
      title: "旧课程复盘",
      description: "已验证的课程复盘",
      category: "article",
      priority: "high",
      tags: ["复盘"],
    });
    expect(settled?.valueScores?.source).toBe("migration");
    expect(settled?.valueScores?.dimensions).toHaveLength(5);
    expect(settled?.valueScores?.dimensions.every((item) => item.score === 2)).toBe(true);
    expect(settled?.valueAssessedAt).not.toBeNull();

    // 存量内库资产：库别不变，补齐兜底与来源类型。
    const internalAsset = await repo.findById("legacy_asset_internal");
    expect(internalAsset).toMatchObject({
      library: "internal",
      sourceType: "external_direct",
      aiStatus: "unscored",
      valueLevel: "C",
      originWorkId: null,
    });
    expect(internalAsset?.valueScores?.source).toBe("migration");

    // 外库存量资产：value_* 全为 NULL（与新建外库资产一致，入库时才评估）。
    const externalAsset = await repo.findById("legacy_asset_external");
    expect(externalAsset).toMatchObject({
      library: "external",
      sourceType: "ai_extract",
      aiStatus: "unscored",
      valueLevel: null,
      valueScores: null,
      valueAssessedAt: null,
    });

    // 跨库迁移留痕
    const events = await repo.listLibraryEvents("legacy_work");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      fromLibrary: "internal",
      toLibrary: "external",
      actorSub: "u1",
    });
    expect(events[0].reason).toBe(
      "迁移 0010：内库作品沉淀为内库资产，原作品回到外库并保留 practiced 状态",
    );

    // 原作品仍是作品，沉淀出一行资产：总共 4 行对象。
    const all = await repo.list({ includeArchived: true, includeDeleted: true });
    expect(all).toHaveLength(4);

    upgraded.close();

    // 重复打开：迁移已应用，不重复沉淀。
    const again = openDatabase({ file });
    const againRepo = new SqliteObjectRepository(again.db);
    const rows = await againRepo.list({ includeArchived: true, includeDeleted: true });

    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.sourceType === "practiced_work")).toHaveLength(1);
    expect((await againRepo.findById("legacy_work"))?.settledAssetId).toBe(work?.settledAssetId);

    again.close();
  });
});
