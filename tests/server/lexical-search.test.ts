import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actor } from "../helpers/actor";

import { openDatabase, backfillSearchNorm, type DatabaseHandle } from "../../src/server/db/client";
import { normalizeSearchText, parseSearchInput } from "../../src/lib/search-query";
import { SqliteObjectRepository } from "../../src/server/repositories/sqlite-object-repository";
import { lexicalSearch } from "../../src/server/services/lexical-search-service";
import { createTag } from "../../src/server/services/vocabulary-service";

/**
 * 词法检索的存储层（ADR-024 第 2、9 条）：
 * 影子列写入 / 回填、候选 SQL 的权限与库别过滤、500 条上限与截断标记。
 * 评分与排序已在 search-query.test.ts 覆盖，这里只验证「取数」。
 */

const OWNER = "user_1";
const OTHER = "user_2";
const FIXED_NOW = "2026-01-01T00:00:00.000Z";

let handle: DatabaseHandle;
let repo: SqliteObjectRepository;

beforeAll(() => {
  handle = openDatabase({ file: ":memory:" });
  repo = new SqliteObjectRepository(handle.db);
});

afterAll(() => {
  handle.close();
});

beforeEach(() => {
  handle.sqlite.exec(`
    DELETE FROM object_tags;
    DELETE FROM objects;
    DELETE FROM tags;
  `);
  repo = new SqliteObjectRepository(handle.db);
});

function create(
  title: string,
  overrides: Partial<Parameters<SqliteObjectRepository["create"]>[0]> = {},
) {
  return repo.create({
    ownerSub: OWNER,
    type: "asset",
    title,
    library: "internal",
    now: FIXED_NOW,
    ...overrides,
  });
}

function search(question: string, options: { library?: "internal" | "external"; limit?: number } = {}) {
  return lexicalSearch(handle.db, OWNER, parseSearchInput(question), options);
}

describe("影子列", () => {
  it("创建时写入归一化后的标题与描述", async () => {
    const object = await create("ＡＢＣ  复盘", { description: "ＦＵＬＬ　描述" });

    const row = handle.sqlite
      .prepare("select title_norm, description_norm from objects where id = ?")
      .get(object.id) as { title_norm: string; description_norm: string };

    expect(row.title_norm).toBe("abc 复盘");
    expect(row.description_norm).toBe("full 描述");
  });

  it("标题改名后立即以新词命中、旧词失效", async () => {
    const object = await create("旧标题");

    expect((await search("旧标题")).hits).toHaveLength(1);

    await repo.update(object.id, {
      title: "新标题",
      expectedRevision: object.revision,
      now: "2026-02-01T00:00:00.000Z",
    });

    expect((await search("旧标题")).hits).toHaveLength(0);
    expect((await search("新标题")).hits.map((hit) => hit.object.id)).toEqual([object.id]);
  });

  it("描述清空后影子列同步为 null", async () => {
    const object = await create("保留标题", { description: "临时描述" });

    await repo.update(object.id, {
      description: null,
      expectedRevision: object.revision,
    });

    const row = handle.sqlite
      .prepare("select description_norm from objects where id = ?")
      .get(object.id) as { description_norm: string | null };

    expect(row.description_norm).toBeNull();
    expect((await search("临时描述")).hits).toHaveLength(0);
  });

  it("迁移回填：title_norm 为空的行用同一函数补齐", async () => {
    const object = await create("回填 对象");
    handle.sqlite.prepare("update objects set title_norm = null where id = ?").run(object.id);

    expect((await search("回填")).hits).toHaveLength(0);

    const filled = backfillSearchNorm(handle.sqlite);
    expect(filled).toBeGreaterThanOrEqual(1);

    const row = handle.sqlite
      .prepare("select title_norm from objects where id = ?")
      .get(object.id) as { title_norm: string };
    expect(row.title_norm).toBe(normalizeSearchText("回填 对象"));

    expect((await search("回填")).hits.map((hit) => hit.object.id)).toEqual([object.id]);
    // 再跑一次没有需要补的行。
    expect(backfillSearchNorm(handle.sqlite)).toBe(0);
  });
});

