import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DomainError, ConflictError, ValidationError } from "../../src/domain/errors";
import { openDatabase, type DatabaseHandle } from "../../src/server/db/client";
import { SqliteObjectRepository } from "../../src/server/repositories/sqlite-object-repository";
import { seedTag } from "../helpers/seed";
import type { CreateObjectInput } from "../../src/server/ports/object-repository";

/**
 * 仓储测试：每个用例一个全新的内存库，迁移路径与运行时一致（走 drizzle/）。
 */

const workInput: CreateObjectInput = {
  type: "work",
  title: "如何做一门课",
  library: "external",
  ownerSub: "user_test",
  category: "course",
  tags: ["教学"],
  priority: "high",
};

let handle: DatabaseHandle;
let repo: SqliteObjectRepository;

beforeAll(() => {
  // 迁移文件路径相对仓库根目录；vitest 默认在根目录运行。
  handle = openDatabase({ file: ":memory:" });
  // ADR-023：标签只能选词表已有项，先建出用例需要的标签。
  for (const label of ["教学", "tag1", "tag2"]) seedTag(handle, label);
});

afterAll(() => {
  handle.close();
});

beforeEach(() => {
  // 每个用例前清空数据，保留表结构。
  handle.sqlite.exec(`
    DELETE FROM content_refs;
    DELETE FROM sync_jobs;
    DELETE FROM library_events;
    DELETE FROM objects;
  `);
  repo = new SqliteObjectRepository(handle.db);
});

