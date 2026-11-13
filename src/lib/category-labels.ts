import type { VocabularyCategory } from "@/domain/vocabulary";

/**
 * 分类 code → 展示名称。
 *
 * 分类已经词表化（ADR-016 / ADR-023）：展示名只从数据库来，代码里不再保留
 * 任何硬编码名单，包括「读不到词表时回落到旧常量」这种兜底——那正是漏改的来源。
 */
export type CategoryLabelMap = ReadonlyMap<string, string>;

export function buildCategoryLabelMap(
  categories: ReadonlyArray<Pick<VocabularyCategory, "code" | "label">>,
): CategoryLabelMap {
  return new Map(categories.map((item) => [item.code, item.label]));
}

/** 词表里查不到就显示 code 本身，至少不会把内容藏起来。 */
export function categoryLabel(map: CategoryLabelMap, code: string): string {
  return map.get(code) ?? code;
}
