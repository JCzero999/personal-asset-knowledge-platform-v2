import { createHash } from "node:crypto";

import { ValidationError } from "../../domain/errors";
import type { BusinessObject } from "../../domain/objects";
import {
  createLightragClientFromEnv,
  type LightragDocumentPage,
  type LightragQueryMode,
  type LightragSubgraph,
} from "../adapters/lightrag";
import type { RagflowChunkPage } from "../adapters/ragflow";
import { createRagflowClientFromEnv } from "../adapters/ragflow";
import type { AppDatabase } from "../db/client";
import { SqliteContentStore } from "../repositories/sqlite-content-store";
import { getObject, listObjects } from "./object-service";
import { listCategories } from "./vocabulary-service";

/**
 * 知识图谱：把业务内容送进 LightRAG，再按实体查询。
 *
 * LightRAG 是第二套索引（ADR-001：共用 Embedding，独立图存储），它只认文本、
 * 不认业务对象。因此这里负责两件事：
 * - 构图：主内容 → RAGFlow 分块原文 → 带元数据头的文本 → LightRAG；
 * - 溯源：用 `pakp:obj:{id}:{hash}` 作 file_source，回答里的引用能映射回对象。
 */

export const GRAPH_SOURCE_PREFIX = "pakp:obj:";

/**
 * `GET /api/graph` 的 `maxNodes` 边界（ADR-022 第 12 条 / 附录 A5.1）。
 *
 * 校验只有这一处：路由把原始字符串丢进来，服务层自己解析、越界即 `ValidationError`，
 * 与 `depth` 同风格。`GraphGateway` 的 `maxNodes ?? 150` 只是兜底，不改。
 */
export const GRAPH_MAX_NODES_MIN = 50;
export const GRAPH_MAX_NODES_MAX = 600;
export const GRAPH_MAX_NODES_DEFAULT = 150;

/**
 * 解析并校验 `maxNodes`：缺省 150，整数 50–600。
 * 空串、`"abc"`、`"2.5"`、越界都按 `ValidationError` 处理（`details.field = "maxNodes"`）。
 */
export function resolveGraphMaxNodes(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined) return GRAPH_MAX_NODES_DEFAULT;
  const value =
    typeof raw === "string" ? (raw.trim() === "" ? Number.NaN : Number(raw.trim())) : raw;
  if (
    !Number.isInteger(value) ||
    value < GRAPH_MAX_NODES_MIN ||
    value > GRAPH_MAX_NODES_MAX
  ) {
    throw new ValidationError(
      `maxNodes 必须是 ${GRAPH_MAX_NODES_MIN} 到 ${GRAPH_MAX_NODES_MAX} 的整数`,
      { field: "maxNodes" },
    );
  }
  return value;
}


export interface GraphGateway {
  insertText(input: { text: string; fileSource: string }): Promise<void>;
  listDocuments(page?: number, pageSize?: number): Promise<LightragDocumentPage>;
  deleteDocuments(docIds: string[]): Promise<void>;
  query(input: { query: string; mode?: LightragQueryMode }): Promise<{
    response: string;
    references: Array<{ referenceId: string; filePath: string }>;
  }>;
  listLabels(): Promise<string[]>;
  getSubgraph(input: {
    label: string;
    maxDepth?: number;
    maxNodes?: number;
  }): Promise<LightragSubgraph>;
}

export interface RagflowContentGateway {
  listChunks(
    datasetId: string,
    documentId: string,
    query?: { page?: number; pageSize?: number },
  ): Promise<RagflowChunkPage>;
}

export interface GraphOptions {
  client?: GraphGateway;
  content?: RagflowContentGateway;
  env?: Record<string, string | undefined>;
}

export interface GraphSyncResult {
  /** 参与本轮同步的对象数。 */
  candidates: number;
  /** 已送进 LightRAG、等待后台抽取的对象数。 */
  submitted: number;
  /** 内容与上一版一致、无需重建的对象数。 */
  unchanged: number;
  /** 没有可构图内容的对象。 */
  skipped: Array<{ objectId: string; title: string; reason: string }>;
  /** 清理掉的旧版本图文档数。 */
  removed: number;
  errors: Array<{ objectId: string; title: string; message: string }>;
}

