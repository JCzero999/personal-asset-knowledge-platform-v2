/**
 * 检索的纯函数层（ADR-024）：归一化、语法解析、对象级评分。
 *
 * 这一层没有任何 IO，服务端仓储、API、检索页、首页预览都复用它：
 * - 写入影子列与查询串使用同一个 `normalizeSearchText()`，全半角 / 大小写 /
 *   连续空白只有一套口径；
 * - 语法是 ADR 第 3 条确定的小子集，明确拒绝 `OR` 与括号并给出位置；
 * - 评分按 ADR 第 4 条的六级权重，纯函数便于逐档断言。
 */

export const MIN_SEARCH_LENGTH = 2;
export const MAX_SEARCH_TERMS = 30;

/** 检索模式（ADR-024 第 6 条）：默认混合，词法不碰 RAGFlow，语义不碰 SQLite。 */
export const searchModes = ["hybrid", "lexical", "semantic"] as const;
export type SearchMode = (typeof searchModes)[number];
export const DEFAULT_SEARCH_MODE: SearchMode = "hybrid";

export const searchFields = ["title", "description", "category", "tag"] as const;
export type SearchField = (typeof searchFields)[number];

export const searchFieldLabels: Record<SearchField, string> = {
  title: "标题",
  description: "描述",
  category: "分类",
  tag: "标签",
};

/** 前缀写法 → 字段。未知前缀按普通文本处理（`http://` 不会被误判）。 */
const FIELD_PREFIXES: Record<string, SearchField> = {
  title: "title",
  标题: "title",
  desc: "description",
  description: "description",
  描述: "description",
  category: "category",
  分类: "category",
  tag: "tag",
  标签: "tag",
};

/** 语法错误的可读提示，位置是原文中的 0 基下标。 */
export class SearchSyntaxError extends Error {
  readonly position: number;

  constructor(message: string, position: number) {
    super(message);
    this.name = "SearchSyntaxError";
    this.position = position;
  }
}

/**
 * 统一归一化：NFKC（全角转半角）→ 小写 → 连续空白压成一个空格 → trim。
 *
 * `title_norm` / `description_norm` 在写入时用这个函数，查询串也用它，
 * 因此 `ＡＢＣ`、`abc`、`  ABC  ` 命中的是同一批对象。
 */
export function normalizeSearchText(raw: string): string {
  return raw.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

export interface SearchTerm {
  /** null 表示不限定字段（标题 / 描述 / 分类 / 标签任一命中即可）。 */
  field: SearchField | null;
  /** 归一化后的检索值，SQL 与内存匹配都用它。 */
  value: string;
  /** 用户原文（去掉字段前缀与引号），只用于展示与高亮。 */
  raw: string;
  phrase: boolean;
  negated: boolean;
  /** 原文中的起始位置，语法提示与测试断言使用。 */
  position: number;
}

export interface ParsedSearchQuery {
  raw: string;
  /** 整串归一化结果；长度门槛按它计算。 */
  normalized: string;
  terms: SearchTerm[];
  positive: SearchTerm[];
  negative: SearchTerm[];
  /** 需要提示一次的情况（目前只有 `~`）。 */
  hint: string | null;
}

function resolveField(prefix: string): SearchField | null {
  return FIELD_PREFIXES[prefix.toLowerCase()] ?? null;
}

function isWordBoundary(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char) || char === '"' || char === "(" || char === ")";
}

/** 读取从 `start`（指向开引号）开始的引号短语；未闭合时在开引号处报错。 */
function readQuoted(input: string, start: number): { value: string; end: number } {
  let cursor = start + 1;

  while (cursor < input.length) {
    if (input[cursor] === '"') {
      return { value: input.slice(start + 1, cursor), end: cursor + 1 };
    }
    cursor += 1;
  }

  throw new SearchSyntaxError("引号没有闭合，请补上结尾的双引号", start);
}

/**
 * 解析一段检索输入。
 *
 * 支持：空格 AND、`"短语"`、`title:` / `标题:`、`desc:` / `描述:`、
 * `category:` / `分类:`、`tag:` / `标签:`、`-词` 排除、`AND` 同义、`NOT` 等价 `-`。
 * 拒绝：`OR`、括号、未闭合引号、孤立的 `-`、空检索。
 */