describe("候选过滤", () => {
  it("只取当前用户、未删除、未归档", async () => {
    const mine = await create("复盘方法");
    const archived = await create("复盘归档");
    const deleted = await create("复盘删除");
    const others = await create("复盘他人", { ownerSub: OTHER });

    await handle.sqlite
      .prepare("update objects set archived_at = ? where id = ?")
      .run(FIXED_NOW, archived.id);
    await repo.softDelete(deleted.id);

    const result = await search("复盘");

    expect(result.hits.map((hit) => hit.object.id)).toEqual([mine.id]);
    expect(result.hits.map((hit) => hit.object.id)).not.toContain(others.id);
  });

  it("库别过滤", async () => {
    const internal = await create("复盘内库");
    const external = await create("复盘外库", { library: "external" });

    const result = await search("复盘", { library: "external" });

    expect(result.hits.map((hit) => hit.object.id)).toEqual([external.id]);
    expect(result.hits.map((hit) => hit.object.id)).not.toContain(internal.id);
  });

  it("分类名与标签名参与匹配（join / exists）", async () => {
    const tag = createTag(handle.db, actor(OWNER), { label: "深度复盘" });
    const object = await create("普通标题", { category: "course", tags: [tag.label] });

    expect((await search("分类:课程")).hits.map((hit) => hit.object.id)).toEqual([object.id]);
    expect((await search("标签:深度复盘")).hits.map((hit) => hit.object.id)).toEqual([
      object.id,
    ]);
    // 分类标签名按完整子串匹配：只写「深度」也能命中标签。
    expect((await search("深度")).hits.map((hit) => hit.object.id)).toEqual([object.id]);
  });

  it("分类名不匹配时不误伤", async () => {
    await create("课程笔记", { category: "article" });

    expect((await search("分类:课程")).hits).toHaveLength(0);
  });

  it("% 与 _ 按字面量匹配", async () => {
    const percent = await create("完成度 100%");
    await create("完成度 1000");

    expect((await search("100%")).hits.map((hit) => hit.object.id)).toEqual([percent.id]);
    expect((await search("100_")).hits).toHaveLength(0);
  });

  it("引号与 SQL 片段按字面量处理，不会破坏参数化查询", async () => {
    const object = await create("他说 \"复盘\" 了");

    expect((await search('"复盘"')).hits.map((hit) => hit.object.id)).toEqual([object.id]);
    expect((await search("x'; select 1")).hits).toHaveLength(0);
  });
});

describe("条数与摘要", () => {
  it("limit 截断返回条数并标记 truncated", async () => {
    await create("复盘 1");
    await create("复盘 2");
    await create("复盘 3");

    const result = await search("复盘", { limit: 2 });

    expect(result.hits).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("超过 500 条时截断并提示收窄", async () => {
    for (let index = 0; index < 520; index += 1) {
      await create(`复盘 压测 ${String(index).padStart(3, "0")}`);
    }

    const result = await search("复盘");

    expect(result.hits).toHaveLength(500);
    expect(result.total).toBe(500);
    expect(result.truncated).toBe(true);
    expect(result.hint).toBe("结果较多，请加关键词收窄范围");
  });

  it("摘要优先用描述，没有描述时退成分类 / 标签", async () => {
    const tag = createTag(handle.db, actor(OWNER), { label: "模板" });
    const withDescription = await create("复盘甲", { description: "这是一段描述" });
    const withoutDescription = await create("复盘乙", { category: "course", tags: [tag.label] });

    const result = await search("复盘");
    const byId = new Map(result.hits.map((hit) => [hit.object.id, hit]));

    expect(byId.get(withDescription.id)?.snippetSource).toBe("这是一段描述");
    expect(byId.get(withoutDescription.id)?.snippetSource).toBe("分类：课程 · 标签：模板");
  });
});
