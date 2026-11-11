import type { ContentRef } from "../../domain/content-ref";
import type { RagflowDocument } from "../adapters/ragflow";
import { createRagflowClientFromEnv } from "../adapters/ragflow";
import type { AppDatabase } from "../db/client";
import { SqliteContentStore } from "../repositories/sqlite-content-store";

/**
 * 解析状态轮询：把 RAGFlow 的文档解析进度回写到 `content_refs.parse_status`。
 *
 * 上传时已尝试触发一次解析；这里兜底重试「仍是 UNSTART」的文档，
 * 并跟踪 RUNNING → DONE / FAIL。轮询本身不做长等待，由 worker 每轮推进一小步。
 */

export interface ParseGateway {
  listDocuments(
    datasetId: string,
    query?: { page?: number; pageSize?: number },
  ): Promise<{ documents: RagflowDocument[]; total: number }>;
  startParsing(datasetId: string, documentIds: string | string[]): Promise<void>;
}

export interface ParsePollOptions {
  /** 注入网关；缺省按环境变量构造真实 RAGFlow 客户端。 */
  client?: ParseGateway;
  env?: Record<string, string | undefined>;
  limit?: number;
  now?: string;
  /** 单页大小，默认 100（RAGFlow 上限）。 */
  pageSize?: number;
  /** 每个 dataset 单轮最多翻多少页，防止大库拖垮一次轮询。 */
  maxPages?: number;
}

export interface ParsePollResult {
  checked: number;
  started: number;
  running: number;
  succeeded: number;
  failed: number;
  errors: Array<{ refId: string; documentId: string; message: string }>;
}

function lastLogLine(message: string | null): string | null {
  if (!message) return null;
  const lines = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1];
  return last ? last.slice(0, 1000) : null;
}

/** 按 dataset 翻页建立 id → 文档 的索引，只保留本轮关心的文档。 */
async function loadDocuments(
  client: ParseGateway,
  datasetId: string,
  wanted: Set<string>,
  pageSize: number,
  maxPages: number,
): Promise<Map<string, RagflowDocument>> {
  const found = new Map<string, RagflowDocument>();

  for (let page = 1; page <= maxPages; page += 1) {
    const result = await client.listDocuments(datasetId, { page, pageSize });
    for (const doc of result.documents) {
      if (wanted.has(doc.id)) {
        found.set(doc.id, doc);
      }
    }
    if (result.documents.length < pageSize || found.size === wanted.size) {
      break;
    }
  }

  return found;
}

export async function pollParsingOnce(
  db: AppDatabase,
  options: ParsePollOptions = {},
): Promise<ParsePollResult> {
  const store = new SqliteContentStore(db);
  const refs = await store.listParsing(options.limit ?? 50);
  const result: ParsePollResult = {
    checked: refs.length,
    started: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    errors: [],
  };

  if (refs.length === 0) {
    return result;
  }

  const client =
    options.client ?? (createRagflowClientFromEnv(options.env ?? process.env) as ParseGateway);
  const pageSize = options.pageSize ?? 100;
  const maxPages = options.maxPages ?? 50;

  const byDataset = new Map<string, ContentRef[]>();
  for (const ref of refs) {
    const list = byDataset.get(ref.datasetId) ?? [];
    list.push(ref);
    byDataset.set(ref.datasetId, list);
  }

  const now = options.now;

  for (const [datasetId, datasetRefs] of byDataset) {
    let documents: Map<string, RagflowDocument>;
    try {
      documents = await loadDocuments(
        client,
        datasetId,
        new Set(datasetRefs.map((ref) => ref.documentId)),
        pageSize,
        maxPages,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const ref of datasetRefs) {
        result.errors.push({ refId: ref.id, documentId: ref.documentId, message });
      }
      continue;
    }

    for (const ref of datasetRefs) {
      const document = documents.get(ref.documentId);

      if (!document) {
        if (ref.parseStatus !== "failed" || ref.parseError === null) {
          await store.updateState(ref.id, {
            parseStatus: "failed",
            parseError: "RAGFlow 文档不存在（可能已被删除）",
            ...(now ? { now } : {}),
          });
        }
        result.failed += 1;
        result.errors.push({
          refId: ref.id,
          documentId: ref.documentId,
          message: "RAGFlow 文档不存在",
        });
        continue;
      }

      switch (document.run) {
        case "DONE": {
          if (ref.parseStatus !== "succeeded" || ref.parseError !== null) {
            await store.updateState(ref.id, {
              parseStatus: "succeeded",
              parseError: null,
              ...(now ? { now } : {}),
            });
          }
          result.succeeded += 1;
          break;
        }
        case "FAIL":
        case "CANCEL": {
          const message =
            lastLogLine(document.progressMessage) ?? `RAGFlow 解析状态为 ${document.run}`;
          if (ref.parseStatus !== "failed" || ref.parseError !== message) {
            await store.updateState(ref.id, {
              parseStatus: "failed",
              parseError: message,
              ...(now ? { now } : {}),
            });
          }
          result.failed += 1;
          if (document.run === "FAIL") {
            result.errors.push({ refId: ref.id, documentId: ref.documentId, message });
          }
          break;
        }
        case "UNSTART": {
          try {
            await client.startParsing(datasetId, ref.documentId);
            result.started += 1;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            result.errors.push({ refId: ref.id, documentId: ref.documentId, message });
          }
          break;
        }
        case "RUNNING":
        case "SCHEDULE": {
          if (ref.parseStatus !== "running" || ref.parseError !== null) {
            await store.updateState(ref.id, {
              parseStatus: "running",
              parseError: null,
              ...(now ? { now } : {}),
            });
          }
          result.running += 1;
          break;
        }
        default: {
          result.errors.push({
            refId: ref.id,
            documentId: ref.documentId,
            message: `未知解析状态：${document.run || "(空)"}`,
          });
        }
      }
    }
  }

  return result;
}
