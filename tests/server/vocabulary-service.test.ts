import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { actor } from "../helpers/actor";

import { ConflictError, DomainError, NotFoundError, ValidationError } from "../../src/domain/errors";
import { SYSTEM_CATEGORY_SEEDS } from "../../src/domain/objects";
import { openDatabase, type DatabaseHandle } from "../../src/server/db/client";
import { SqliteObjectRepository } from "../../src/server/repositories/sqlite-object-repository";
import {
  createCategory,
  createTag,
  deleteCategory,
  deleteTag,
  listActiveCategoryCodes,
  listVocabulary,
  mergeTag,
  updateCategory,
  updateTag,
} from "../../src/server/services/vocabulary-service";

/**
 * 词表服务测试（ADR-016 / ADR-023）：
 * 迁移种子、使用次数（含资产）、删除保护、改名 / 停用的全站生效语义，
 * 以及内联新建的重名策略（复用 / 已停用 / 冲突）。
 */

let handle: DatabaseHandle;
let repo: SqliteObjectRepository;

beforeEach(() => {
  handle = openDatabase({ file: ":memory:" });
  handle.sqlite.exec(`
    DELETE FROM sync_jobs;
    DELETE FROM library_events;
    DELETE FROM content_refs;
    DELETE FROM objects;
    DELETE FROM audit_events;
  `);
  repo = new SqliteObjectRepository(handle.db);
});

afterAll(() => {
  handle?.close();
});

function work(title: string, category = "article", tags: string[] = []) {
  return repo.create({
    type: "work",
    title,
    // 作品只存在于外库（ADR-029）；标签 / 分类语义与库别无关。
    library: "external",
    ownerSub: "u1",
    category,
    tags,
  });
}

function asset(title: string, category?: string) {
  return repo.create({
    type: "asset",
    title,
    library: "internal",
    ownerSub: "u1",
    ...(category ? { category } : {}),
  });
}

describe("listVocabulary", () => {
  it("分类种子齐全，且与 SYSTEM_CATEGORY_SEEDS 一致", () => {
    const { categories } = listVocabulary(handle.db);

    expect(categories.map((item) => item.code)).toEqual(
      expect.arrayContaining(SYSTEM_CATEGORY_SEEDS.map((seed) => seed.code)),
    );
    expect(categories.every((item) => item.isSystem)).toBe(true);
    expect(categories.find((item) => item.code === "uncategorized")).toMatchObject({
      label: "未分类",
      isSystem: true,
    });
  });

  it("使用次数按对象实时聚合：包含资产，软删对象不计入", async () => {
    const first = await work("一");
    await asset("参考", "article");
    const tag = createTag(handle.db, actor("admin"), { label: "复盘" });
    await work("二", "article", [tag.label]);
    await repo.softDelete(first.id);

    const snapshot = listVocabulary(handle.db);

    expect(snapshot.categories.find((item) => item.code === "article")?.usage).toBe(2);
    expect(snapshot.tags.find((item) => item.id === tag.id)?.usage).toBe(1);
  });
});

