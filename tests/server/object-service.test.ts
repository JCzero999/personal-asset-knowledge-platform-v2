import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

import { NotFoundError, ValidationError } from "../../src/domain/errors";
import { openDatabase, type DatabaseHandle } from "../../src/server/db/client";
import {
  changeObjectStatus,
  createObject,
  listObjects,
  parseChangeStatusBody,
  parseCreateObjectBody,
  parseListObjectsQuery,
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

  it("作品必须提供合法 format", () => {
    expect(() =>
      parseCreateObjectBody({ type: "work", title: "草稿", library: "external" }, "u1"),
    ).toThrow(/format/);

    expect(() =>
      parseCreateObjectBody(
        { type: "work", title: "草稿", library: "external", format: "podcast" },
        "u1",
      ),
    ).toThrow(/format/);
  });

  it("资产不接受 format", () => {
    expect(() =>
      parseCreateObjectBody(
        { type: "asset", title: "资产", library: "internal", format: "article" },
        "u1",
      ),
    ).toThrow(/format/);
  });

  it("新建作品固定为 draft", () => {
    expect(() =>
      parseCreateObjectBody(
        { type: "work", title: "草稿", library: "internal", format: "article", status: "published" },
        "u1",
      ),
    ).toThrow(/draft/);
  });

  it("分类与标签去重并去掉空白项", () => {
    const parsed = parseCreateObjectBody(
      {
        type: "asset",
        title: "  知识管理  ",
        library: "internal",
        categories: ["方法论", "方法论", "  "],
        tags: ["a", " a "],
      },
      "u1",
    );

    expect(parsed.title).toBe("知识管理");
    expect(parsed.categories).toEqual(["方法论"]);
    expect(parsed.tags).toEqual(["a"]);
    expect(parsed.priority).toBe("medium");
  });
});

describe("createObject / listObjects", () => {
  it("写入后可按身份列出，且按 ownerSub 隔离", async () => {
    await createObject(handle.db, "u1", {
      type: "asset",
      title: "个人方法论",
      library: "internal",
      categories: ["方法论"],
    });

    await createObject(handle.db, "u2", {
      type: "asset",
      title: "别人的资产",
      library: "external",
    });

    const mine = await listObjects(handle.db, { ownerSub: "u1" });
    expect(mine).toHaveLength(1);
    expect(mine[0].title).toBe("个人方法论");
    expect(mine[0].primaryCategory).toBe("方法论");
  });

  it("作品默认落为 draft，外库作品状态受约束保护", async () => {
    const work = await createObject(handle.db, "u1", {
      type: "work",
      title: "一门课",
      library: "external",
      format: "course",
    });

    expect(work.type).toBe("work");
    if (work.type === "work") {
      expect(work.status).toBe("draft");
      expect(work.format).toBe("course");
    }
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
    const work = await createObject(handle.db, "u1", {
      type: "work",
      title: "一门课",
      library: "internal",
      format: "course",
    });

    const finished = await changeObjectStatus(handle.db, "u1", work.id, { to: "finished" });
    expect(finished).toMatchObject({ type: "work", status: "finished", revision: 2 });

    await expect(
      changeObjectStatus(handle.db, "u2", work.id, { to: "published" }),
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
});
