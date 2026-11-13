import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RagflowDataset, RagflowRetrievalResult } from "../../src/server/adapters/ragflow";
import { openDatabase, type DatabaseHandle } from "../../src/server/db/client";
import { parseSearchInput } from "../../src/lib/search-query";
import { SqliteObjectRepository } from "../../src/server/repositories/sqlite-object-repository";
import { lexicalSearch } from "../../src/server/services/lexical-search-service";
import { searchContent, type SearchGateway } from "../../src/server/services/search-service";

/**
 * ADR-024 的 1 万对象基准（默认跳过，`PERF=1` 时运行）。
 *
 * 目标：词法检索 p95 ≤ 60ms、首页预览（limit=8）p95 ≤ 30ms；
 * 同时实测 3 秒语义超时的真实耗时，证明降级不会拖住关键词结果。
 */

const PERF = process.env.PERF === "1";
const OWNER = "user_bench";
const TOTAL = 10_000;

const NOUNS = [
  "个人知识系统",
  "复盘方法",
  "写作模板",
  "分布式事务",
  "机器学习笔记",
  "产品设计稿",
  "课程大纲",
  "读书摘要",
  "项目周报",
  "架构决策记录",
];

const DESCRIPTIONS = [
  "关于复盘与写作的长期实践，包含模板与检查清单",
  "把一次项目复盘拆成可复用的步骤，供下次直接照做",
  "分布式事务的学习笔记，覆盖两阶段提交与补偿",
  "课程资料与作业，按周整理的提纲和参考资料",
  null,
  null,
];

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index];
}

function summarize(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: Number(percentile(sorted, 0.5).toFixed(2)),
    p95: Number(percentile(sorted, 0.95).toFixed(2)),
    max: Number(sorted[sorted.length - 1].toFixed(2)),
  };
}

describe.skipIf(!PERF)("检索压测：1 万对象", () => {
  let handle: DatabaseHandle;
  let repo: SqliteObjectRepository;
  let seedMs = 0;

  beforeAll(async () => {
    handle = openDatabase({ file: ":memory:" });
    repo = new SqliteObjectRepository(handle.db);
    const started = performance.now();

    for (let index = 0; index < TOTAL; index += 1) {
      const noun = NOUNS[index % NOUNS.length];
      const title = index % 7 === 0 ? `${noun}` : `${noun} ${String(index).padStart(5, "0")}`;
      const description = DESCRIPTIONS[index % DESCRIPTIONS.length];
      const category = index % 5 === 0 ? (index % 2 === 0 ? "course" : "article") : null;

      await repo.create({
        ownerSub: OWNER,
        type: "asset",
        title,
        description,
        category,
        library: index % 9 === 0 ? "external" : "internal",
      });
    }

    seedMs = performance.now() - started;
  }, 180_000);

  afterAll(() => {
    handle.close();
  });

  it("词法检索 p95 ≤ 60ms，预览 p95 ≤ 30ms", async () => {
    const queries = ["复盘", "个人知识", "课程", "写作模板", "知识 系统"];

    for (const query of queries) {
      const parsed = parseSearchInput(query);
      // 预热，顺带确认真的命中了数据。
      const warm = await lexicalSearch(handle.db, OWNER, parsed);
      expect(warm.hits.length).toBeGreaterThan(0);

      const samples: number[] = [];
      for (let run = 0; run < 20; run += 1) {
        const started = performance.now();
        await lexicalSearch(handle.db, OWNER, parsed);
        samples.push(performance.now() - started);
      }

      const stats = summarize(samples);
      console.log(`[bench] lexical "${query}" (${warm.total} 命中)`, stats);

      expect(stats.p95).toBeLessThanOrEqual(60);

      const previewSamples: number[] = [];
      for (let run = 0; run < 20; run += 1) {
        const started = performance.now();
        await lexicalSearch(handle.db, OWNER, parsed, { limit: 8 });
        previewSamples.push(performance.now() - started);
      }

      const previewStats = summarize(previewSamples);
      console.log(`[bench] preview "${query}" limit=8`, previewStats);

      expect(previewStats.p95).toBeLessThanOrEqual(30);
    }

    console.log(`[bench] 写入 ${TOTAL} 条耗时 ${Math.round(seedMs)}ms`);
  }, 120_000);

  it("候选查询走 owner/scope 索引", () => {
    const plan = handle.sqlite
      .prepare(
        `explain query plan
         select id from objects
          where owner_sub = ?
            and deleted_at is null
            and archived_at is null
            and instr(coalesce(title_norm, ''), ?) > 0
          limit 501`,
      )
      .all(OWNER, "复盘") as { detail: string }[];

    console.log("[bench] query plan", plan.map((row) => row.detail).join(" | "));
    expect(plan.map((row) => row.detail).join(" ")).toContain("objects_owner_scope_idx");
  });

  it("语义超时按 3 秒硬截止，关键词结果按时返回", async () => {
    class HangingGateway implements SearchGateway {
      async listDatasets(): Promise<RagflowDataset[]> {
        return [];
      }

      async retrieve(): Promise<RagflowRetrievalResult> {
        return new Promise<RagflowRetrievalResult>(() => {});
      }
    }

    const started = performance.now();
    const result = await searchContent(
      handle.db,
      OWNER,
      { question: "复盘" },
      {
        client: new HangingGateway(),
        env: { RAGFLOW_DATASET_ID: "ds_bench" },
      },
    );
    const elapsed = performance.now() - started;

    console.log(
      `[bench] hybrid 语义挂起 → status=${result.semantic.status}，耗时 ${Math.round(elapsed)}ms，命中 ${result.hits.length}`,
    );

    expect(result.semantic.status).toBe("timeout");
    expect(result.hits.length).toBeGreaterThan(0);
    expect(elapsed).toBeGreaterThanOrEqual(2900);
    expect(elapsed).toBeLessThan(3600);
  }, 30_000);
});
