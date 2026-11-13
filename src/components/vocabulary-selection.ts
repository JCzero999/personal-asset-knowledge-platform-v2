import { MAX_TAGS_PER_OBJECT, normalizeTag } from "@/domain/vocabulary";

/**
 * 分类 / 标签选择器的纯逻辑（ADR-023 第 8 条）。
 *
 * 抽出来是为了让「过滤」「多选切换」「精确回车命中」这些行为能被测试覆盖：
 * 组件只负责渲染与弹窗，选择规则集中在这里。
 */

/** 过滤：调用方传入已归一化的 needle，空串表示不过滤。 */
export function filterVocabulary<T extends { normalized: string }>(
  pool: readonly T[],
  needle: string,
): T[] {
  return needle ? pool.filter((item) => item.normalized.includes(needle)) : [...pool];
}

/** 分类是单选：点了就换，点同一个保持原值（不会变成「未选」）。 */
export function chooseCategory(current: string | null, code: string | null): string | null {
  return code === current ? current : code;
}

/**
 * 标签是多选：已选则移除；未选且未满则追加；满员只给提示，不改值。
 * 归一化相等视为同一个标签，避免「Tool / tool」重复。
 */
export function toggleTag(
  value: readonly string[],
  label: string,
  max = MAX_TAGS_PER_OBJECT,
): { value: string[]; message: string | null } {
  const key = normalizeTag(label);

  if (value.some((item) => normalizeTag(item) === key)) {
    return { value: value.filter((item) => normalizeTag(item) !== key), message: null };
  }

  if (value.length >= max) {
    return { value: [...value], message: `最多选择 ${max} 个标签` };
  }

  return { value: [...value, label], message: null };
}

/** 回车只精确命中，避免误选一条「看起来像」的词条。 */
export function findExact<T extends { normalized: string }>(
  pool: readonly T[],
  needle: string,
): T | undefined {
  return needle ? pool.find((item) => item.normalized === needle) : undefined;
}
