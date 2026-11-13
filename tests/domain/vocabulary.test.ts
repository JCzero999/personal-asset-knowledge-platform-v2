import { describe, expect, it } from "vitest";

import {
  MAX_TAG_LENGTH,
  MAX_TAGS_PER_OBJECT,
  categoryLabelProblem,
  deriveCategoryCode,
  inlineCategoryCode,
  normalizeCategory,
  displayTagLabel,
  normalizeTag,
  normalizeTagList,
  splitTagInput,
  tagLabelProblem,
} from "../../src/domain/vocabulary";

/**
 * 标签归一化规则（R2 的 7 条）：
 * 分隔符 → 首尾空白 → 内部空白 → 全角半角 → 大小写 → 去重 → 长度。
 */
describe("归一化", () => {
  it("全角转半角、大小写与首尾空白视为同一个键", () => {
    expect(normalizeTag("ＴＯＯＬ")).toBe("tool");
    expect(normalizeTag("  Tool  ")).toBe("tool");
    expect(normalizeTag("工具 类")).toBe("工具 类");
  });

  it("内部连续空白折叠成一个，展示写法保留大小写", () => {
    expect(displayTagLabel("  工具    类 ")).toBe("工具 类");
    expect(normalizeTag("  A   B ")).toBe("a b");
  });

  it("分隔符支持半角 / 全角逗号、顿号、分号与换行，并按归一化键去重", () => {
    expect(splitTagInput("复盘,写作， 方法论、工具；\n复盘")).toEqual([
      "复盘",
      "写作",
      "方法论",
      "工具",
    ]);
    expect(splitTagInput("ＴＯＯＬ，tool")).toEqual(["TOOL"]);
  });

  it("数组写入路径同样按归一化键去重，保持首次出现的写法", () => {
    expect(normalizeTagList([" Tool", "ＴＯＯＬ", "", "  "])).toEqual(["Tool"]);
  });

  it("标签长度上限 20 字，空白标签被拒绝", () => {
    expect(tagLabelProblem("")).toContain("不能为空");
    expect(tagLabelProblem("字".repeat(MAX_TAG_LENGTH + 1))).toContain(String(MAX_TAG_LENGTH));
    expect(tagLabelProblem("字".repeat(MAX_TAG_LENGTH))).toBeNull();
    expect(MAX_TAGS_PER_OBJECT).toBe(10);
  });

  it("分类标识由 ASCII 名称推导，中文回落到给定前缀", () => {
    expect(deriveCategoryCode("Podcast Show", "c-x")).toBe("podcast-show");
    expect(deriveCategoryCode("播客", "c-abc")).toBe("c-abc");
    expect(inlineCategoryCode("A1B2C3D4")).toBe("c-a1b2c3d4");
  });

  it("分类名称按标签同样的规则归一化，长度上限 12 字", () => {
    expect(normalizeCategory("  方 法 论 ")).toBe("方 法 论");
    expect(categoryLabelProblem("")).toContain("不能为空");
    expect(categoryLabelProblem("字".repeat(13))).toContain("12");
    expect(categoryLabelProblem("字".repeat(12))).toBeNull();
  });
});
