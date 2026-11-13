import type { BusinessObject, Library } from "../../domain/objects";
import { libraries } from "../../domain/objects";
import { NotFoundError, QuerySyntaxError, ValidationError } from "../../domain/errors";
import {
  DEFAULT_SEARCH_MODE,
  meetsSearchLength,
  parseSearchInput,
  SearchSyntaxError,
  searchModes,
  type ParsedSearchQuery,
  type SearchField,
  type SearchMode,
} from "../../lib/search-query";
import {
  createRagflowClientFromEnv,
  type RagflowDataset,
  type RagflowRetrievalResult,
} from "../adapters/ragflow";
import type { AppDatabase } from "../db/client";
import { SqliteContentStore } from "../repositories/sqlite-content-store";
import { DEFAULT_DATASET_NAME } from "./content-service";
import {
  lexicalSearch,
  MAX_LEXICAL_RESULTS,
  type LexicalHit,
  type LexicalResult,
} from "./lexical-search-service";
import { getObject } from "./object-service";

/**
 * 内容检索编排（ADR-001 / ADR-024）。
 *
 * 两条召回并行：
 * - 词法层（SQLite）负责标题 / 描述 / 分类 / 标签的元数据子串匹配；
 * - 语义层（RAGFlow）负责正文片段，3 秒硬超时，失败只降级不报错。
 *
 * 正文不在 SQLite，词法层搜不到正文——这是明确的产品边界，文案里不假装。
 */

export const SEARCH_MODES = searchModes;
export type { SearchMode };
/** ADR-024 第 6 条：RAGFlow 3 秒硬超时。 */
export const SEMANTIC_TIMEOUT_MS = 3000;

export type SemanticStatus = "ok" | "timeout" | "unavailable" | "no_dataset" | "skipped";

export interface SearchGateway {
  listDatasets(query?: { name?: string; pageSize?: number }): Promise<RagflowDataset[]>;
  retrieve(input: {
    question: string;
    datasetIds: string[];
    pageSize?: number;
    similarityThreshold?: number;
  }): Promise<RagflowRetrievalResult>;
}

export interface SearchQuery {
  question: string;
  limit?: number;
  library?: Library;
  similarityThreshold?: number;
  mode?: SearchMode;
}

export interface SearchObjectRef {
  id: string;
  type: BusinessObject["type"];
  title: string;
  library: Library;
  status: BusinessObject["status"];
  category: BusinessObject["category"];
  tags: string[];
}

/**
 * 统一命中。旧键全部保留，词法独有项在语义结果里为 null（ADR-024 第 7 条），
 * 新增 `source` / `score` / `matchedFields` / `chunkCount` / `highlightTerms`。
 */
export interface SearchHit {
  chunkId: string | null;
  content: string;
  highlight: string | null;
  similarity: number | null;
  documentId: string | null;
  documentName: string | null;
  refId: string | null;
  role: "primary" | "attachment" | null;
  object: SearchObjectRef;
  source: "lexical" | "semantic" | "both";
  score: number;
  matchedFields: SearchField[];
  chunkCount: number;
  /** 词法命中词，供页面做摘要高亮；语义命中为空数组。 */
  highlightTerms: string[];
}

export interface SearchResult {
  question: string;
  mode: SearchMode;
  hits: SearchHit[];
  /** 合并去重后的对象数（ADR-024 语义变化，旧调用方读 semantic.total）。 */
  total: number;
  counts: { lexical: number; semantic: number; merged: number };
  lexical: { total: number; truncated: boolean; hint: string | null };
  semantic: { total: number; status: SemanticStatus; thresholdApplied: boolean };
  library: Library | null;
}

export interface SearchOptions {
  client?: SearchGateway;
  env?: Record<string, string | undefined>;
  /** 测试用：覆盖 3 秒超时。 */
  semanticTimeoutMs?: number;
}

const MAX_QUESTION_LENGTH = 200;

