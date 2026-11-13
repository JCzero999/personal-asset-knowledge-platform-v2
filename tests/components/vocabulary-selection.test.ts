import { describe, expect, it } from "vitest";

import {
  chooseCategory,
  filterVocabulary,
  findExact,
  toggleTag,
} from "../../src/components/vocabulary-selection";

/**
 * 选择器纯逻辑（ADR-023 第 8 条）：过滤、单选、多选与回车精确命中。
 * 组件本身只做渲染，规则在这里钉死。
 */

const tags = [
  { id: "t1", normalized: "tool" },
  { id: "t2", normalized: "工具 类" },
  { id: "t3", normalized: "复盘" },
];

describe("filterVocabulary", () => {
  it("空串返回全量，按归一化子串匹配，不改原数组", () => {
    expect(filterVocabulary(tags, "")).toEqual(tags);
    expect(filterVocabulary(tags, "工具").map((item) => item.id)).toEqual(["t2"]);
    expect(filterVocabulary(tags, "zzz")).toEqual([]);
    expect(tags).toHaveLength(3);
  });
});

describe("chooseCategory", () => {
  it("单选：换一个就换，重复点同一个保持原值", () => {
    expect(chooseCategory(null, "course")).toBe("course");
    expect(chooseCategory("course", "article")).toBe("article");
    expect(chooseCategory("course", "course")).toBe("course");
    expect(chooseCategory("course", null)).toBeNull();
  });
});

describe("toggleTag", () => {
  it("未选则追加，已选则移除；归一化相等视为同一个", () => {
    const added = toggleTag([], "Tool");
    expect(added).toEqual({ value: ["Tool"], message: null });

    const removed = toggleTag(["Tool"], "ＴＯＯＬ");
    expect(removed).toEqual({ value: [], message: null });
  });

  it("最多 10 个：满员只提示，值不变", () => {
    const full = Array.from({ length: 10 }, (_, index) => `标签${index}`);

    const result = toggleTag(full, "第十一个");
    expect(result.value).toEqual(full);
    expect(result.message).toContain("10");

    // 已选中的项仍然可以取消。
    expect(toggleTag(full, "标签0").value).toHaveLength(9);
  });
});

describe("findExact", () => {
  it("只有归一化完全相等才算命中，避免回车误选近似项", () => {
    expect(findExact(tags, "tool")?.id).toBe("t1");
    expect(findExact(tags, "too")).toBeUndefined();
    expect(findExact(tags, "")).toBeUndefined();
  });
});
