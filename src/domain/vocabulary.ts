/**
 * 分类（categories）与标签（tags）的纯领域规则（ADR-016 / ADR-023）。
 *
 * 这里只放「归一化 + 上限」这类与 IO 无关的规则：迁移种子、服务层、
 * 前端提示都复用同一份实现，避免前后端各写一套查重口径。
 *
 * ADR-023 起「作品形态」并入「分类」：一个概念只保留一个名字。
 */

export const categoryStates = ["active", "archived"] as const;
export type CategoryState = (typeof categoryStates)[number];

export function isCategoryState(value: unknown): value is CategoryState {
  return value === "active" || value === "archived";
}

/** 词表读取的统一形状：`GET /api/vocabulary` 的 `categories[]` 元素。 */
export interface VocabularyCategory {
  code: string;
  label: string;
  /** 查重键：展示文本小写；唯一。 */
  normalized: string;
  sortOrder: number;
  state: CategoryState;
  /** 内置分类不可删除（只能改名、排序、停用）。 */
  isSystem: boolean;
  /** 引用它的未删除对象数（资产也计入）。 */
  usage: number;
}

export interface VocabularyTag {
  id: string;
  label: string;
  /** 归一化键，唯一；查重、合并都按它。 */
  normalized: string;
  sortOrder: number;
  /** 引用它的未删除对象数（软删对象不计）。 */
  usage: number;
}

export interface VocabularySnapshot {
  categories: VocabularyCategory[];
  tags: VocabularyTag[];
}

/** 分类名称 1–12 字；标识 2–32 位小写字母 / 数字 / 连字符 / 下划线。 */
export const MAX_CATEGORY_LABEL = 12;
export const MAX_CATEGORY_CODE = 32;
export const CATEGORY_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;
/** 启用分类上限：新建面板要一次显示完，不做分页。 */
export const MAX_ACTIVE_CATEGORIES = 30;

/** 标签长度与数量上限（R2 归一化规则第 6、7 条）。 */
export const MAX_TAG_LENGTH = 20;
export const MAX_TAGS_PER_OBJECT = 10;
/** 全局标签软上限：超出只警告不拦。 */
export const TAG_SOFT_LIMIT = 500;

/** 分隔符：半角逗号、全角逗号、顿号、分号与换行都算（沿用旧项目的 splitList 口径）。 */
const TAG_SEPARATORS = /[,，、;；\r\n]+/;

/**
 * 展示用文本：全角转半角（NFKC）、连续空白压成一个、去首尾空白。
 * 大小写保留首次创建时的写法，因此这里**不**做小写化。
 */
export function displayLabel(raw: string): string {
  return raw.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** 标签展示文本（历史命名，等价于 displayLabel）。 */
export function displayTagLabel(raw: string): string {
  return displayLabel(raw);
}

/** 归一化键：在展示文本基础上小写。`ＴＯＯＬ` / `Tool` / ` tool ` 三者同键。 */
export function normalizeTag(raw: string): string {
  return displayLabel(raw).toLowerCase();
}

/** 分类查重键；与标签同一套归一化口径（ADR-023 第 3 条）。 */
export function normalizeCategory(raw: string): string {
  return normalizeTag(raw);
}

/**
 * 把一段用户输入切成标签：按分隔符切、逐项归一化、按归一化键去重。
 * 空项丢弃；保留首次出现的写法（R2「重复不报错」）。
 */
export function splitTagInput(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const piece of raw.split(TAG_SEPARATORS)) {
    const label = displayLabel(piece);

    if (!label) continue;

    const key = label.toLowerCase();

    if (seen.has(key)) continue;

    seen.add(key);
    result.push(label);
  }

  return result;
}

/** 服务端写入路径：数组也要去重（按归一化键），并保持原顺序。 */
export function normalizeTagList(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const label = displayLabel(value);

    if (!label) continue;

    const key = label.toLowerCase();

    if (seen.has(key)) continue;

    seen.add(key);
    result.push(label);
  }

  return result;
}

/** 标签是否合法：1–20 字，且不能只有空白。返回原因便于拼错误信息。 */
export function tagLabelProblem(label: string): string | null {
  if (!label) return "标签不能为空";

  if ([...label].length > MAX_TAG_LENGTH) {
    return `单个标签不能超过 ${MAX_TAG_LENGTH} 个字`;
  }

  return null;
}

/** 分类名称校验；返回 null 表示合法。 */
export function categoryLabelProblem(label: string): string | null {
  if (!label) return "分类名称不能为空";

  if ([...label].length > MAX_CATEGORY_LABEL) {
    return `分类名称不能超过 ${MAX_CATEGORY_LABEL} 个字`;
  }

  return null;
}

/** 由名称推导一个可用的标识：ASCII 名称转 slug，中文名称用回退前缀。 */
export function deriveCategoryCode(label: string, fallback: string): string {
  const slug = displayLabel(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (slug.length >= 2) {
    return slug.slice(0, MAX_CATEGORY_CODE);
  }

  return fallback;
}

/**
 * 内联新建分类的 code（ADR-023 M5）：`c-` + 8 位小写十六进制。
 * 中文名称不参与 code 生成，避免音译与重名。
 */
export function inlineCategoryCode(randomHex: string): string {
  return `c-${randomHex.toLowerCase()}`;
}