export function parseSearchQuery(params: URLSearchParams): SearchQuery {
  const question = (params.get("q") ?? "").trim();
  if (!question) {
    throw new ValidationError("搜索词 q 不能为空", { field: "q" });
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    throw new ValidationError(`搜索词不能超过 ${MAX_QUESTION_LENGTH} 个字符`, { field: "q" });
  }

  const query: SearchQuery = { question };

  const rawLimit = params.get("limit");
  if (rawLimit !== null) {
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new ValidationError("limit 必须是 1 到 50 的整数", { field: "limit" });
    }
    query.limit = limit;
  }

  const library = params.get("library");
  if (library !== null) {
    if (!(libraries as readonly string[]).includes(library)) {
      throw new ValidationError("library 取值非法", { field: "library", allowed: libraries });
    }
    query.library = library as Library;
  }

  const rawThreshold = params.get("threshold");
  if (rawThreshold !== null) {
    const threshold = Number(rawThreshold);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new ValidationError("threshold 必须是 0 到 1 之间的小数", { field: "threshold" });
    }
    query.similarityThreshold = threshold;
  }

  const mode = params.get("mode");
  if (mode !== null) {
    if (!(SEARCH_MODES as readonly string[]).includes(mode)) {
      throw new ValidationError("mode 只能是 hybrid / lexical / semantic", {
        field: "mode",
        allowed: SEARCH_MODES,
      });
    }
    query.mode = mode as SearchMode;
  }

  return query;
}

/** 检索只读 dataset，不创建；库不存在说明还没有任何内容。 */
async function resolveDatasetId(
  client: SearchGateway,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  const configuredId = env.RAGFLOW_DATASET_ID?.trim();
  if (configuredId) {
    return configuredId;
  }

  const name = env.RAGFLOW_DATASET_NAME?.trim() || DEFAULT_DATASET_NAME;
  try {
    const datasets = await client.listDatasets({ name, pageSize: 100 });
    return datasets.find((dataset) => dataset.name === name && dataset.id)?.id ?? null;
  } catch (error) {
    if (error instanceof NotFoundError) {
      return null;
    }
    throw error;
  }
}

interface SemanticHit {
  chunkId: string;
  content: string;
  highlight: string | null;
  similarity: number;
  documentId: string;
  documentName: string | null;
  refId: string;
  role: "primary" | "attachment";
  object: BusinessObject;
}

interface SemanticOutcome {
  status: Exclude<SemanticStatus, "skipped">;
  hits: SemanticHit[];
  total: number;
}

/** 语义召回 + 归属 / 归档 / 库别过滤；与改造前逐条一致。 */
async function runSemanticRequest(
  db: AppDatabase,
  ownerSub: string,
  query: SearchQuery,
  limit: number,
  options: SearchOptions,
): Promise<SemanticOutcome> {
  const env = options.env ?? process.env;
  const client = options.client ?? (createRagflowClientFromEnv(env) as SearchGateway);
  const datasetId = await resolveDatasetId(client, env);

  if (!datasetId) {
    return { status: "no_dataset", hits: [], total: 0 };
  }

  // 多召回一些，抵消归属、归档过滤造成的损耗。
  const retrieved = await client.retrieve({
    question: query.question,
    datasetIds: [datasetId],
    pageSize: Math.min(limit * 3, 50),
    ...(query.similarityThreshold !== undefined
      ? { similarityThreshold: query.similarityThreshold }
      : {}),
  });

  const store = new SqliteContentStore(db);
  const documentIds = [...new Set(retrieved.chunks.map((chunk) => chunk.documentId))];
  const refs = await store.findByDocuments(datasetId, documentIds);
  const refByDocument = new Map(refs.map((ref) => [ref.documentId, ref]));

  const objects = new Map<string, BusinessObject | null>();
  for (const ref of refs) {
    if (objects.has(ref.ownerId)) continue;
    objects.set(
      ref.ownerId,
      await getObject(db, ownerSub, ref.ownerId).catch(() => null),
    );
  }

  const hits: SemanticHit[] = [];
  for (const chunk of retrieved.chunks) {
    if (hits.length >= limit) break;

    const ref = refByDocument.get(chunk.documentId);
    if (!ref) continue;
    const object = objects.get(ref.ownerId);
    if (!object || object.archivedAt !== null) continue;
    if (query.library && object.library !== query.library) continue;

    hits.push({
      chunkId: chunk.id,
      content: chunk.content,
      highlight: chunk.highlight,
      similarity: chunk.similarity,
      documentId: chunk.documentId,
      documentName: chunk.documentName,
      refId: ref.id,
      role: ref.role,
      object,
    });
  }

  return { status: "ok", hits, total: hits.length };
}