describe("分类词表", () => {
  it("新增分类后立即可用于新建；改名只改 label，不动对象数据", async () => {
    const { category: podcast, created } = createCategory(handle.db, actor("admin"), {
      label: "播客",
    });
    expect(created).toBe(true);
    expect(podcast.code).toMatch(/^c-[0-9a-z]{8}$/);
    expect(listActiveCategoryCodes(handle.db)).toContain(podcast.code);

    const createdObject = await work("播客第一期", podcast.code);
    expect(createdObject.category).toBe(podcast.code);

    updateCategory(handle.db, actor("admin"), podcast.code, { label: "播客节目" });

    const reloaded = await repo.findById(createdObject.id);
    expect(reloaded?.category).toBe(podcast.code);
    expect(
      listVocabulary(handle.db).categories.find((item) => item.code === podcast.code)?.label,
    ).toBe("播客节目");
  });

  it("内联新建：同名复用已有项，不复用则冲突，停用项要求先启用", async () => {
    const first = createCategory(handle.db, actor("u1"), { label: "读书会", source: "inline" });
    const again = createCategory(handle.db, actor("u1"), {
      label: "  读书会 ",
      reuseExisting: true,
      source: "inline",
    });

    expect(again.created).toBe(false);
    expect(again.category.code).toBe(first.category.code);

    expect(() => createCategory(handle.db, actor("u1"), { label: "读书会" })).toThrow(
      DomainError,
    );
    try {
      createCategory(handle.db, actor("u1"), { label: "读书会" });
    } catch (error) {
      expect((error as DomainError).code).toBe("CATEGORY_EXISTS");
    }

    updateCategory(handle.db, actor("admin"), first.category.code, { state: "archived" });

    try {
      createCategory(handle.db, actor("u1"), { label: "读书会", reuseExisting: true });
      throw new Error("应当被拒绝");
    } catch (error) {
      expect((error as DomainError).code).toBe("CATEGORY_ARCHIVED");
    }
  });

  it("审计里区分内联与后台创建", () => {
    createCategory(handle.db, actor("u1"), { label: "播客", source: "inline" });
    createCategory(handle.db, actor("admin"), { label: "课程笔记" });

    const rows = handle.sqlite
      .prepare("select detail from audit_events where action = 'vocabulary.category.create' order by created_at")
      .all() as Array<{ detail: string }>;

    expect(rows.map((row) => (JSON.parse(row.detail) as { source: string }).source)).toEqual([
      "inline",
      "admin",
    ]);
  });

  it("停用后不再出现在新建列表，但已有对象保持原值；未分类不可停用", async () => {
    const created = await work("直播回放", "live");

    updateCategory(handle.db, actor("admin"), "live", { state: "archived" });
    expect(listActiveCategoryCodes(handle.db)).not.toContain("live");

    const reloaded = await repo.findById(created.id);
    expect(reloaded?.category).toBe("live");

    expect(() =>
      updateCategory(handle.db, actor("admin"), "uncategorized", { state: "archived" }),
    ).toThrow(ConflictError);
  });

  it("至少保留一个启用分类", () => {
    for (const seed of SYSTEM_CATEGORY_SEEDS) {
      if (seed.code === "uncategorized") continue;
      updateCategory(handle.db, actor("admin"), seed.code, { state: "archived" });
    }

    expect(() =>
      updateCategory(handle.db, actor("admin"), "uncategorized", { state: "archived" }),
    ).toThrow(ConflictError);
  });

  it("被引用的分类删除被拒并带 usage；迁移到目标后统一改写", async () => {
    const { category: podcast } = createCategory(handle.db, actor("admin"), { label: "播客" });
    const a = await work("第一期", podcast.code);
    await asset("第二期素材", podcast.code);
    await work("第三期", podcast.code);

    try {
      deleteCategory(handle.db, actor("admin"), podcast.code);
      throw new Error("应当被拒绝");
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).details?.usage).toBe(3);
      expect((error as ConflictError).details?.sample).toHaveLength(3);
    }

    // 迁移只应让作品重新进同步队列（资产不进 RAGFlow）。
    handle.sqlite.exec("DELETE FROM sync_jobs");

    const result = deleteCategory(handle.db, actor("admin"), podcast.code, {
      migrateTo: "article",
    });
    expect(result).toMatchObject({ deleted: podcast.code, migrated: 3, migrateTo: "article" });

    expect((await repo.findById(a.id))?.category).toBe("article");

    const jobs = handle.sqlite
      .prepare("select owner_id, action from sync_jobs order by owner_id")
      .all() as Array<{ owner_id: string; action: string }>;
    expect(jobs).toHaveLength(2);
    expect(jobs.every((job) => job.action === "upsert")).toBe(true);

    expect(listVocabulary(handle.db).categories.some((item) => item.code === podcast.code)).toBe(
      false,
    );
  });

  it("迁移目标必须存在且启用；内置分类不可删除", async () => {
    const { category: podcast } = createCategory(handle.db, actor("admin"), { label: "播客" });
    await work("第一期", podcast.code);

    handle.sqlite.exec("DELETE FROM sync_jobs");
    updateCategory(handle.db, actor("admin"), "flomo", { state: "archived" });

    try {
      deleteCategory(handle.db, actor("admin"), podcast.code, { migrateTo: "flomo" });
      throw new Error("应当被拒绝");
    } catch (error) {
      expect((error as DomainError).code).toBe("CATEGORY_ARCHIVED");
    }

    expect(() =>
      deleteCategory(handle.db, actor("admin"), podcast.code, { migrateTo: "missing" }),
    ).toThrow(NotFoundError);

    expect(() => deleteCategory(handle.db, actor("admin"), "article")).toThrow(/内置/);
  });
});