describe("objects CRUD", () => {
  it("创建作品：默认 draft、revision=1、分类取 category", async () => {
    const work = await repo.create(workInput);

    expect(work.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(work.type).toBe("work");
    expect(work.status).toBe("draft");
    expect(work.category).toBe("course");
    expect(work.revision).toBe(1);
    expect(work.createdAt).toBe(work.updatedAt);
  });

  it("创建资产：status/sourceNote 恒为 null，分类可为空", async () => {
    const asset = await repo.create({
      type: "asset",
      title: "分布式事务笔记",
      library: "internal",
      ownerSub: "user_test",
      category: "course",
    });

    expect(asset).toMatchObject({
      type: "asset",
      status: null,
      category: "course",
      sourceNote: null,
    });

    const bare = await repo.create({
      type: "asset",
      title: "未归类的剪藏",
      library: "internal",
      ownerSub: "user_test",
    });
    expect(bare.category).toBeNull();
  });

  it("作品缺少分类时拒绝写入", async () => {
    await expect(
      repo.create({ ...workInput, category: undefined }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("数据库 CHECK 捕获：绕过应用校验直接写 status 到 asset", () => {
    expect(() =>
      handle.sqlite
        .prepare(
          `insert into objects
             (id, type, title, library, source, origin, category_code, priority,
              owner_sub, revision, created_at, updated_at, status)
           values ('01HZZZZZZZZZZZZZZZZZZZZZZZ', 'asset', 'x', 'internal',
                   'handwritten', 'self', NULL, 'medium', 'u', 1,
                   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'draft')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i);
  });

  it("数据库 CHECK 拒绝内库作品（绕过状态机直写）", () => {
    expect(() =>
      handle.sqlite
        .prepare(
          `insert into objects
             (id, type, title, library, source, origin, category_code, priority,
              owner_sub, revision, created_at, updated_at, status)
           values ('01HZZZZZZZZZZZZZZZZZZZZZZZ', 'work', 'x', 'internal',
                   'handwritten', 'self', 'course', 'medium', 'u', 1,
                   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'draft')`,
        )
        .run(),
    ).toThrow(/objects_work_must_be_external/);
  });

  it("数据库 CHECK 拒绝没有 5 维分与等级的内库资产（规则 4）", () => {
    expect(() =>
      handle.sqlite
        .prepare(
          `insert into objects
             (id, type, title, library, source, origin, category_code, priority,
              owner_sub, revision, created_at, updated_at)
           values ('01HZZZZZZZZZZZZZZZZZZZZZZY', 'asset', 'x', 'internal',
                   'handwritten', 'self', NULL, 'medium', 'u', 1,
                   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/objects_internal_asset_requires_value/);
  });

  it("查询与软删除", async () => {
    const work = await repo.create(workInput);
    const asset = await repo.create({
      type: "asset",
      title: "资产",
      library: "internal",
      ownerSub: "user_test",
    });

    expect(await repo.list({ type: "work" })).toHaveLength(1);
    expect(await repo.list({ library: "internal" })).toEqual([
      expect.objectContaining({ id: asset.id }),
    ]);

    await repo.softDelete(work.id);
    expect(await repo.findById(work.id)).toBeNull();
    expect(await repo.list({ type: "work" })).toHaveLength(0);
    expect(await repo.list({ type: "work", includeDeleted: true })).toHaveLength(1);
  });

  it("更新走乐观锁：修订号不一致时报冲突", async () => {
    const work = await repo.create(workInput);

    const updated = await repo.update(work.id, {
      title: "新标题",
      expectedRevision: work.revision,
    });

    expect(updated.title).toBe("新标题");
    expect(updated.revision).toBe(2);

    await expect(
      repo.update(work.id, { title: "旧修订写回", expectedRevision: 1 }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("作品不能把分类清空，资产可以", async () => {
    const work = await repo.create(workInput);
    await expect(
      repo.update(work.id, { category: null, expectedRevision: work.revision }),
    ).rejects.toBeInstanceOf(ValidationError);

    const asset = await repo.create({
      type: "asset",
      title: "资产",
      library: "internal",
      ownerSub: "user_test",
      category: "course",
    });
    const cleared = await repo.update(asset.id, {
      category: null,
      expectedRevision: asset.revision,
    });
    expect(cleared.category).toBeNull();
  });
});

describe("作品状态迁移", () => {
  it("沿迁移表逐级推进并递增 revision", async () => {
    const work = await repo.create(workInput);

    const finished = await repo.changeStatus({ objectId: work.id, to: "finished" });
    expect(finished).toMatchObject({ type: "work", status: "finished", revision: 2 });

    const published = await repo.changeStatus({ objectId: work.id, to: "published" });
    expect(published).toMatchObject({ status: "published", revision: 3 });
    // 首次发布记录 published_at（规格 v2.0 第 3 节）
    expect(published.publishedAt).not.toBeNull();
  });

  it("跳过中间状态被拒绝", async () => {
    const work = await repo.create(workInput);

    await expect(
      repo.changeStatus({ objectId: work.id, to: "published" }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("practiced 不走状态迁移：必须走实践结算", async () => {
    const work = await repo.create(workInput);
    await repo.changeStatus({ objectId: work.id, to: "finished" });
    await repo.changeStatus({ objectId: work.id, to: "published" });

    await expect(
      repo.changeStatus({ objectId: work.id, to: "practiced" }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect((await repo.findById(work.id))?.status).toBe("published");
  });

  it("资产没有状态可迁移", async () => {
    const asset = await repo.create({
      type: "asset",
      title: "资产",
      library: "internal",
      ownerSub: "user_test",
    });

    await expect(
      repo.changeStatus({ objectId: asset.id, to: "finished" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("过期 revision 触发冲突", async () => {
    const work = await repo.create(workInput);
    await repo.changeStatus({ objectId: work.id, to: "finished" });

    await expect(
      repo.changeStatus({ objectId: work.id, to: "published", expectedRevision: 1 }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("已归档作品不能推进状态，取消归档后恢复", async () => {
    const work = await repo.create(workInput);
    await repo.archive(work.id);

    await expect(
      repo.changeStatus({ objectId: work.id, to: "finished" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await repo.unarchive(work.id);
    const finished = await repo.changeStatus({ objectId: work.id, to: "finished" });
    expect(finished.status).toBe("finished");
  });
});

describe("library 迁移与审计", () => {
  /** 作品只存在于外库（ADR-029），跨库迁移只能发生在资产上。 */
  async function externalAsset() {
    return repo.create({
      type: "asset",
      title: "外库资产",
      library: "external",
      ownerSub: "user_test",
    });
  }

  async function internalAsset() {
    return repo.create({
      type: "asset",
      title: "内库资产",
      library: "internal",
      ownerSub: "user_test",
    });
  }

  it("迁移写入 library_events 并推进 revision（内库 → 外库）", async () => {
    const asset = await internalAsset();

    const moved = await repo.changeLibrary({
      objectId: asset.id,
      to: "external",
      reason: "不再作为知识资产维护",
      actorSub: "user_test",
    });

    expect(moved.library).toBe("external");
    expect(moved.libraryChangedAt).not.toBeNull();
    expect(moved.revision).toBe(2);

    const events = await repo.listLibraryEvents(asset.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      fromLibrary: "internal",
      toLibrary: "external",
      reason: "不再作为知识资产维护",
      actorSub: "user_test",
    });
  });

  it("外库资产不能手工迁入内库（LIBRARY_ENTRY_DENIED）", async () => {
    const asset = await externalAsset();

    await expect(
      repo.changeLibrary({
        objectId: asset.id,
        to: "internal",
        reason: "手工提升",
        actorSub: "user_test",
      }),
    ).rejects.toMatchObject({ code: "LIBRARY_ENTRY_DENIED" });

    const after = await repo.findById(asset.id);
    expect(after).toMatchObject({ library: "external", revision: 1, libraryChangedAt: null });
    expect(await repo.listLibraryEvents(asset.id)).toHaveLength(0);
  });

  it("同一库别迁移被拒绝", async () => {
    const asset = await externalAsset();

    await expect(
      repo.changeLibrary({
        objectId: asset.id,
        to: "external",
        reason: "重复",
        actorSub: "user_test",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("必填迁移理由", async () => {
    const asset = await externalAsset();

    await expect(
      repo.changeLibrary({
        objectId: asset.id,
        to: "internal",
        reason: "   ",
        actorSub: "user_test",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("作品不能迁入内库（WORK_MUST_BE_EXTERNAL）", async () => {
    const work = await repo.create(workInput);

    await expect(
      repo.changeLibrary({
        objectId: work.id,
        to: "internal",
        reason: "旧流程：先迁内库再 practiced",
        actorSub: "user_test",
      }),
    ).rejects.toMatchObject({ code: "WORK_MUST_BE_EXTERNAL" });

    expect((await repo.findById(work.id))?.library).toBe("external");
  });

  it("跨库迁移同样受乐观锁保护", async () => {
    const asset = await internalAsset();
    await repo.update(asset.id, { title: "改名", expectedRevision: 1 });

    await expect(
      repo.changeLibrary({
        objectId: asset.id,
        to: "external",
        reason: "已确认",
        actorSub: "user_test",
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    const moved = await repo.changeLibrary({
      objectId: asset.id,
      to: "external",
      reason: "已确认",
      actorSub: "user_test",
      expectedRevision: 2,
    });
    expect(moved.library).toBe("external");
    expect(moved.revision).toBe(3);
  });
});

describe("归档", () => {
  it("归档与取消归档只改元数据，重复调用不涨 revision", async () => {
    const work = await repo.create(workInput);

    const archived = await repo.archive(work.id, "2026-11-11T07:00:00.000Z");
    expect(archived.archivedAt).toBe("2026-11-11T07:00:00.000Z");
    expect(archived.revision).toBe(2);

    const again = await repo.archive(work.id, "2026-11-12T07:00:00.000Z");
    expect(again.archivedAt).toBe("2026-11-11T07:00:00.000Z");
    expect(again.revision).toBe(2);

    // 默认列表不含已归档对象
    expect(await repo.list({ type: "work" })).toHaveLength(0);
    expect(await repo.list({ type: "work", includeArchived: true })).toHaveLength(1);

    const restored = await repo.unarchive(work.id, "2026-11-11T08:00:00.000Z");
    expect(restored.archivedAt).toBeNull();
    expect(restored.revision).toBe(3);

    const restoredAgain = await repo.unarchive(work.id);
    expect(restoredAgain.revision).toBe(3);
  });
});

describe("列表筛选与排序", () => {
  const asset = (patch: Partial<CreateObjectInput>): CreateObjectInput => ({
    type: "asset",
    title: "资产",
    library: "internal",
    ownerSub: "user_test",
    ...patch,
  });

  it("关键字匹配标题与描述，通配符按字面量处理", async () => {
    await repo.create(asset({ title: "知识管理", description: "第二大脑的搭建方式" }));
    await repo.create(asset({ title: "100% 完成" }));
    await repo.create(asset({ title: "无关条目" }));

    expect((await repo.list({ ownerSub: "user_test", search: "第二大脑" })).map((o) => o.title)).toEqual(
      ["知识管理"],
    );
    expect((await repo.list({ ownerSub: "user_test", search: "知识" })).map((o) => o.title)).toEqual([
      "知识管理",
    ]);
    expect((await repo.list({ ownerSub: "user_test", search: "%" })).map((o) => o.title)).toEqual([
      "100% 完成",
    ]);
  });

  it("分类按 code 或名称匹配，标签精确匹配", async () => {
    await repo.create(asset({ title: "A", category: "course", tags: ["tag1"] }));
    await repo.create(asset({ title: "B", category: "script", tags: ["tag1", "tag2"] }));
    await repo.create(asset({ title: "C", category: "course", tags: [] }));

    expect((await repo.list({ ownerSub: "user_test", category: "course" })).map((o) => o.title).sort()).toEqual(
      ["A", "C"],
    );
    expect((await repo.list({ ownerSub: "user_test", category: "课程" })).map((o) => o.title).sort()).toEqual(
      ["A", "C"],
    );
    expect((await repo.list({ ownerSub: "user_test", tag: "tag1" })).map((o) => o.title).sort()).toEqual([
      "A",
      "B",
    ]);
    expect(await repo.list({ ownerSub: "user_test", tag: "tag" })).toHaveLength(0);
  });

  it("按标题升序，limit / offset 生效", async () => {
    await repo.create(asset({ title: "B" }));
    await repo.create(asset({ title: "A" }));
    await repo.create(asset({ title: "C" }));

    const sorted = await repo.list({ ownerSub: "user_test", sort: "title" });
    expect(sorted.map((o) => o.title)).toEqual(["A", "B", "C"]);

    const page = await repo.list({ ownerSub: "user_test", sort: "title", limit: 1, offset: 1 });
    expect(page.map((o) => o.title)).toEqual(["B"]);
  });

  it("归档视图：默认排除，archivedOnly 只返回已归档", async () => {
    const active = await repo.create(asset({ title: "在用" }));
    const archived = await repo.create(asset({ title: "归档" }));
    await repo.archive(archived.id);

    expect((await repo.list({ ownerSub: "user_test" })).map((o) => o.title)).toEqual(["在用"]);
    expect(
      (await repo.list({ ownerSub: "user_test", includeArchived: true })).map((o) => o.title).sort(),
    ).toEqual(["在用", "归档"].sort());
    expect(
      (await repo.list({ ownerSub: "user_test", archivedOnly: true })).map((o) => o.id),
    ).toEqual([archived.id]);
    expect(active.archivedAt).toBeNull();
  });
});

describe("outbox 入队", () => {
  type JobRow = { owner_type: string; owner_id: string; action: string; state: string };

  function jobs(): JobRow[] {
    return handle.sqlite
      .prepare("SELECT owner_type, owner_id, action, state FROM sync_jobs ORDER BY created_at, id")
      .all() as JobRow[];
  }

  function markAllDone(): void {
    handle.sqlite.prepare("UPDATE sync_jobs SET state = 'done'").run();
  }

  it("编辑、迁移、归档都只产生一条活跃 upsert（同一对象去重）", async () => {
    // 作品不能跨库迁移（ADR-029），这里用资产覆盖「编辑 + 迁移 + 归档」三个入口。
    const asset = await repo.create({
      type: "asset",
      title: "内库资产",
      library: "internal",
      ownerSub: "user_test",
    });

    await repo.update(asset.id, { title: "改名", expectedRevision: 1 });
    await repo.changeLibrary({
      objectId: asset.id,
      to: "external",
      reason: "已确认",
      actorSub: "user_test",
      expectedRevision: 2,
    });
    await repo.archive(asset.id);

    expect(jobs()).toEqual([
      { owner_type: "asset", owner_id: asset.id, action: "upsert", state: "pending" },
    ]);
  });

  it("删除写入 delete 任务，与未完成的 upsert 并存", async () => {
    const work = await repo.create(workInput);
    await repo.update(work.id, { title: "改名", expectedRevision: 1 });
    await repo.softDelete(work.id);

    const rows = jobs();
    expect(rows.map((row) => row.action).sort()).toEqual(["delete", "upsert"]);
    expect(rows.every((row) => row.owner_id === work.id && row.state === "pending")).toBe(true);
  });

  it("任务完成后同一对象可再次入队", async () => {
    const work = await repo.create(workInput);
    await repo.update(work.id, { title: "第一次", expectedRevision: 1 });

    markAllDone();
    await repo.update(work.id, { title: "第二次", expectedRevision: 2 });

    const rows = jobs();
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.state === "pending")).toHaveLength(1);
  });

  it("冲突失败的对象更新不留下任务", async () => {
    const work = await repo.create(workInput);

    await expect(
      repo.update(work.id, { title: "抢改", expectedRevision: 99 }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(jobs()).toHaveLength(0);
  });
});

describe("仓储错误语义", () => {
  it("找不到对象时抛 NotFoundError", async () => {
    await expect(repo.softDelete("01HZZZZZZZZZZZZZZZZZZZZZZZ")).rejects.toBeInstanceOf(
      DomainError,
    );
  });

  it("重复 ULID 主键返回冲突而不是驱动异常", async () => {
    const work = await repo.create({ ...workInput, id: "01HZZZZZZZZZZZZZZZZZZZZZZZ" });

    expect(work.id).toBe("01HZZZZZZZZZZZZZZZZZZZZZZZ");
    await expect(
      repo.create({ ...workInput, id: "01HZZZZZZZZZZZZZZZZZZZZZZZ" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