/** 语义阶段永远以状态返回：超时 / 网络 / 未建 dataset 都不让搜索失败。 */
async function runSemanticWithTimeout(
  db: AppDatabase,
  ownerSub: string,
  query: SearchQuery,
  limit: number,
  options: SearchOptions,
): Promise<SemanticOutcome> {
  const timeoutMs = options.semanticTimeoutMs ?? SEMANTIC_TIMEOUT_MS;

  let timer: ReturnType<typeof setTimeout> | null = null;

  const work = runSemanticRequest(db, ownerSub, query, limit, options).catch((error) => {
    console.error("[search] 语义检索降级", error);
    return { status: "unavailable" as const, hits: [], total: 0 };
  });

  const timeout = new Promise<SemanticOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout", hits: [], total: 0 }), timeoutMs);
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function toObjectRef(object: BusinessObject): SearchObjectRef {
  return {
    id: object.id,
    type: object.type,
    title: object.title,
    library: object.library,
    status: object.status,
    category: object.category,
    tags: object.tags,
  };
}

function semanticScore(similarity: number): number {
  // T5：30 + 15 × similarity（30–45）。
  return 30 + 15 * Math.min(1, Math.max(0, similarity));
}

function fromLexical(hit: LexicalHit): SearchHit {
  return {
    chunkId: null,
    content: hit.snippetSource,
    highlight: null,
    similarity: null,
    documentId: null,
    documentName: null,
    refId: null,
    role: null,
    object: toObjectRef(hit.object),
    source: "lexical",
    score: hit.score,
    matchedFields: hit.matchedFields,
    chunkCount: 0,
    highlightTerms: hit.highlightTerms,
  };
}

function fromSemantic(hit: SemanticHit, chunkCount: number): SearchHit {
  return {
    chunkId: hit.chunkId,
    content: hit.content,
    highlight: hit.highlight,
    similarity: hit.similarity,
    documentId: hit.documentId,
    documentName: hit.documentName,
    refId: hit.refId,
    role: hit.role,
    object: toObjectRef(hit.object),
    source: "semantic",
    score: semanticScore(hit.similarity),
    matchedFields: [],
    chunkCount,
    highlightTerms: [],
  };
}

interface SemanticGroup {
  hit: SemanticHit;
  chunkCount: number;
}

/** 语义侧对象级去重：同一对象保留相似度最高的 chunk，其余计入 chunkCount。 */
function groupSemanticHits(hits: readonly SemanticHit[]): Map<string, SemanticGroup> {
  const grouped = new Map<string, SemanticGroup>();

  for (const hit of hits) {
    const current = grouped.get(hit.object.id);

    if (!current) {
      grouped.set(hit.object.id, { hit, chunkCount: 1 });
      continue;
    }

    current.chunkCount += 1;
    if (hit.similarity > current.hit.similarity) current.hit = hit;
  }

  return grouped;
}

function emptyResult(
  question: string,
  mode: SearchMode,
  library: Library | null,
  hint: string | null,
): SearchResult {
  return {
    question,
    mode,
    hits: [],
    total: 0,
    counts: { lexical: 0, semantic: 0, merged: 0 },
    lexical: { total: 0, truncated: false, hint },
    semantic: { total: 0, status: "skipped", thresholdApplied: mode !== "lexical" },
    library,
  };
}

export async function searchContent(
  db: AppDatabase,
  ownerSub: string,
  query: SearchQuery,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const limit = query.limit ?? 10;
  const mode = query.mode ?? DEFAULT_SEARCH_MODE;
  const library = query.library ?? null;

  let parsed: ParsedSearchQuery;
  try {
    parsed = parseSearchInput(query.question);
  } catch (error) {
    if (error instanceof SearchSyntaxError) {
      throw new QuerySyntaxError(error.message, error.position);
    }
    throw error;
  }

  // 少于 2 字不做任何查询（ADR-024 第 3 条），首页预览也直接不请求。
  if (!meetsSearchLength(parsed)) {
    return emptyResult(query.question, mode, library, "至少输入 2 个字");
  }

  const lexicalPromise: Promise<LexicalResult> =
    mode === "semantic"
      ? Promise.resolve({ hits: [], total: 0, truncated: false, hint: null })
      : lexicalSearch(db, ownerSub, parsed, {
          ...(query.library ? { library: query.library } : {}),
          limit: MAX_LEXICAL_RESULTS,
        });

  const semanticPromise: Promise<SemanticOutcome> =
    mode === "lexical"
      ? Promise.resolve({ status: "ok", hits: [], total: 0 })
      : runSemanticWithTimeout(db, ownerSub, query, limit, options);

  const [lexical, semantic] = await Promise.all([lexicalPromise, semanticPromise]);

  // 纯语义调用方：保持改造前的 chunk 顺序与字段，仅补充新键。
  if (mode === "semantic") {
    const hits = semantic.hits.map((hit) => fromSemantic(hit, 1));

    return {
      question: query.question,
      mode,
      hits,
      total: hits.length,
      counts: { lexical: 0, semantic: hits.length, merged: hits.length },
      lexical: { total: 0, truncated: false, hint: null },
      semantic: {
        total: semantic.total,
        status: semantic.status,
        thresholdApplied: true,
      },
      library,
    };
  }

  // 纯词法调用方：不碰 RAGFlow，按六级权重排序。
  if (mode === "lexical") {
    const hits = lexical.hits.slice(0, limit).map(fromLexical);

    return {
      question: query.question,
      mode,
      hits,
      total: lexical.total,
      counts: { lexical: lexical.total, semantic: 0, merged: lexical.total },
      lexical: { total: lexical.total, truncated: lexical.truncated, hint: lexical.hint },
      semantic: { total: 0, status: "skipped", thresholdApplied: false },
      library,
    };
  }

  // 混合：按对象合并，同一对象只出一条，取最高分与来源并集。
  const semanticGroups = groupSemanticHits(semantic.hits);
  const merged = new Map<
    string,
    { lexical?: LexicalHit; semantic?: SemanticGroup }
  >();

  for (const hit of lexical.hits) {
    merged.set(hit.object.id, { lexical: hit });
  }

  for (const [objectId, group] of semanticGroups) {
    const entry = merged.get(objectId);
    if (entry) entry.semantic = group;
    else merged.set(objectId, { semantic: group });
  }

  const combined: SearchHit[] = [];

  for (const entry of merged.values()) {
    const lexicalHit = entry.lexical;
    const semanticGroup = entry.semantic;

    if (lexicalHit && semanticGroup) {
      const hit = fromSemantic(semanticGroup.hit, semanticGroup.chunkCount);
      combined.push({
        ...hit,
        content: lexicalHit.snippetSource || hit.content,
        source: "both",
        score: Math.max(lexicalHit.score, hit.score),
        matchedFields: lexicalHit.matchedFields,
        highlightTerms: lexicalHit.highlightTerms,
      });
      continue;
    }

    if (lexicalHit) {
      combined.push(fromLexical(lexicalHit));
      continue;
    }

    if (semanticGroup) {
      combined.push(fromSemantic(semanticGroup.hit, semanticGroup.chunkCount));
    }
  }

  combined.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.object.id === b.object.id) return 0;
    // 同分按更新时间倒序，再按 id 升序（稳定）。
    const left = merged.get(a.object.id);
    const right = merged.get(b.object.id);
    const leftUpdated =
      left?.lexical?.object.updatedAt ?? left?.semantic?.hit.object.updatedAt ?? "";
    const rightUpdated =
      right?.lexical?.object.updatedAt ?? right?.semantic?.hit.object.updatedAt ?? "";

    if (leftUpdated !== rightUpdated) return leftUpdated < rightUpdated ? 1 : -1;

    return a.object.id < b.object.id ? -1 : 1;
  });

  return {
    question: query.question,
    mode,
    hits: combined.slice(0, limit),
    total: combined.length,
    counts: {
      lexical: lexical.total,
      semantic: semanticGroups.size,
      merged: combined.length,
    },
    lexical: {
      total: lexical.total,
      truncated: lexical.truncated,
      hint: lexical.hint,
    },
    semantic: {
      total: semantic.total,
      status: semantic.status,
      thresholdApplied: true,
    },
    library,
  };
}
