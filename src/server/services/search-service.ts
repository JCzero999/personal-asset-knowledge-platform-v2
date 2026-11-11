import type { BusinessObject, Library } from "../../domain/objects";
import { libraries } from "../../domain/objects";
import { NotFoundError, ValidationError } from "../../domain/errors";
import {
  createRagflowClientFromEnv,
  type RagflowDataset,
  type RagflowRetrievalResult,
} from "../adapters/ragflow";
import type { AppDatabase } from "../db/client";
import { SqliteContentStore } from "../repositories/sqlite-content-store";
import { DEFAULT_DATASET_NAME } from "./content-service";
import { getObject } from "./object-service";

/**
 * 内容检索：RAGFlow 负责召回，业务库负责归属与过滤。
 *
 * RAGFlow 的单一 Dataset 里有所有内容；直接返回它的结果会越过
 * 「按身份隔离」与「归档默认隐藏」。因此每个命中都按 document_id
 * 认回 content_ref，再校验对象属于当前用户。
 */

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
}

export interface SearchHit {
  chunkId: string;
  content: string;
  highlight: string | null;
  similarity: number;
  documentId: string;
  documentName: string | null;
  refId: string;
  role: "primary" | "attachment";
  object: {
    id: string;
    type: BusinessObject["type"];
    title: string;
    library: Library;
    status: BusinessObject["status"];
    format: BusinessObject["format"];
  };
}

export interface SearchResult {
  question: string;
  hits: SearchHit[];
  total: number;
}

export interface SearchOptions {
  client?: SearchGateway;
  env?: Record<string, string | undefined>;
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

export async function searchContent(
  db: AppDatabase,
  ownerSub: string,
  query: SearchQuery,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const limit = query.limit ?? 10;
  const client =
    options.client ?? (createRagflowClientFromEnv(options.env ?? process.env) as SearchGateway);
  const datasetId = await resolveDatasetId(client, options.env ?? process.env);

  if (!datasetId) {
    return { question: query.question, hits: [], total: 0 };
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

  const hits: SearchHit[] = [];
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
      object: {
        id: object.id,
        type: object.type,
        title: object.title,
        library: object.library,
        status: object.status,
        format: object.format,
      },
    });
  }

  return { question: query.question, hits, total: hits.length };
}
