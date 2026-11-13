import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { actor } from "../helpers/actor";

import { NotFoundError, ValidationError } from "../../src/domain/errors";
import { openDatabase, type DatabaseHandle } from "../../src/server/db/client";
import {
  createObject,
  parseCreateObjectBody,
  parseUpdateObjectBody,
  updateObject,
} from "../../src/server/services/object-service";
import { createCategory, createTag } from "../../src/server/services/vocabulary-service";

/**
 * 新建 / 编辑一致性（ADR-023 第 8、9 条）：
 * 两个弹窗用同一组字段 `category`（单选）+ `tags`（多选），
 * 走同一条服务路径，保存后读回的值必须一致。
 */

let handle: DatabaseHandle;

beforeEach(() => {
  handle = openDatabase({ file: ":memory:" });
  handle.sqlite.exec(`
    DELETE FROM sync_jobs;
    DELETE FROM library_events;
    DELETE FROM objects;
  `);
});

afterAll(() => {
  handle?.close();
});

describe("新建与编辑共用分类 / 标签字段", () => {
  it("内联新建的分类可立即用于新建作品，编辑时原样往返", async () => {
    const { category } = createCategory(handle.db, actor("u1"), {
      label: "播客",
      source: "inline",
    });
    const tag = createTag(handle.db, actor("u1"), { label: "复盘", source: "inline" });

    const created = await createObject(
      handle.db,
      actor("u1"),
      parseCreateObjectBody(
        {
          type: "work",
          title: "第一期",
          library: "internal",
          category: category.code,
          tags: [tag.label],
        },
        "u1",
      ),
    );

    expect(created).toMatchObject({ type: "work", category: category.code, tags: ["复盘"] });

    // 编辑弹窗提交同一组字段：值不变，修订号 +1。
    const edited = await updateObject(
      handle.db,
      actor("u1"),
      created.id,
      parseUpdateObjectBody({
        title: "第一期（终稿）",
        category: category.code,
        tags: [tag.label],
        expectedRevision: 1,
      }),
    );

    expect(edited).toMatchObject({
      title: "第一期（终稿）",
      category: category.code,
      tags: ["复盘"],
      revision: 2,
    });
  });

  it("资产可以不选分类；编辑时可补选，也可清空", async () => {
    const asset = await createObject(
      handle.db,
      actor("u1"),
      parseCreateObjectBody({ type: "asset", title: "剪藏", library: "external" }, "u1"),
    );
    expect(asset.category).toBeNull();

    const withCategory = await updateObject(
      handle.db,
      actor("u1"),
      asset.id,
      parseUpdateObjectBody({ category: "course", expectedRevision: 1 }),
    );
    expect(withCategory.category).toBe("course");

    const cleared = await updateObject(
      handle.db,
      actor("u1"),
      asset.id,
      parseUpdateObjectBody({ category: null, expectedRevision: 2 }),
    );
    expect(cleared.category).toBeNull();
  });

  it("作品编辑时清空分类被拒绝", async () => {
    const work = await createObject(
      handle.db,
      actor("u1"),
      parseCreateObjectBody(
        { type: "work", title: "不能没有分类", library: "internal", category: "article" },
        "u1",
      ),
    );

    await expect(
      updateObject(
        handle.db,
        actor("u1"),
        work.id,
        parseUpdateObjectBody({ category: null, expectedRevision: 1 }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("停用分类不能被新选，但保持原值的编辑不受影响", async () => {
    const { category } = createCategory(handle.db, actor("u1"), { label: "课程笔记" });
    const work = await createObject(
      handle.db,
      actor("u1"),
      parseCreateObjectBody(
        { type: "work", title: "旧作品", library: "internal", category: category.code },
        "u1",
      ),
    );

    handle.sqlite
      .prepare("update categories set state = 'archived' where code = ?")
      .run(category.code);

    // 保持原值：允许。
    const untouched = await updateObject(
      handle.db,
      actor("u1"),
      work.id,
      parseUpdateObjectBody({ title: "改名", category: category.code, expectedRevision: 1 }),
    );
    expect(untouched.category).toBe(category.code);

    // 资产改成停用分类：拒绝。
    const asset = await createObject(
      handle.db,
      actor("u1"),
      parseCreateObjectBody({ type: "asset", title: "剪藏", library: "internal" }, "u1"),
    );

    await expect(
      updateObject(
        handle.db,
        actor("u1"),
        asset.id,
        parseUpdateObjectBody({ category: category.code, expectedRevision: 1 }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("新建与编辑都只接受 category，旧字段直接报错", () => {
    expect(() =>
      parseCreateObjectBody(
        { type: "work", title: "x", library: "internal", format: "article" },
        "u1",
      ),
    ).toThrow(/category/);

    expect(() => parseUpdateObjectBody({ categories: ["x"], expectedRevision: 1 })).toThrow(
      /category/,
    );
  });
});
