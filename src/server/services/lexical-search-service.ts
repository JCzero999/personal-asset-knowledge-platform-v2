import type { BusinessObject, Library } from "../../domain/objects";
import {
  compareSearchRank,
  matchLexicalObject,
  meetsSearchLength,
  type ParsedSearchQuery,
  type SearchField,
} from "../../lib/search-query";
import type { AppDatabase } from "../db/client";
import { SqliteObjectRepository } from "../repositories/sqlite-object-repository";

/**
 * 词法检索编排（ADR-024）。
 *
 * 仓储只负责「按条件取候选」，这里做对象级评分、排序与摘要来源；
 * 完全不涉及 RAGFlow，`mode=lexical` 与首页预览都走这一条路径。
 */

/** ADR-024 第 9 条：一次最多取 500 条，超出标记 truncated。 */
export const MAX_LEXICAL_RESULTS = 500;

export interface LexicalHit {
  object: BusinessObject;
  score: number;
  matchedFields: SearchField[];
  highlightTerms: string[];
  /** 摘要原文（描述或「分类 · 标签」兜底），高亮由展示层生成。 */
  snippetSource: string;
  categoryLabel: string | null;
}

export interface LexicalResult {
  hits: LexicalHit[];
  total: number;
  truncated: boolean;
  hint: string | null;
}

export interface LexicalSearchOptions {
  library?: Library;
  /** 候选上限，默认 500；首页预览只取 8 条。 */
  limit?: number;
}

/** 摘要来源：描述优先；没有描述时退成「分类：X · 标签：Y」。 */
export function buildSummarySource(input: {
  description: string | null;
  categoryLabel: string | null;
  tags: readonly string[];
}): string {
  const description = input.description?.trim();
  if (description) return description;

  const parts: string[] = [];
  if (input.categoryLabel) parts.push(`分类：${input.categoryLabel}`);
  if (input.tags.length > 0) parts.push(`标签：${input.tags.join("、")}`);

  return parts.join(" · ");
}

export async function lexicalSearch(
  db: AppDatabase,
  ownerSub: string,
  parsed: ParsedSearchQuery,
  options: LexicalSearchOptions = {},
): Promise<LexicalResult> {
  if (!meetsSearchLength(parsed)) {
    return {
      hits: [],
      total: 0,
      truncated: false,
      hint: "至少输入 2 个字",
    };
  }

  const limit = Math.max(1, Math.min(options.limit ?? MAX_LEXICAL_RESULTS, MAX_LEXICAL_RESULTS));
  const repository = new SqliteObjectRepository(db);
  const { candidates, truncated } = await repository.lexicalSearch({
    ownerSub,
    terms: parsed.terms.map((term) => ({
      field: term.field,
      value: term.value,
      negated: term.negated,
    })),
    ...(options.library ? { library: options.library } : {}),
    limit,
  });

  const hits: LexicalHit[] = [];

  for (const candidate of candidates) {
    const match = matchLexicalObject(
      {
        title: candidate.object.title,
        description: candidate.object.description,
        categoryLabel: candidate.categoryLabel,
        tagLabels: candidate.object.tags,
      },
      parsed.terms,
    );

    if (!match) continue;

    hits.push({
      object: candidate.object,
      score: match.score,
      matchedFields: match.matchedFields,
      highlightTerms: match.highlightTerms,
      snippetSource: buildSummarySource({
        description: candidate.object.description,
        categoryLabel: candidate.categoryLabel,
        tags: candidate.object.tags,
      }),
      categoryLabel: candidate.categoryLabel,
    });
  }

  hits.sort((a, b) =>
    compareSearchRank(
      { score: a.score, updatedAt: a.object.updatedAt, id: a.object.id },
      { score: b.score, updatedAt: b.object.updatedAt, id: b.object.id },
    ),
  );

  const hint = parsed.hint ?? (truncated ? "结果较多，请加关键词收窄范围" : null);

  return { hits, total: hits.length, truncated, hint };
}
