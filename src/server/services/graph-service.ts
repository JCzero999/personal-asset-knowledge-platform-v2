import { createHash } from "node:crypto";

import { ValidationError } from "../../domain/errors";
import type { BusinessObject } from "../../domain/objects";
import {
  createLightragClientFromEnv,
  type LightragDeleteResult,
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
  deleteDocuments(docIds: string[]): Promise<LightragDeleteResult>;
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
  /** 等 LightRAG 后台删除的时间参数；仅测试注入，生产用默认值。 */
  deleteWait?: GraphDeleteWaitOptions;
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

/**
 * 图谱文档在进度条上的四种状态（外加「状态未知」兜底）。
 *
 * LightRAG v2 的文档生命周期是
 * `pending → parsing → analyzing → processing → processed | failed`
 * （见 lightrag/base.py `DocStatus`）。旧实现只认 `pending` / `processing`，
 * 于是 parsing / analyzing 的文档既不算完成也不算进行中，页面上的
 * 「还有 1 个在排队或抽取」会和真实队列对不上——这里显式收口。
 */
export type GraphObjectState = "processed" | "extracting" | "queued" | "failed" | "unknown";

/** 正在被流水线处理的只读状态集合（parsing / analyzing / processing）。 */
const EXTRACTING_DOC_STATUSES = new Set(["parsing", "analyzing", "processing", "preprocessed"]);

/**
 * 把同一对象的多个图文档（历史版本）收敛成一个四态。
 *
 * 优先级刻意定成「进行中 > 已完成 > 排队 > 失败」：
 * - 正在抽取的新版本优先展示，避免界面在重抽期间显示「已完成」；
 * - 只要有一个版本已经 processed，内容就已经在库里，按已完成算；
 * - 旧版本失败不能盖过仍在排队的版本。
 */
export function graphObjectStateOf(statuses: readonly string[]): GraphObjectState {
  const normalized = statuses.map((status) => status.trim().toLowerCase());
  if (normalized.some((status) => EXTRACTING_DOC_STATUSES.has(status))) return "extracting";
  if (normalized.includes("processed")) return "processed";
  if (normalized.includes("pending")) return "queued";
  if (normalized.includes("failed")) return "failed";
  return "unknown";
}

/** 四态的中文标签：服务端与页面共用同一套口径。 */
export const GRAPH_OBJECT_STATE_LABEL: Record<GraphObjectState, string> = {
  processed: "已完成",
  extracting: "抽取中",
  queued: "排队",
  failed: "失败",
  unknown: "状态未知",
};

const TIMEOUT_PATTERN =
  /(readtimeout|apitimeout|timeout|timed out|deadline exceeded|upstream request timeout)/i;
const CONNECT_PATTERN =
  /(connecterror|connection refused|connection reset|connection error|econnrefused|econnreset|getaddrinfo|name or service not known)/i;
const AUTH_PATTERN = /(401|403|unauthorized|invalid api key|authentication|permission denied)/i;
const RATE_PATTERN = /(429|rate limit|rate_limit|quota|insufficient_quota)/i;
/**
 * LightRAG 的 chunk 前缀：`C[1/4]: doc-…-chunk-000: `。
 * 抽取失败时它把前缀写进 error_msg，真正的异常（如 httpx.ReadTimeout）只进服务日志，
 * 于是 error_msg 只剩下前缀、冒号后面是空的。第二个捕获组就是被吞掉的原因。
 */
const CHUNK_PREFIX_PATTERN = /^(?:C\[\d+\/\d+\]:\s*)?doc-\S+-chunk-\d+:\s*([\s\S]*)$/i;

export interface GraphFailureReason {
  /** 一句可读原因。 */
  message: string;
  /** LightRAG 原始错误串，保留给第二行展示；没有就是 null。 */
  raw: string | null;
}

/**
 * 把 LightRAG 的原始 error 映射成可读原因（原始串永远保留）。
 *
 * 现状：本地 7B 模型在 300 秒内跑不完一个分块，LightRAG 只把
 * `C[1/4]: doc-…-chunk-000: ` 写进 error_msg，真正的 ReadTimeout 在日志里。
 * 所以「前缀 + 空尾巴」必须落到「未返回原因」，而不是空白。
 */
export function describeGraphFailure(raw: string | null | undefined): GraphFailureReason {
  const detail = raw?.trim() ? raw.trim() : null;
  if (!detail) {
    return { message: "抽取失败（未返回原因）", raw: null };
  }
  if (TIMEOUT_PATTERN.test(detail)) {
    return { message: "抽取超时：本地模型过慢", raw: detail };
  }
  if (CONNECT_PATTERN.test(detail)) {
    return { message: "抽取服务连接失败：请确认 LightRAG 与模型服务已启动", raw: detail };
  }
  if (AUTH_PATTERN.test(detail)) {
    return { message: "抽取失败：模型接口的密钥或权限被拒绝", raw: detail };
  }
  if (RATE_PATTERN.test(detail)) {
    return { message: "抽取失败：模型接口限流或额度不足", raw: detail };
  }

  const cause = detail.replace(CHUNK_PREFIX_PATTERN, "$1").trim();
  if (!cause || cause === detail) {
    // 只有 chunk 前缀（尾巴为空）或完全无法识别的串：不臆造原因。
    return { message: "抽取失败（未返回原因）", raw: detail };
  }

  const firstLine = cause.split(/\r?\n/)[0].trim();
  const clipped = firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
  return { message: `抽取失败：${clipped}`, raw: detail };
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

/**
 * LightRAG 的删除是**后台任务**：`DELETE /documents/delete_document` 只回
 * `deletion_started`，文档记录还要过几十秒才从 `/documents/paginated` 消失；
 * 这期间同名 file_source 的 `POST /documents/text` 一律 409。
 * 所以换版本（同步、重试）必须等旧记录真的没了再入库，否则用户点了也白点。
 */
const DELETE_WAIT_BUDGET_MS = 180_000;
const DELETE_POLL_INTERVAL_MS = 3_000;

/** 在整份文档列表里找这些 id，返回仍然存在的部分。 */
async function findExistingDocumentIds(
  client: GraphGateway,
  docIds: ReadonlySet<string>,
): Promise<Set<string>> {
  const found = new Set<string>();
  if (docIds.size === 0) return found;

  for (let page = 1; page <= MAX_DOC_PAGES; page += 1) {
    const result = await client.listDocuments(page, DOC_PAGE_SIZE);
    for (const doc of result.documents) {
      if (docIds.has(doc.id)) found.add(doc.id);
    }
    if (found.size === docIds.size) break;
    if (result.documents.length < DOC_PAGE_SIZE) break;
  }

  return found;
}

export interface DocumentDeletionWait {
  /** 全部旧记录都消失了。 */
  gone: boolean;
  /** 预算内仍未消失的 id。 */
  remaining: string[];
}

export interface GraphDeleteWaitOptions {
  budgetMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * 轮询等旧文档从 LightRAG 消失。默认最多等 3 分钟、每 3 秒查一次；
 * `sleep` / `now` 可注入，便于单测不真的等待。
 */
export async function waitForGraphDocumentsDeleted(
  client: GraphGateway,
  docIds: readonly string[],
  options: GraphDeleteWaitOptions = {},
): Promise<DocumentDeletionWait> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const target = new Set(docIds);
  if (target.size === 0) return { gone: true, remaining: [] };

  const deadline = now() + (options.budgetMs ?? DELETE_WAIT_BUDGET_MS);
  let remaining = [...target];

  for (;;) {
    const present = await findExistingDocumentIds(client, target);
    remaining = [...target].filter((docId) => present.has(docId));
    if (remaining.length === 0) return { gone: true, remaining };
    if (now() >= deadline) return { gone: false, remaining };
    await sleep(options.intervalMs ?? DELETE_POLL_INTERVAL_MS);
  }
}

/**
 * 替换一个对象的图文档：先删旧版本并等它真的消失，再按同一 file_source 入库。
 * 同步与「重新抽取」共用这一条路径，避免两处各写一遍终于踩同一个 409。
 */
async function replaceGraphDocuments(
  client: GraphGateway,
  previous: readonly GraphDocumentRef[],
  text: string,
  fileSource: string,
  waitOptions: GraphDeleteWaitOptions = {},
): Promise<void> {
  if (previous.length > 0) {
    const docIds = previous.map((doc) => doc.docId);
    const deletion = await client.deleteDocuments(docIds);
    if (deletion.status === "busy" || deletion.status === "not_allowed") {
      throw new Error(
        deletion.status === "busy"
          ? "LightRAG 正忙，旧版本暂时删不掉，等它空下来再试"
          : "LightRAG 不允许删除这批旧版本，请稍后再试",
      );
    }
    const waited = await waitForGraphDocumentsDeleted(client, docIds, waitOptions);
    if (!waited.gone) {
      throw new Error(
        `旧版本还在后台删除（剩 ${waited.remaining.length} 个），稍等一两分钟再试一次`,
      );
    }
  }

  await client.insertText({ text, fileSource });
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

      await replaceGraphDocuments(client, previous, text, source, options.deleteWait);
      result.removed += previous.length;
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

/**
 * 重新抽取失败对象：LightRAG 的 `/documents/reprocess_failed` 只能整批重试，
 * 而这里要按对象逐个重来。因此走最小可行路径——删掉该对象的全部图文档版本，
 * 再用与 `syncGraph` 完全相同的 `buildGraphText` + `fileSource` 重新 `insertText`，
 * 抽取仍由 LightRAG 后台执行，状态回 `pending`，页面据此继续轮询。
 *
 * 只允许失败态：processed / extracting / queued 一律跳过，避免把正在跑的抽取打断。
 */
export const GRAPH_RETRY_MAX_OBJECTS = 20;

export interface GraphRetryItem {
  objectId: string;
  title: string;
  outcome: "resubmitted" | "skipped" | "failed";
  message: string;
}

export interface GraphRetryResult {
  requested: number;
  resubmitted: number;
  results: GraphRetryItem[];
}

export async function retryGraphObjects(
  db: AppDatabase,
  ownerSub: string,
  objectIds: readonly string[],
  options: GraphOptions = {},
): Promise<GraphRetryResult> {
  const ids = [...new Set(objectIds.map((id) => String(id).trim()).filter(Boolean))];
  if (ids.length === 0) {
    throw new ValidationError("至少选择一个要重新抽取的对象", { field: "objectIds" });
  }
  if (ids.length > GRAPH_RETRY_MAX_OBJECTS) {
    throw new ValidationError(`一次最多重新抽取 ${GRAPH_RETRY_MAX_OBJECTS} 个对象`, {
      field: "objectIds",
      max: GRAPH_RETRY_MAX_OBJECTS,
    });
  }

  const env = options.env ?? process.env;
  const client = options.client ?? (createLightragClientFromEnv(env) as GraphGateway);
  const content =
    options.content ?? (createRagflowClientFromEnv(env) as unknown as RagflowContentGateway);

  const objects = await listObjects(db, { ownerSub, limit: MAX_OWNED_OBJECTS });
  const ownedById = new Map(objects.map((object) => [object.id, object]));
  const categoryLabels = new Map(listCategories(db).map((item) => [item.code, item.label]));

  const statuses = await loadGraphDocumentStatuses(client);
  const statusByObject = new Map<string, GraphDocumentStatus[]>();
  for (const doc of statuses) {
    const list = statusByObject.get(doc.objectId) ?? [];
    list.push(doc);
    statusByObject.set(doc.objectId, list);
  }
  const existing = await loadGraphDocuments(client);

  const results: GraphRetryItem[] = [];
  let resubmitted = 0;

  for (const objectId of ids) {
    const object = ownedById.get(objectId);
    if (!object) {
      results.push({
        objectId,
        title: objectId,
        outcome: "failed",
        message: "对象不存在或不属于当前账号",
      });
      continue;
    }

    const docs = statusByObject.get(objectId) ?? [];
    const state = graphObjectStateOf(docs.map((doc) => doc.status));
    if (state !== "failed") {
      results.push({
        objectId,
        title: object.title,
        outcome: "skipped",
        message:
          state === "processed"
            ? "已经完成抽取，无需重试"
            : state === "extracting"
              ? "正在抽取，等它结束再试"
              : state === "queued"
                ? "还在排队，等它开始再试"
                : "没有可重试的失败记录，先刷新进度",
      });
      continue;
    }

    try {
      const text = buildGraphText(
        object,
        await primaryText(content, db, object),
        object.category ? categoryLabels.get(object.category) : null,
      );
      if (!text.includes("\n正文：\n")) {
        results.push({
          objectId,
          title: object.title,
          outcome: "failed",
          message: "还没有解析成功的主内容，先完成内容解析再重试",
        });
        continue;
      }

      const previous = existing.get(objectId) ?? [];
      await replaceGraphDocuments(
        client,
        previous,
        text,
        graphFileSource(object.id, text),
        options.deleteWait,
      );
      resubmitted += 1;
      results.push({
        objectId,
        title: object.title,
        outcome: "resubmitted",
        message: "已重新提交，抽取在后台进行",
      });
    } catch (error) {
      results.push({
        objectId,
        title: object.title,
        outcome: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { requested: ids.length, resubmitted, results };
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

/** 单个对象的构图进度（同一对象的历史版本已收敛成一行）。 */
export interface GraphStatusObject {
  objectId: string;
  /** 对象标题；对象已被删除时回落到 id。 */
  title: string;
  /** 代表该对象当前状态的那份图文档（重试时按对象整体重建，不依赖它）。 */
  docId: string;
  /** LightRAG 原始状态串（pending / parsing / analyzing / processing / processed / failed）。 */
  status: string;
  state: GraphObjectState;
  /** 可读失败原因；非失败态为 null。 */
  error: string | null;
  /** LightRAG 原始错误串（第二行展示）；非失败态为 null。 */
  errorRaw: string | null;
  chunksCount: number;
  updatedAt: string | null;
}

/**
 * 失败对象（保持旧口径：只有 objectId + 可读原因）。
 * 标题、原始错误等富字段在 `objects` 里；`graph-model.ts` 只消费这两个字段。
 */
export interface GraphStatusFailure {
  objectId: string;
  error: string;
}

export interface GraphStatus {
  /** 本账号已进图谱的**对象**数（同一对象的多个版本只算一次）。 */
  total: number;
  /** 按代表文档的原始状态统计（保留旧口径，供调用方判断是否已有 processed）。 */
  byStatus: Record<string, number>;
  /** 四态计数（对象维度）；四项之和等于 total（unknown 另计）。 */
  counts: Record<GraphObjectState, number>;
  /** 每个对象的当前状态，按 objectId 排序，保证同输入同输出。 */
  objects: GraphStatusObject[];
  /** 失败对象列表（只含 failed 态），供失败卡片与重试入口使用。 */
  failed: GraphStatusFailure[];
}

export async function graphStatus(
  db: AppDatabase,
  ownerSub: string,
  options: GraphOptions = {},
): Promise<GraphStatus> {
  const client =
    options.client ?? (createLightragClientFromEnv(options.env ?? process.env) as GraphGateway);
  const ownedObjects = await listObjects(db, { ownerSub, limit: MAX_OWNED_OBJECTS });
  const ownedById = new Map(ownedObjects.map((object) => [object.id, object]));
  const documents = (await loadGraphDocumentStatuses(client)).filter((doc) =>
    ownedById.has(doc.objectId),
  );

  const byObject = new Map<string, GraphDocumentStatus[]>();
  for (const doc of documents) {
    const list = byObject.get(doc.objectId) ?? [];
    list.push(doc);
    byObject.set(doc.objectId, list);
  }

  const counts: Record<GraphObjectState, number> = {
    processed: 0,
    extracting: 0,
    queued: 0,
    failed: 0,
    unknown: 0,
  };
  const objects: GraphStatusObject[] = [];
  const failed: GraphStatusFailure[] = [];

  for (const objectId of [...byObject.keys()].sort()) {
    const docs = byObject.get(objectId) ?? [];
    const state = graphObjectStateOf(docs.map((doc) => doc.status));
    const chosen = pickStatusDocument(docs, state);
    const reason = state === "failed" ? describeGraphFailure(chosen.error) : null;

    const row: GraphStatusObject = {
      objectId,
      title: ownedById.get(objectId)?.title ?? objectId,
      docId: chosen.docId,
      status: chosen.status,
      state,
      error: reason?.message ?? null,
      errorRaw: reason?.raw ?? null,
      chunksCount: chosen.chunksCount,
      updatedAt: chosen.updatedAt,
    };

    objects.push(row);
    counts[state] += 1;
    if (state === "failed" && reason) {
      failed.push({ objectId, error: reason.message });
    }
  }

  const byStatus: Record<string, number> = {};
  for (const row of objects) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
  }

  return { total: objects.length, byStatus, counts, objects, failed };
}

interface GraphDocumentStatus {
  objectId: string;
  docId: string;
  status: string;
  error: string | null;
  chunksCount: number;
  updatedAt: string | null;
}

/** 文档排序：更新时间新在前，同刻按 docId 升序——同输入逐字节确定。 */
function compareDocuments(a: GraphDocumentStatus, b: GraphDocumentStatus): number {
  const left = a.updatedAt ?? "";
  const right = b.updatedAt ?? "";
  if (left !== right) return left < right ? 1 : -1;
  return a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0;
}

/** 选出代表对象当前状态的那份文档：优先与四态对应的状态，再取最新。 */
function pickStatusDocument(
  docs: readonly GraphDocumentStatus[],
  state: GraphObjectState,
): GraphDocumentStatus {
  const sorted = [...docs].sort(compareDocuments);
  const matches: Record<Exclude<GraphObjectState, "unknown">, (doc: GraphDocumentStatus) => boolean> = {
    extracting: (doc) => EXTRACTING_DOC_STATUSES.has(doc.status.trim().toLowerCase()),
    processed: (doc) => doc.status.trim().toLowerCase() === "processed",
    queued: (doc) => doc.status.trim().toLowerCase() === "pending",
    failed: (doc) => doc.status.trim().toLowerCase() === "failed",
  };
  if (state === "unknown") return sorted[0];
  const matched = sorted.find(matches[state]);
  return matched ?? sorted[0];
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
        chunksCount: doc.chunksCount,
        updatedAt: doc.updatedAt ?? null,
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