export interface GraphReference {
  objectId: string;
  title: string;
  type: BusinessObject["type"];
  library: BusinessObject["library"];
}

export interface GraphAnswer {
  question: string;
  response: string;
  references: GraphReference[];
}

export interface GraphDocumentRef {
  docId: string;
  hash: string;
}

const MAX_SYNC_OBJECTS = 50;
const DOC_PAGE_SIZE = 200;
const MAX_DOC_PAGES = 25;
const MAX_OWNED_OBJECTS = 2_000;
const MAX_LABEL_PROBES = 200;
const OWNED_LABEL_TTL_MS = 60_000;

/** 图谱读侧按账号过滤（ADR-011）：某个 file_path 是否来自该账号的对象。 */
function isOwnedPath(filePath: string, owned: Set<string>): boolean {
  const parsed = parseGraphFileSource(filePath);
  return parsed !== null && owned.has(parsed.objectId);
}

async function ownerObjectIdSet(db: AppDatabase, ownerSub: string): Promise<Set<string>> {
  const objects = await listObjects(db, { ownerSub, limit: MAX_OWNED_OBJECTS });
  return new Set(objects.map((object) => object.id));
}

const ownedLabelCache = new Map<string, { at: number; labels: string[] }>();

const libraryLabel: Record<BusinessObject["library"], string> = {
  internal: "内库",
  external: "外库",
};

const statusLabel: Record<string, string> = {
  draft: "草稿",
  finished: "完成",
  published: "发布",
  practiced: "实践",
};

/**
 * 把对象元数据与正文拼成一段可抽取的文本。
 *
 * 元数据头不是装饰：实体抽取靠共现，把标题、分类、标签写进同一段，
 * 才能让「是什么」和「属于哪里」出现在同一个上下文里。
 */
export function buildGraphText(
  object: BusinessObject,
  content: string,
  categoryLabel?: string | null,
): string {
  const lines: string[] = [`《${object.title}》`];

  const meta: string[] = [object.type === "work" ? "作品" : "资产", libraryLabel[object.library]];
  if (object.type === "work" && object.status) {
    meta.push(`状态：${statusLabel[object.status] ?? object.status}`);
  }
  lines.push(meta.join(" · "));

  if (object.description?.trim()) {
    lines.push(`描述：${object.description.trim()}`);
  }
  const categoryName = categoryLabel ?? object.category;
  if (categoryName) {
    lines.push(`分类：${categoryName}`);
  }
  if (object.tags.length > 0) {
    lines.push(`标签：${object.tags.join("、")}`);
  }

  const body = content.trim();
  if (body) {
    lines.push("", "正文：", body);
  }

  return lines.join("\n");
}

export function graphFileSource(objectId: string, text: string): string {
  const digest = createHash("sha256").update(text).digest("hex").slice(0, 12);
  return `${GRAPH_SOURCE_PREFIX}${objectId}:${digest}`;
}

/** `pakp:obj:{id}:{hash}` → `{ objectId, hash }`；不是本系统写入的文档返回 null。 */
export function parseGraphFileSource(filePath: string): { objectId: string; hash: string } | null {
  if (!filePath.startsWith(GRAPH_SOURCE_PREFIX)) return null;
  const rest = filePath.slice(GRAPH_SOURCE_PREFIX.length);
  const separator = rest.lastIndexOf(":");
  if (separator <= 0) return null;
  const objectId = rest.slice(0, separator);
  const hash = rest.slice(separator + 1);
  if (!objectId || !hash) return null;
  return { objectId, hash };
}

/** LightRAG 里已有的图文档，按对象分组；分页扫描一次，供整轮同步复用。 */
export async function loadGraphDocuments(
  client: GraphGateway,
): Promise<Map<string, GraphDocumentRef[]>> {
  const byObject = new Map<string, GraphDocumentRef[]>();

  for (let page = 1; page <= MAX_DOC_PAGES; page += 1) {
    const result = await client.listDocuments(page, DOC_PAGE_SIZE);
    for (const doc of result.documents) {
      const parsed = parseGraphFileSource(doc.filePath);
      if (!parsed || !doc.id) continue;
      const list = byObject.get(parsed.objectId) ?? [];
      list.push({ docId: doc.id, hash: parsed.hash });
      byObject.set(parsed.objectId, list);
    }
    if (result.documents.length < DOC_PAGE_SIZE) break;
  }

  return byObject;
}