export function parseSearchInput(raw: string): ParsedSearchQuery {
  const input = raw;
  const terms: SearchTerm[] = [];
  let hint: string | null = null;
  let negated = false;
  let negationPosition = -1;
  let index = 0;

  const pushTerm = (field: SearchField | null, value: string, phrase: boolean, position: number) => {
    const normalized = normalizeSearchText(value);

    if (!normalized) {
      throw new SearchSyntaxError("检索词不能为空", position);
    }

    terms.push({ field, value: normalized, raw: value, phrase, negated, position });
    negated = false;
    negationPosition = -1;
  };

  while (index < input.length) {
    const char = input[index];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === "(" || char === ")") {
      throw new SearchSyntaxError("不支持括号分组：请去掉括号，用空格分隔多个检索词", index);
    }

    // 排除前缀：`-词`、`-"短语"`、`-标签:工具`。
    if (char === "-") {
      const next = input[index + 1];

      if (next === undefined || /\s/.test(next)) {
        throw new SearchSyntaxError("“-” 后面缺少要排除的词", index);
      }

      if (negated) {
        throw new SearchSyntaxError("多个排除标记连在一起，请只保留一个“-”", index);
      }

      negated = true;
      negationPosition = index;
      index += 1;
      continue;
    }

    if (char === '"') {
      const quoted = readQuoted(input, index);
      pushTerm(null, quoted.value, true, index);
      index = quoted.end;
      continue;
    }

    let end = index;
    while (end < input.length && !isWordBoundary(input[end])) end += 1;
    const word = input.slice(index, end);

    // `title:"个人知识系统"`：前缀后紧跟引号，按短语处理。
    if (word.endsWith(":") && end < input.length && input[end] === '"') {
      const field = resolveField(word.slice(0, -1));

      if (field) {
        const quoted = readQuoted(input, end);
        pushTerm(field, quoted.value, true, index);
        index = quoted.end;
        continue;
      }
    }

    const upper = word.toUpperCase();

    if (upper === "AND") {
      // 与空格等价，纯粹为了兼容旧输入习惯。
      if (negated) {
        throw new SearchSyntaxError("“-”/NOT 后面缺少要排除的词", negationPosition);
      }
      index = end;
      continue;
    }

    if (upper === "OR") {
      throw new SearchSyntaxError(
        "不支持 OR：请分两次检索，或用分类 / 标签筛选来收窄范围",
        index,
      );
    }

    if (upper === "NOT") {
      if (negated) {
        throw new SearchSyntaxError("多个排除标记连在一起，请只保留一个", index);
      }
      negated = true;
      negationPosition = index;
      index = end;
      continue;
    }

    // `title:知识`：已知前缀且值非空才当字段；否则整词按普通文本（`http:` 等）。
    const colon = word.indexOf(":");
    if (colon > 0) {
      const field = resolveField(word.slice(0, colon));

      if (field) {
        const value = word.slice(colon + 1);

        if (!value) {
          throw new SearchSyntaxError("字段前缀后面缺少检索词", index);
        }

        if (value.includes("~")) hint ??= "“~” 已按普通字符处理，子串匹配本身已经是模糊匹配";
        pushTerm(field, value, false, index);
        index = end;
        continue;
      }
    }

    if (word.includes("~")) hint ??= "“~” 已按普通字符处理，子串匹配本身已经是模糊匹配";

    pushTerm(null, word, false, index);
    index = end;
  }

  if (negated) {
    throw new SearchSyntaxError("“-”/NOT 后面缺少要排除的词", negationPosition);
  }

  if (terms.length === 0) {
    throw new SearchSyntaxError("请输入至少一个检索词", 0);
  }

  if (terms.length > MAX_SEARCH_TERMS) {
    throw new SearchSyntaxError(`检索词最多 ${MAX_SEARCH_TERMS} 个，请减少条件`, 0);
  }

  const positive = terms.filter((term) => !term.negated);
  const negative = terms.filter((term) => term.negated);

  return {
    raw,
    normalized: normalizeSearchText(raw),
    terms,
    positive,
    negative,
    hint,
  };
}

/** 归一化后是否达到检索门槛（中文 2 字）。 */
export function meetsSearchLength(parsed: ParsedSearchQuery): boolean {
  return [...parsed.normalized].length >= MIN_SEARCH_LENGTH;
}

