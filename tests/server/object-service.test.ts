import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { actor } from "../helpers/actor";
import { seedCategory } from "../helpers/seed";

import { NotFoundError, ValidationError } from "../../src/domain/errors";
import { openDatabase, type DatabaseHandle } from "../../src/server/db/client";
import {
  changeObjectLibrary,
  changeObjectStatus,
  createObject,
  deleteObject,
  getObject,
  listObjectLibraryEvents,
  listObjects,
  parseChangeLibraryBody,
  parseChangeStatusBody,
  parseCreateObjectBody,
  parseListObjectsQuery,
  parseUpdateObjectBody,
  setObjectArchived,
  updateObject,
} from "../../src/server/services/object-service";

/**
 * 服务层测试：校验请求体收敛规则与按身份隔离的列表查询。
 */

let handle: DatabaseHandle;

beforeAll(() => {
  handle = openDatabase({ file: ":memory:" });
});

afterAll(() => {
  handle.close();
});

beforeEach(() => {
  handle.sqlite.exec(`
    DELETE FROM content_refs;
    DELETE FROM sync_jobs;
    DELETE FROM library_events;
    DELETE FROM objects;
  `);
});

describe("parseCreateObjectBody", () => {
  it("拒绝缺少标题的请求", () => {
    expect(() => parseCreateObjectBody({ type: "asset", library: "internal" }, "u1")).toThrow(
      ValidationError,
    );
  });

  it("作品必须选择分类；是否存在由词表判定", () => {
    expect(() =>
      parseCreateObjectBody({ type: "work", title: "草稿", library: "external" }, "u1"),
    ).toThrow(/分类/);

    // 分类已词表化（ADR-023）：解析层只挡空值，未知 code 由 createObject 查词表后报 NOT_FOUND。
    expect(
      parseCreateObjectBody(
        { type: "work", title: "草稿", library: "external", category: "podcast" },
        "u1",
      ).category,
    ).toBe("podcast");
  });

  it("拒绝旧字段 format 与 categories", () => {
    expect(() =>
      parseCreateObjectBody(
        { type: "asset", title: "资产", library: "internal", format: "article" },
        "u1",
      ),
    ).toThrow(/format/);

    expect(() =>
      parseCreateObjectBody(
        { type: "work", title: "草稿", library: "internal", categories: ["方法论"] },
        "u1",
      ),
    ).toThrow(/category/);
  });

  it("新建作品固定为 draft", () => {
    expect(() =>
      parseCreateObjectBody(
        { type: "work", title: "草稿", library: "internal", category: "article", status: "published" },
        "u1",
      ),
    ).toThrow(/draft/);
  });

  it("分类是单值、标签去重并去掉空白项", () => {
    const parsed = parseCreateObjectBody(
      {
        type: "asset",
        title: "  知识管理  ",
        library: "internal",
        category: "  方法论 ",
        tags: ["a", " a "],
      },
      "u1",
    );

    expect(parsed.title).toBe("知识管理");
    expect(parsed.category).toBe("方法论");
    expect(parsed.tags).toEqual(["a"]);
    expect(parsed.priority).toBe("medium");
  });
});