async function primaryText(
  content: RagflowContentGateway,
  db: AppDatabase,
  object: BusinessObject,
): Promise<string> {
  const refs = await new SqliteContentStore(db).listByOwner(object.type, object.id);
  const usable = refs.filter(
    (ref) => ref.role === "primary" && !ref.deletedAt && ref.parseStatus === "succeeded",
  );

  const parts: string[] = [];
  for (const ref of usable) {
    const page = await content.listChunks(ref.datasetId, ref.documentId, {
      page: 1,
      pageSize: 100,
    });
    parts.push(...page.chunks.map((chunk) => chunk.content));
  }

  return parts.join("\n\n");
}

export async function syncGraph(
  db: AppDatabase,
  ownerSub: string,
  options: GraphOptions = {},
): Promise<GraphSyncResult> {
  const env = options.env ?? process.env;
  const client = options.client ?? (createLightragClientFromEnv(env) as GraphGateway);
  const content =
    options.content ?? (createRagflowClientFromEnv(env) as unknown as RagflowContentGateway);

  const objects = await listObjects(db, { ownerSub, limit: MAX_SYNC_OBJECTS });
  const result: GraphSyncResult = {
    candidates: objects.length,
    submitted: 0,
    unchanged: 0,
    skipped: [],
    removed: 0,
    errors: [],
  };

  if (objects.length === 0) {
    return result;
  }

  const categoryLabels = new Map(listCategories(db).map((item) => [item.code, item.label]));

  const existing = await loadGraphDocuments(client);

  for (const object of objects) {
    try {
      const text = buildGraphText(
        object,
        await primaryText(content, db, object),
        object.category ? categoryLabels.get(object.category) : null,
      );
      if (!text.includes("\n正文：\n")) {
        result.skipped.push({
          objectId: object.id,
          title: object.title,
          reason: "还没有解析成功的主内容",
        });
        continue;
      }

      const source = graphFileSource(object.id, text);
      const hash = source.slice(source.lastIndexOf(":") + 1);
      const previous = existing.get(object.id) ?? [];

      if (previous.some((doc) => doc.hash === hash)) {
        result.unchanged += 1;
        continue;
      }

      if (previous.length > 0) {
        await client.deleteDocuments(previous.map((doc) => doc.docId));
        result.removed += previous.length;
      }

      await client.insertText({ text, fileSource: source });
      result.submitted += 1;
    } catch (error) {
      result.errors.push({
        objectId: object.id,
        title: object.title,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

export async function listGraphLabels(
  db: AppDatabase,
  ownerSub: string,
  options: GraphOptions = {},
): Promise<string[]> {
  const cached = ownedLabelCache.get(ownerSub);
  if (cached && Date.now() - cached.at < OWNED_LABEL_TTL_MS) {
    return cached.labels;
  }

  const client =
    options.client ?? (createLightragClientFromEnv(options.env ?? process.env) as GraphGateway);
  const owned = await ownerObjectIdSet(db, ownerSub);
  const labels: string[] = [];

  if (owned.size > 0) {
    // 标签接口是全局的，只能逐个实体取一跳子图，看是否有本账号的文档参与（ADR-011）。
    for (const label of (await client.listLabels()).slice(0, MAX_LABEL_PROBES)) {
      try {
        const graph = await client.getSubgraph({ label, maxDepth: 1, maxNodes: 60 });
        const touched =
          graph.nodes.some((node) => isOwnedPath(node.filePath, owned)) ||
          graph.edges.some((edge) => isOwnedPath(edge.filePath, owned));
        if (touched) labels.push(label);
      } catch {
        // 单个实体探测失败不影响其余标签
      }
    }
  }

  ownedLabelCache.set(ownerSub, { at: Date.now(), labels });
  return labels;
}

export interface GraphStatus {
  total: number;
  byStatus: Record<string, number>;
  /** 按对象汇总的最近状态（同一对象有多个版本时取最新一页里的第一条）。 */
  objects: Array<{ objectId: string; status: string; error: string | null }>;
  failed: Array<{ objectId: string; error: string }>;
}

export async function graphStatus(
  db: AppDatabase,
  ownerSub: string,
  options: GraphOptions = {},
): Promise<GraphStatus> {
  const client =
    options.client ?? (createLightragClientFromEnv(options.env ?? process.env) as GraphGateway);
  const owned = await ownerObjectIdSet(db, ownerSub);
  const documents = (await loadGraphDocumentStatuses(client)).filter((doc) =>
    owned.has(doc.objectId),
  );
  const status: GraphStatus = { total: documents.length, byStatus: {}, objects: [], failed: [] };

  for (const doc of documents) {
    status.byStatus[doc.status] = (status.byStatus[doc.status] ?? 0) + 1;
    if (doc.error) status.failed.push({ objectId: doc.objectId, error: doc.error });
  }
  status.objects = documents.map((doc) => ({
    objectId: doc.objectId,
    status: doc.status,
    error: doc.error,
  }));

  return status;
}

interface GraphDocumentStatus {
  objectId: string;
  docId: string;
  status: string;
  error: string | null;
}

async function loadGraphDocumentStatuses(client: GraphGateway): Promise<GraphDocumentStatus[]> {
  const docs: GraphDocumentStatus[] = [];
  for (let page = 1; page <= MAX_DOC_PAGES; page += 1) {
    const result = await client.listDocuments(page, DOC_PAGE_SIZE);
    for (const doc of result.documents) {
      const parsed = parseGraphFileSource(doc.filePath);
      if (!parsed || !doc.id) continue;
      docs.push({
        objectId: parsed.objectId,
        docId: doc.id,
        status: doc.status,
        error: doc.errorMessage,
      });
    }
    if (result.documents.length < DOC_PAGE_SIZE) break;
  }
  return docs;
}


export async function getGraphNeighborhood(
  db: AppDatabase,
  ownerSub: string,
  label: string,
  options: GraphOptions & { depth?: number; maxNodes?: number } = {},
): Promise<LightragSubgraph> {
  const trimmed = label.trim();
  if (!trimmed) {
    throw new ValidationError("实体名称不能为空", { field: "label" });
  }
  if (trimmed.length > 100) {
    throw new ValidationError("实体名称不能超过 100 个字符", { field: "label" });
  }
  const depth = options.depth ?? 2;
  if (!Number.isInteger(depth) || depth < 1 || depth > 3) {
    throw new ValidationError("depth 必须是 1 到 3 的整数", { field: "depth" });
  }
  const maxNodes = resolveGraphMaxNodes(options.maxNodes);

  const client =
    options.client ?? (createLightragClientFromEnv(options.env ?? process.env) as GraphGateway);
  const graph = await client.getSubgraph({
    label: trimmed,
    maxDepth: depth,
    maxNodes,
  });

  const owned = await ownerObjectIdSet(db, ownerSub);
  const nodes = graph.nodes.filter((node) => isOwnedPath(node.filePath, owned));
  const kept = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter(
    (edge) =>
      kept.has(edge.source) && kept.has(edge.target) && isOwnedPath(edge.filePath, owned),
  );

  return { nodes, edges };
}

export async function queryGraph(
  db: AppDatabase,
  ownerSub: string,
  question: string,
  options: GraphOptions & { mode?: LightragQueryMode } = {},
): Promise<GraphAnswer> {
  const trimmed = question.trim();
  if (!trimmed) {
    throw new ValidationError("问题不能为空", { field: "q" });
  }
  if (trimmed.length > 200) {
    throw new ValidationError("问题不能超过 200 个字符", { field: "q" });
  }

  const client =
    options.client ?? (createLightragClientFromEnv(options.env ?? process.env) as GraphGateway);
  const answer = await client.query({ query: trimmed, mode: options.mode ?? "mix" });

  const references: GraphReference[] = [];
  const seen = new Set<string>();
  for (const ref of answer.references) {
    const parsed = parseGraphFileSource(ref.filePath);
    if (!parsed || seen.has(parsed.objectId)) continue;
    seen.add(parsed.objectId);

    const object = await getObject(db, ownerSub, parsed.objectId).catch(() => null);
    if (!object) continue;
    references.push({
      objectId: object.id,
      title: object.title,
      type: object.type,
      library: object.library,
    });
  }

  return {
    question: trimmed,
    // 引用不到本账号文档时，回答可能整段来自他人内容；宁可返回空（ADR-011）。
    response: references.length > 0 ? answer.response : "",
    references,
  };
}