describe("标签词表", () => {
  it("归一化命中即复用：全角 / 大小写 / 空白不产生重复记录", () => {
    const first = createTag(handle.db, actor("admin"), { label: "ＴＯＯＬ" });
    const again = createTag(handle.db, actor("admin"), { label: "  tool " });

    expect(again.id).toBe(first.id);
    expect(again.label).toBe("TOOL");
    expect(listVocabulary(handle.db).tags).toHaveLength(1);
  });

  it("改名是 O(1)：对象的 tags 立即变成新名字", async () => {
    const tag = createTag(handle.db, actor("admin"), { label: "工具类" });
    const created = await work("复盘", "article", ["工具类"]);

    updateTag(handle.db, actor("admin"), tag.id, { label: "工具" });

    expect((await repo.findById(created.id))?.tags).toEqual(["工具"]);
  });

  it("改名撞到已有归一化键时拒绝，并提示改用合并", () => {
    createTag(handle.db, actor("admin"), { label: "写作" });
    const other = createTag(handle.db, actor("admin"), { label: "复盘" });

    expect(() => updateTag(handle.db, actor("admin"), other.id, { label: " 写作 " })).toThrow(ConflictError);
  });

  it("合并把引用转移到目标（已含则去重）并删除源标签", async () => {
    const source = createTag(handle.db, actor("admin"), { label: "工具类" });
    const target = createTag(handle.db, actor("admin"), { label: "工具" });

    const onlySource = await work("A", "article", ["工具类"]);
    const both = await work("B", "article", ["工具类", "工具"]);

    const merged = mergeTag(handle.db, actor("admin"), source.id, { targetId: target.id });

    expect(merged.id).toBe(target.id);
    expect((await repo.findById(onlySource.id))?.tags).toEqual(["工具"]);
    expect((await repo.findById(both.id))?.tags).toEqual(["工具"]);
    expect(listVocabulary(handle.db).tags.map((item) => item.label)).toEqual(["工具"]);
  });

  it("被引用的标签删除被拒；勾选同时移除后才删得掉", async () => {
    const tag = createTag(handle.db, actor("admin"), { label: "复盘" });
    const created = await work("A", "article", ["复盘"]);

    expect(() => deleteTag(handle.db, actor("admin"), tag.id)).toThrow(ConflictError);

    deleteTag(handle.db, actor("admin"), tag.id, { removeFromObjects: true });

    expect((await repo.findById(created.id))?.tags).toEqual([]);
    expect(listVocabulary(handle.db).tags).toHaveLength(0);
  });

  it("软删对象不算引用：标签使用次数归零后可删", async () => {
    const tag = createTag(handle.db, actor("admin"), { label: "复盘" });
    const created = await work("A", "article", ["复盘"]);

    await repo.softDelete(created.id);

    expect(listVocabulary(handle.db).tags.find((item) => item.id === tag.id)?.usage).toBe(0);
    expect(() => deleteTag(handle.db, actor("admin"), tag.id)).not.toThrow();
  });

  it("单个对象最多 10 个标签、单个标签最长 20 字", async () => {
    await expect(
      work("太多", "article", Array.from({ length: 11 }, (_, index) => `标签${index}`)),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(work("太长", "article", ["字".repeat(21)])).rejects.toBeInstanceOf(ValidationError);
  });

  it("未知标签不能隐式创建（TAG_NOT_FOUND），未知 id / code 报 NOT_FOUND", async () => {
    await expect(work("未知标签", "article", ["新标签"])).rejects.toMatchObject({
      code: "TAG_NOT_FOUND",
    });

    expect(() => updateTag(handle.db, actor("admin"), "missing", { label: "x" })).toThrow(NotFoundError);
    expect(() => updateCategory(handle.db, actor("admin"), "missing", { label: "x" })).toThrow(
      NotFoundError,
    );
  });
});

describe("数据库层兜底", () => {
  it("外键拒绝非法分类（绕过服务层直写）", () => {
    expect(() =>
      handle.sqlite
        .prepare(
          `insert into objects
             (id, type, title, library, source, origin, category_code, priority,
              owner_sub, revision, created_at, updated_at, status)
           values ('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'work', 'x', 'external',
                   'handwritten', 'self', 'podcast', 'medium', 'u', 1,
                   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'draft')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/i);
  });

  it("作品必须有分类（CHECK 兜底）", () => {
    expect(() =>
      handle.sqlite
        .prepare(
          `insert into objects
             (id, type, title, library, source, origin, category_code, priority,
              owner_sub, revision, created_at, updated_at, status)
           values ('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'work', 'x', 'internal',
                   'handwritten', 'self', NULL, 'medium', 'u', 1,
                   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'draft')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i);
  });

  it("objects 表只有 category_code：tags / categories / format 列都已退场", () => {
    const columns = handle.sqlite
      .prepare("select name from pragma_table_info('objects')")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(columns).toContain("category_code");
    expect(columns).not.toContain("tags");
    expect(columns).not.toContain("categories");
    expect(columns).not.toContain("format");
    expect(columns).not.toContain("primary_category");
  });
});
