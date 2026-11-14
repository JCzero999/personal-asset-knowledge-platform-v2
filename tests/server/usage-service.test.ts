import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { BusinessObject } from "../../src/domain/objects";
import { buildValueScores, type ValueScores } from "../../src/domain/value";
import { openDatabase, type DatabaseHandle } from "../../src/server/db/client";
import { SqliteObjectRepository } from "../../src/server/repositories/sqlite-object-repository";
import {
  recordAssetUsage,
  runUsageReview,
  setAssetValueLock,
} from "../../src/server/services/usage-service";
import { actor } from "../helpers/actor";

/**
 * 有效调用与动态升降级（v2.1 §2）：1 小时去重、30 天计数、锁定跳过、
 * 24 小时节流，以及只动内库资产。
 */

let handle: DatabaseHandle;
let repo: SqliteObjectRepository;

const T1 = "2026-08-06T00:00:00.000Z";
const REVIEW_NOW = "2026-11-14T00:00:00.000Z";

function scores(value: number, at = T1): ValueScores {
  return buildValueScores({
    scores: {
      practice: value,
      reuse: value,
      transferability: value,
      uniqueness: value,
      timeliness: value,
    },
    assessedAt: at,
  });
}

beforeAll(() => {
  handle = openDatabase({ file: ":memory:" });
});

afterAll(() => {
  handle.close();
});

beforeEach(() => {
  handle.sqlite.exec(`
    DELETE FROM value_assessment_history;
    DELETE FROM asset_usage_events;
    DELETE FROM audit_events;
    DELETE FROM objects;
  `);
  repo = new SqliteObjectRepository(handle.db);
});

function internalAsset(
  title: string,
  options: { level?: "B" | "C" | "A" | "S"; createdAt?: string } = {},
): Promise<BusinessObject> {
  const createdAt = options.createdAt ?? T1;

  return repo.create({
    type: "asset",
    title,
    library: "internal",
    source: "handwritten",
    ownerSub: "u1",
    valueLevel: options.level ?? "B",
    valueScores: scores(3, createdAt),
    valueAssessedAt: createdAt,
    now: createdAt,
  });
}

