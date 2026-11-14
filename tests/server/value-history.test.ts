import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { BusinessObject } from "../../src/domain/objects";
import { ValidationError } from "../../src/domain/errors";
import { buildValueScores, type ValueScores } from "../../src/domain/value";
import { openDatabase, type DatabaseHandle } from "../../src/server/db/client";
import {
  listObjectValueHistory,
  parseValueHistoryLimit,
} from "../../src/server/services/object-service";
import { SqliteObjectRepository } from "../../src/server/repositories/sqlite-object-repository";
import { actor } from "../helpers/actor";

/**
 * 价值评估历史（v2.1 §3）：每次写 `value_*` 都留一行，prev 取改前值；
 * 历史按时间倒序，跨 owner 与不存在的对象一样返回 404。
 */

let handle: DatabaseHandle;
let repo: SqliteObjectRepository;

const T1 = "2026-11-01T08:00:00.000Z";
const T2 = "2026-11-05T08:00:00.000Z";
const T3 = "2026-11-10T08:00:00.000Z";

function scores(value: number, assessedAt: string): ValueScores {
  return buildValueScores({
    scores: {
      practice: value,
      reuse: value,
      transferability: value,
      uniqueness: value,
      timeliness: value,
    },
    assessedAt,
    source: "rule",
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

function internalAsset(ownerSub = "u1"): Promise<BusinessObject> {
  return repo.create({
    type: "asset",
    title: "复盘三步法",
    library: "internal",
    source: "handwritten",
    ownerSub,
    now: T1,
  });
}

describe("listValueHistory", () => {
  it("重评后留下两条历史，prev 指向上一次的等级与分数", async () => {
    const asset = await internalAsset();

    await repo.applyValueAssessment({
      objectId: asset.id,
      assessment: { valueLevel: "A", valueScores: scores(4, T2), valueAssessedAt: T2 },
      actor: actor("u1"),
      trigger: "manual_reassess",
      now: T2,
    });
    await repo.applyValueAssessment({
      objectId: asset.id,
      assessment: { valueLevel: "S", valueScores: scores(5, T3), valueAssessedAt: T3 },
      actor: actor("u1"),
      trigger: "review",
      reason: "人工复核通过",
      now: T3,
    });

    const history = await listObjectValueHistory(handle.db, "u1", asset.id, 20);

    // 内库资产创建时就有兜底等级，因此额外有一条 create 历史（v2.1 §3）。
    expect(history.map((item) => item.trigger)).toEqual([
      "review",
      "manual_reassess",
      "create",
    ]);
    expect(history[2]).toMatchObject({
      trigger: "create",
      valueLevel: "C",
      prevLevel: null,
      assessedBy: "u1",
    });
    expect(history[1]).toMatchObject({
      trigger: "manual_reassess",
      valueLevel: "A",
      prevLevel: "C",
      assessedBy: "u1",
    });
    expect(history[0]).toMatchObject({
      valueLevel: "S",
      prevLevel: "A",
      reason: "人工复核通过",
    });
    expect(history[0].valueScores?.level).toBe("S");
  });

  it("按 limit 取最新的若干条", async () => {
    const asset = await internalAsset();

    for (const [index, at] of [T1, T2, T3].entries()) {
      await repo.applyValueAssessment({
        objectId: asset.id,
        expectedRevision: index === 0 ? asset.revision : undefined,
        assessment: { valueLevel: "B", valueScores: scores(3, at), valueAssessedAt: at },
        actor: actor("u1"),
        now: at,
      });
    }

    const history = await listObjectValueHistory(handle.db, "u1", asset.id, 2);
    expect(history).toHaveLength(2);
  });

  it("跨 owner 与不存在的对象一样返回 404", async () => {
    const asset = await internalAsset("u1");

    await expect(listObjectValueHistory(handle.db, "u2", asset.id, 20)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      listObjectValueHistory(handle.db, "u1", "01J00000000000000000000000", 20),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("parseValueHistoryLimit", () => {
  it("缺省 20，1–50 合法，其余 400", () => {
    expect(parseValueHistoryLimit(new URLSearchParams())).toBe(20);
    expect(parseValueHistoryLimit(new URLSearchParams("limit=1"))).toBe(1);
    expect(parseValueHistoryLimit(new URLSearchParams("limit=50"))).toBe(50);
    expect(parseValueHistoryLimit(new URLSearchParams("limit="))).toBe(20);

    for (const bad of ["0", "51", "2.5", "abc"]) {
      expect(() => parseValueHistoryLimit(new URLSearchParams(`limit=${bad}`))).toThrow(
        ValidationError,
      );
    }
  });
});
