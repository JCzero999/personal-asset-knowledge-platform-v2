import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type DatabaseHandle } from "../../src/server/db/client";
import { buildValueScores } from "../../src/domain/value";
import { SqliteObjectRepository } from "../../src/server/repositories/sqlite-object-repository";
import { writeAudit } from "../../src/server/services/audit-service";
import { getValueMetrics } from "../../src/server/services/value-metrics-service";
import { actor } from "../helpers/actor";

/**
 * 兜底监控（v2.1 §5）：只统计失败类审计；等级分布只数未删除的内库资产。
 */

let handle: DatabaseHandle;
let repo: SqliteObjectRepository;

const NOW = new Date("2026-11-14T12:00:00.000Z");
const T1 = "2026-11-01T00:00:00.000Z";

beforeAll(() => {
  handle = openDatabase({ file: ":memory:" });
});

afterAll(() => {
  handle.close();
});

beforeEach(() => {
  handle.sqlite.exec(`
    DELETE FROM audit_events;
    DELETE FROM objects;
  `);
  repo = new SqliteObjectRepository(handle.db);
});

function audit(action: string, createdAt: string, result: "ok" | "error" = "error") {
  writeAudit(handle.db, {
    actor: actor("u1"),
    action,
    result,
    createdAt,
  });
}

describe("getValueMetrics", () => {
  it("按今天 / 7 天窗口统计失败审计，并给出内库资产等级分布", async () => {
    for (const [title, level, score] of [
      ["S 资产", "S", 5],
      ["A 资产一", "A", 4],
      ["A 资产二", "A", 4],
      ["C 资产", "C", 2],
    ] as const) {
      await repo.create({
        type: "asset",
        title,
        library: "internal",
        source: "handwritten",
        ownerSub: "u1",
        valueLevel: level,
        valueScores: buildValueScores({
          scores: {
            practice: score,
            reuse: score,
            transferability: score,
            uniqueness: score,
            timeliness: score,
          },
          assessedAt: T1,
        }),
        valueAssessedAt: T1,
        now: T1,
      });
    }

    const external = await repo.create({
      type: "asset",
      title: "外库资产",
      library: "external",
      source: "handwritten",
      ownerSub: "u1",
      now: T1,
    });
    const deleted = await repo.create({
      type: "asset",
      title: "已删除资产",
      library: "internal",
      source: "handwritten",
      ownerSub: "u1",
      now: T1,
    });
    await repo.softDelete(deleted.id);
    expect(external.id).toBeTruthy();

    // 今天 01:00、昨天 23:00 → fallback7d；8 天前 → 都不算。
    audit("value.fallback", "2026-11-14T01:00:00.000Z");
    audit("value.fallback", "2026-11-13T23:00:00.000Z");
    audit("value.fallback", "2026-11-06T00:00:00.000Z");
    // 成功记录不计入失败数。
    audit("value.fallback", "2026-11-14T02:00:00.000Z", "ok");
    audit("value.reassess_failed", "2026-11-12T00:00:00.000Z");
    audit("value.reassess_failed", "2026-10-01T00:00:00.000Z");

    expect(getValueMetrics(handle.db, NOW)).toEqual({
      fallbackToday: 1,
      fallback7d: 2,
      reassessFailed7d: 1,
      levelDistribution: { S: 1, A: 2, B: 0, C: 1 },
    });
  });

  it("没有数据时全是 0", () => {
    expect(getValueMetrics(handle.db, NOW)).toEqual({
      fallbackToday: 0,
      fallback7d: 0,
      reassessFailed7d: 0,
      levelDistribution: { S: 0, A: 0, B: 0, C: 0 },
    });
  });
});