export interface LexicalCandidateText {
  title: string;
  description: string | null;
  categoryLabel: string | null;
  tagLabels: readonly string[];
}

export interface LexicalMatch {
  score: number;
  matchedFields: SearchField[];
  /** 摘要高亮用的词（去重、长词优先）。 */
  highlightTerms: string[];
}

/** ADR-024 第 4 条的六级权重；语义层另算 30 + 15 × similarity。 */
export const LEXICAL_SCORES = {
  titleExact: 100,
  titleContains: 80,
  titlePrefixBonus: 10,
  categoryExact: 70,
  tagExact: 65,
  categoryOrTagContains: 50,
  descriptionContains: 20,
} as const;

/**
 * 对象级评分：同一对象多条证据取最高层，`matchedFields` 取并集。
 *
 * 返回 null 表示不匹配（任一正词落空，或命中任一排除词）。SQL 侧已经按
 * 同样的条件过滤过，这里是排序与「命中在哪」的唯一权威。
 */
export function matchLexicalObject(
  candidate: LexicalCandidateText,
  terms: readonly SearchTerm[],
): LexicalMatch | null {
  const title = normalizeSearchText(candidate.title);
  const description = candidate.description ? normalizeSearchText(candidate.description) : "";
  const category = candidate.categoryLabel ? normalizeSearchText(candidate.categoryLabel) : "";
  const tags = candidate.tagLabels
    .map((label) => normalizeSearchText(label))
    .filter((label) => label.length > 0);

  const values: Record<SearchField, string[]> = {
    title: [title],
    description: [description],
    category: category ? [category] : [],
    tag: tags,
  };

  const fieldsOf = (term: SearchTerm): readonly SearchField[] =>
    term.field ? [term.field] : searchFields;

  const hitsField = (term: SearchTerm, field: SearchField): boolean =>
    values[field].some((value) => value.includes(term.value));

  for (const term of terms) {
    if (!term.negated) continue;

    if (fieldsOf(term).some((field) => hitsField(term, field))) {
      return null;
    }
  }

  const matched: Record<SearchField, SearchTerm[]> = {
    title: [],
    description: [],
    category: [],
    tag: [],
  };

  for (const term of terms) {
    if (term.negated) continue;

    let hit = false;
    for (const field of fieldsOf(term)) {
      if (hitsField(term, field)) {
        matched[field].push(term);
        hit = true;
      }
    }

    if (!hit) return null;
  }

  const positive = terms.filter((term) => !term.negated);
  const single = positive.length === 1 ? positive[0] : null;

  let score = 0;

  // T1 标题完全相等（仅单词裸查询）。
  if (single && single.field === null && !single.phrase && title === single.value) {
    score = Math.max(score, LEXICAL_SCORES.titleExact);
  }

  // T2 标题包含。
  if (matched.title.length > 0) {
    const prefix = matched.title.some((term) => title.startsWith(term.value));
    score = Math.max(
      score,
      LEXICAL_SCORES.titleContains + (prefix ? LEXICAL_SCORES.titlePrefixBonus : 0),
    );
  }

  // T3 分类 / 标签名精确相等。
  if (matched.category.some((term) => category === term.value)) {
    score = Math.max(score, LEXICAL_SCORES.categoryExact);
  }
  if (matched.tag.some((term) => tags.includes(term.value))) {
    score = Math.max(score, LEXICAL_SCORES.tagExact);
  }

  // T4 分类 / 标签名包含。
  if (matched.category.length > 0 || matched.tag.length > 0) {
    score = Math.max(score, LEXICAL_SCORES.categoryOrTagContains);
  }

  // T6 描述包含（描述常是套话，排最后）。
  if (matched.description.length > 0) {
    score = Math.max(score, LEXICAL_SCORES.descriptionContains);
  }

  const highlightTerms = [...new Set(positive.map((term) => term.value))]
    .sort((a, b) => b.length - a.length);

  return {
    score,
    matchedFields: searchFields.filter((field) => matched[field].length > 0),
    highlightTerms,
  };
}

/** 对象级排序：分数降序 → 更新时间倒序 → id 升序（保证稳定）。 */
export function compareSearchRank(
  a: { score: number; updatedAt: string; id: string },
  b: { score: number; updatedAt: string; id: string },
): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