describe("createObject / listObjects", () => {
  it("未知分类在写入时被词表拒绝（NOT_FOUND）", async () => {
    await expect(
      createObject(handle.db, actor("u1"), {
        type: "work",
        title: "播客稿",
        library: "external",
        category: "podcast",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("写入后可按身份列出，且按 ownerSub 隔离", async () => {
    const method = seedCategory(handle, "方法论", "method");

    await createObject(handle.db, actor("u1"), {
      type: "asset",
      title: "个人方法论",
      library: "internal",
      category: method,
    });

    await createObject(handle.db, actor("u2"), {
      type: "asset",
      title: "别人的资产",
      library: "external",
    });

    const mine = await listObjects(handle.db, { ownerSub: "u1" });
    expect(mine).toHaveLength(1);
    expect(mine[0].title).toBe("个人方法论");
    expect(mine[0].category).toBe("method");
  });

  it("作品默认落为 draft，外库作品状态受约束保护", async () => {
    const work = await createObject(handle.db, actor("u1"), {
      type: "work",
      title: "一门课",
      library: "external",
      category: "course",
    });

    expect(work.type).toBe("work");
    if (work.type === "work") {
      expect(work.status).toBe("draft");
      expect(work.category).toBe("course");
    }
  });

  it("作品不能直接建在内库（WORK_MUST_BE_EXTERNAL）", async () => {
    await expect(
      createObject(handle.db, actor("u1"), {
        type: "work",
        title: "内库作品",
        library: "internal",
        category: "course",
      }),
    ).rejects.toMatchObject({ code: "WORK_MUST_BE_EXTERNAL" });
  });

  it("内库资产创建时同步完成 5 维评估（未绑定模型时走确定性兜底）", async () => {
    const asset = await createObject(handle.db, actor("u1"), {
      type: "asset",
      title: "内库资产",
      library: "internal",
    });

    expect(asset.type).toBe("asset");
    expect(asset.valueLevel).toBe("C");
    expect(asset.valueScores?.source).toBe("fallback");
    expect(asset.valueScores?.dimensions).toHaveLength(5);
    expect(asset.valueAssessedAt).not.toBeNull();
  });
});

describe("parseChangeStatusBody", () => {
  it("接受合法目标状态与正整数版本号", () => {
    expect(parseChangeStatusBody({ to: "finished" })).toEqual({ to: "finished" });
    expect(parseChangeStatusBody({ to: "published", expectedRevision: 2 })).toEqual({
      to: "published",
      expectedRevision: 2,
    });
  });

  it("拒绝未知状态与非正整数版本号", () => {
    expect(() => parseChangeStatusBody({ to: "archive" })).toThrow(ValidationError);
    expect(() => parseChangeStatusBody({ to: "finished", expectedRevision: 0 })).toThrow(
      ValidationError,
    );
    expect(() => parseChangeStatusBody({ to: "finished", expectedRevision: "2" })).toThrow(
      ValidationError,
    );
  });
});

describe("changeObjectStatus", () => {
  it("按身份推进状态；他人的对象视为不存在", async () => {
    const work = await createObject(handle.db, actor("u1"), {
      type: "work",
      title: "一门课",
      library: "external",
      category: "course",
    });

    const finished = await changeObjectStatus(handle.db, actor("u1"), work.id, { to: "finished" });
    expect(finished).toMatchObject({ type: "work", status: "finished", revision: 2 });

    await expect(
      changeObjectStatus(handle.db, actor("u2"), work.id, { to: "published" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("parseUpdateObjectBody", () => {
  it("必须带 expectedRevision，且拒绝通过编辑改库别 / 类型 / 状态", () => {
    expect(() => parseUpdateObjectBody({ title: "改名" })).toThrow(ValidationError);
    expect(() =>
      parseUpdateObjectBody({ title: "改名", expectedRevision: 1, library: "internal" }),
    ).toThrow(/library/);
    expect(() =>
      parseUpdateObjectBody({ status: "finished", expectedRevision: 1 }),
    ).toThrow(/status/);
  });

  it("显式 null 表示清空，缺席表示不变", () => {
    const patch = parseUpdateObjectBody({ description: null, expectedRevision: 2 });
    expect(patch).toEqual({ description: null, expectedRevision: 2 });
  });
});

describe("parseChangeLibraryBody", () => {
  it("迁移理由必填", () => {
    expect(() => parseChangeLibraryBody({ to: "internal" })).toThrow(ValidationError);
    expect(() => parseChangeLibraryBody({ to: "internal", reason: "  " })).toThrow(
      ValidationError,
    );
    expect(parseChangeLibraryBody({ to: "internal", reason: "已复盘" })).toEqual({
      to: "internal",
      reason: "已复盘",
    });
  });
});

describe("updateObject / changeObjectLibrary / setObjectArchived / deleteObject", () => {
  it("按身份完成编辑、归档与删除", async () => {
    const work = await createObject(handle.db, actor("u1"), {
      type: "work",
      title: "一门课",
      library: "external",
      category: "course",
    });

    const updated = await updateObject(handle.db, actor("u1"), work.id, {
      title: "一门课（终稿）",
      expectedRevision: 1,
    });
    expect(updated.title).toBe("一门课（终稿）");
    expect(updated.revision).toBe(2);

    await expect(
      updateObject(handle.db, actor("u2"), work.id, { title: "抢改", expectedRevision: 2 }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const archived = await setObjectArchived(handle.db, actor("u1"), work.id, { archived: true });
    expect(archived.archivedAt).not.toBeNull();
    expect(await listObjects(handle.db, { ownerSub: "u1" })).toHaveLength(0);

    await deleteObject(handle.db, actor("u1"), work.id);
    expect(await listObjects(handle.db, { ownerSub: "u1", includeArchived: true })).toHaveLength(
      0,
    );
  });

  it("资产可迁出内库；作品与外库资产都不能手工迁入内库", async () => {
    const asset = await createObject(handle.db, actor("u1"), {
      type: "asset",
      title: "内库资产",
      library: "internal",
    });

    const moved = await changeObjectLibrary(handle.db, actor("u1"), asset.id, {
      to: "external",
      reason: "不再作为知识资产维护",
    });
    expect(moved.library).toBe("external");

    // 规则 3：外库资产只能经 AI 高分或人工复核进入内库。
    const external = await createObject(handle.db, actor("u1"), {
      type: "asset",
      title: "外库资产",
      library: "external",
    });

    await expect(
      changeObjectLibrary(handle.db, actor("u1"), external.id, {
        to: "internal",
        reason: "手工提升",
      }),
    ).rejects.toMatchObject({ code: "LIBRARY_ENTRY_DENIED" });

    const work = await createObject(handle.db, actor("u1"), {
      type: "work",
      title: "一门课",
      library: "external",
      category: "course",
    });

    await expect(
      changeObjectLibrary(handle.db, actor("u1"), work.id, {
        to: "internal",
        reason: "旧流程",
      }),
    ).rejects.toMatchObject({ code: "WORK_MUST_BE_EXTERNAL" });
  });
});

describe("getObject / listObjectLibraryEvents", () => {
  it("按身份读取详情与迁移审计；他人对象一律 404", async () => {
    const asset = await createObject(handle.db, actor("u1"), {
      type: "asset",
      title: "内库资产",
      library: "internal",
    });

    const work = await createObject(handle.db, actor("u1"), {
      type: "work",
      title: "一门课",
      library: "external",
      category: "course",
    });

    expect((await getObject(handle.db, "u1", work.id)).title).toBe("一门课");
    await expect(getObject(handle.db, "u2", work.id)).rejects.toBeInstanceOf(NotFoundError);

    await changeObjectLibrary(handle.db, actor("u1"), asset.id, {
      to: "external",
      reason: "已复盘确认",
    });

    const events = await listObjectLibraryEvents(handle.db, "u1", asset.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      objectId: asset.id,
      fromLibrary: "internal",
      toLibrary: "external",
      reason: "已复盘确认",
      actorSub: "u1",
    });

    await expect(
      listObjectLibraryEvents(handle.db, "u2", work.id),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("parseListObjectsQuery", () => {
  it("接受合法筛选并拒绝非法取值", () => {
    const query = parseListObjectsQuery(new URLSearchParams("type=work&library=internal"));
    expect(query).toEqual({ type: "work", library: "internal" });

    expect(() => parseListObjectsQuery(new URLSearchParams("type=note"))).toThrow(ValidationError);
    expect(() => parseListObjectsQuery(new URLSearchParams("library=inner"))).toThrow(
      ValidationError,
    );
  });

  it("解析关键字、分类、标签、状态、排序与分页", () => {
    const query = parseListObjectsQuery(
      new URLSearchParams(
        "q=%20知识%20&category=方法论&tag=tag1&status=finished&sort=title&limit=20&offset=5",
      ),
    );

    expect(query).toEqual({
      search: "知识",
      category: "方法论",
      tag: "tag1",
      status: "finished",
      sort: "title",
      limit: 20,
      offset: 5,
    });
  });

  it("支持资产流水线筛选 aiStatus / valueLevel（规格 v2.0）", () => {
    const query = parseListObjectsQuery(
      new URLSearchParams("type=asset&aiStatus=needs_review&valueLevel=S"),
    );

    expect(query).toEqual({ type: "asset", aiStatus: "needs_review", valueLevel: "S" });

    expect(() => parseListObjectsQuery(new URLSearchParams("aiStatus=done"))).toThrow(
      ValidationError,
    );
    expect(() => parseListObjectsQuery(new URLSearchParams("valueLevel=D"))).toThrow(
      ValidationError,
    );
  });

  it("越界或非法的筛选值一律报错", () => {
    expect(() => parseListObjectsQuery(new URLSearchParams("sort=random"))).toThrow(
      ValidationError,
    );
    expect(() => parseListObjectsQuery(new URLSearchParams("status=done"))).toThrow(
      ValidationError,
    );
    expect(() => parseListObjectsQuery(new URLSearchParams("limit=0"))).toThrow(ValidationError);
    expect(() => parseListObjectsQuery(new URLSearchParams("limit=201"))).toThrow(ValidationError);
    expect(() => parseListObjectsQuery(new URLSearchParams("offset=-1"))).toThrow(ValidationError);
    expect(() => parseListObjectsQuery(new URLSearchParams(`q=${"长".repeat(101)}`))).toThrow(
      ValidationError,
    );
    expect(() => parseListObjectsQuery(new URLSearchParams("archived=yes"))).toThrow(
      ValidationError,
    );
  });

  it("archived 三种取值：默认排除、包含、只看归档", () => {
    expect(parseListObjectsQuery(new URLSearchParams("archived=true")).includeArchived).toBe(true);
    expect(parseListObjectsQuery(new URLSearchParams("archived=false")).includeArchived).toBeUndefined();
    expect(parseListObjectsQuery(new URLSearchParams("archived=only")).archivedOnly).toBe(true);
  });

  it("added=1d|7d|30d 换算成 createdSince，非法值报错", () => {
    const now = new Date("2026-11-14T00:00:00.000Z");

    expect(parseListObjectsQuery(new URLSearchParams("added=1d"), now).createdSince).toBe(
      "2026-11-13T00:00:00.000Z",
    );
    expect(parseListObjectsQuery(new URLSearchParams("added=7d"), now).createdSince).toBe(
      "2026-11-07T00:00:00.000Z",
    );
    expect(parseListObjectsQuery(new URLSearchParams("added=30d"), now).createdSince).toBe(
      "2026-10-15T00:00:00.000Z",
    );
    expect(parseListObjectsQuery(new URLSearchParams(), now).createdSince).toBeUndefined();

    for (const bad of ["0d", "2d", "90d", "constructor"]) {
      expect(() => parseListObjectsQuery(new URLSearchParams(`added=${bad}`), now)).toThrow(
        ValidationError,
      );
    }
  });
});

describe("listObjects createdSince（added=1d|7d|30d）", () => {
  it("只返回窗口内创建的对象", async () => {
    const { SqliteObjectRepository } = await import(
      "../../src/server/repositories/sqlite-object-repository"
    );
    const repo = new SqliteObjectRepository(handle.db);

    const old = await repo.create({
      type: "asset",
      title: "上个月新增",
      library: "external",
      ownerSub: "u1",
      now: "2026-10-01T00:00:00.000Z",
    });
    const fresh = await repo.create({
      type: "asset",
      title: "本周新增",
      library: "external",
      ownerSub: "u1",
      now: "2026-11-13T00:00:00.000Z",
    });

    const listed = await listObjects(handle.db, {
      ownerSub: "u1",
      createdSince: "2026-11-07T00:00:00.000Z",
    });

    expect(listed.map((item) => item.id)).toEqual([fresh.id]);
    expect(listed.map((item) => item.id)).not.toContain(old.id);
  });
});