describe("recordAssetUsage", () => {
  it("记录事件、累加 use_count，并返回最新对象", async () => {
    const asset = await internalAsset("复盘三步法");

    const result = await recordAssetUsage(handle.db, actor("u1"), asset.id, {
      kind: "copy",
    });

    expect(result.recorded).toBe(true);
    expect(result.object.useCount).toBe(1);
    expect(result.object.lastUsedAt).not.toBeNull();

    const events = await repo.findUsageInWindow(asset.id, "2020-01-01T00:00:00.000Z");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "copy", actorSub: "u1" });
  });

  it("同 asset + kind + actor 1 小时内只计一次，换动作或换人照常计", async () => {
    const asset = await internalAsset("复盘三步法");
    const now = "2026-11-14T00:00:00.000Z";
    const later = "2026-11-14T00:30:00.000Z";
    const other = "2026-11-14T00:40:00.000Z";
    const past = "2026-11-14T02:00:00.000Z";

    await recordAssetUsage(handle.db, actor("u1"), asset.id, { kind: "copy" }, { now });
    const duplicate = await recordAssetUsage(
      handle.db,
      actor("u1"),
      asset.id,
      { kind: "copy" },
      { now: later },
    );
    expect(duplicate.recorded).toBe(false);
    expect(duplicate.object.useCount).toBe(1);

    await recordAssetUsage(handle.db, actor("u1"), asset.id, { kind: "reference" }, { now: other });
    const outside = await recordAssetUsage(
      handle.db,
      actor("u1"),
      asset.id,
      { kind: "copy" },
      { now: past },
    );

    expect(outside.recorded).toBe(true);
    expect(outside.object.useCount).toBe(3);
  });

  it("作品 409、非法 kind 400、跨 owner 404", async () => {
    const work = await repo.create({
      type: "work",
      title: "课程复盘",
      library: "external",
      category: "article",
      ownerSub: "u1",
    });
    const asset = await internalAsset("复盘三步法");

    await expect(
      recordAssetUsage(handle.db, actor("u1"), work.id, { kind: "copy" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      recordAssetUsage(handle.db, actor("u1"), asset.id, { kind: "wat" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      recordAssetUsage(handle.db, actor("u2"), asset.id, { kind: "copy" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("setAssetValueLock", () => {
  it("锁定与解锁都会记录，作品不能锁", async () => {
    const asset = await internalAsset("复盘三步法");
    const work = await repo.create({
      type: "work",
      title: "课程复盘",
      library: "external",
      category: "article",
      ownerSub: "u1",
    });

    expect((await setAssetValueLock(handle.db, actor("u1"), asset.id, { locked: true })).valueLevelLocked).toBe(true);
    expect((await setAssetValueLock(handle.db, actor("u1"), asset.id, { locked: false })).valueLevelLocked).toBe(false);

    await expect(
      setAssetValueLock(handle.db, actor("u1"), work.id, { locked: true }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      setAssetValueLock(handle.db, actor("u1"), asset.id, { locked: "yes" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("runUsageReview", () => {
  it("闲置降级、频繁调用升级、锁定跳过，并写历史与节流时间", async () => {
    const idle = await internalAsset("闲置资产");
    const hot = await internalAsset("高频资产", { createdAt: "2026-10-30T00:00:00.000Z" });
    const locked = await internalAsset("锁定资产");

    for (const kind of ["detail_dwell", "open_source", "copy", "reference", "copy"] as const) {
      await repo.recordUsage({
        assetId: hot.id,
        kind,
        actor: actor("u1"),
        now: "2026-11-12T00:00:00.000Z",
      });
    }
    await setAssetValueLock(handle.db, actor("u1"), locked.id, { locked: true });

    const result = await runUsageReview(handle.db, actor("u1"), { now: REVIEW_NOW });

    expect(result.scanned).toBe(3);
    expect(result.skippedLocked).toBe(1);
    expect(result.adjusted).toBe(2);
    expect(result.failed).toEqual([]);
    expect(result.items.map((item) => [item.title, item.from, item.to])).toEqual([
      ["高频资产", "B", "A"],
      ["闲置资产", "B", "C"],
    ]);

    expect((await repo.findById(idle.id))?.valueLevel).toBe("C");
    expect((await repo.findById(hot.id))?.valueLevel).toBe("A");
    expect((await repo.findById(locked.id))?.valueLevel).toBe("B");

    const history = await repo.listValueHistory(idle.id, 5);
    expect(history[0]).toMatchObject({ trigger: "auto_downgrade", assessedBy: "system" });
    expect((await repo.findById(idle.id))?.lastLevelAdjustAt).toBe(REVIEW_NOW);
  });

  it("24 小时内重复执行不再调整（节流）", async () => {
    const idle = await internalAsset("闲置资产");

    const first = await runUsageReview(handle.db, actor("u1"), { now: REVIEW_NOW });
    expect(first.adjusted).toBe(1);

    const second = await runUsageReview(handle.db, actor("u1"), {
      now: "2026-11-14T10:00:00.000Z",
    });
    expect(second.adjusted).toBe(0);
    expect((await repo.findById(idle.id))?.valueLevel).toBe("C");
  });

  it("只处理内库资产：外库资产与作品不动", async () => {
    const external = await repo.create({
      type: "asset",
      title: "外库资产",
      library: "external",
      source: "handwritten",
      ownerSub: "u1",
      now: T1,
    });

    const result = await runUsageReview(handle.db, actor("u1"), { now: REVIEW_NOW });

    expect(result.scanned).toBe(0);
    expect((await repo.findById(external.id))?.valueLevel).toBeNull();
  });
});
