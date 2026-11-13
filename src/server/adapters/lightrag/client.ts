import { DomainError, ValidationError } from "../../../domain/errors";

/**
 * LightRAG 的 HTTP 客户端：图谱链路的**唯一**外部入口（ADR-010）。
 *
 * 只封装 `lightrag-server` 已实测存在的四类能力：
 * 文本入库、文档状态、图谱标签 / 子图、图增强问答。
 * 不在这里做归属过滤——那是服务层的事。
 */

export interface LightragClientOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface LightragDocument {
  id: string;
  filePath: string;
  status: string;
  chunksCount: number;
  errorMessage: string | null;
  /** 最近一次状态更新时间（LightRAG 的 `updated_at`），用于挑选对象的最新版本。 */
  updatedAt: string | null;
}

export interface LightragDocumentPage {
  documents: LightragDocument[];
  total: number;
}

/**
 * `DELETE /documents/delete_document` 的回执。LightRAG 的删除在后台执行，
 * 接口只负责占位：`deletion_started` 表示已排上（文档还要过一会儿才真的消失），
 * `busy` / `not_allowed` 表示这次没排上，需要稍后重试。
 */
export interface LightragDeleteResult {
  status: "deletion_started" | "busy" | "not_allowed" | "unknown";
  message: string;
}

export interface LightragReference {
  referenceId: string;
  filePath: string;
}

export interface LightragAnswer {
  response: string;
  references: LightragReference[];
}

export interface LightragNode {
  id: string;
  type: string;
  description: string;
  /** 产生该节点的文档；用于按账号过滤（ADR-011）。 */
  filePath: string;
}

export interface LightragEdge {
  source: string;
  target: string;
  description: string;
  /** 产生该边的文档；用于按账号过滤（ADR-011）。 */
  filePath: string;
}

export interface LightragSubgraph {
  nodes: LightragNode[];
  edges: LightragEdge[];
}

export type LightragQueryMode = "local" | "global" | "hybrid" | "naive" | "mix";

interface RawDocument {
  id?: string;
  file_path?: string;
  status?: string;
  chunks_count?: number;
  error_msg?: string | null;
  updated_at?: string | null;
}

interface RawGraphNode {
  id?: string;
  labels?: string[];
  properties?: Record<string, unknown>;
}

interface RawGraphEdge {
  source?: string;
  target?: string;
  properties?: Record<string, unknown>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** 构图与问答都会走本地 7B 模型，比普通查询慢得多（实测一次问答约 90 秒）。 */
const SLOW_TIMEOUT_MS = 180_000;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringProp(properties: Record<string, unknown> | undefined, ...keys: string[]): string {
  if (!properties) return "";
  for (const key of keys) {
    const value = properties[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export class LightragClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: LightragClientOptions = {}) {
    const baseUrl = options.baseUrl?.trim().replace(/\/+$/, "");
    if (!baseUrl) {
      throw new ValidationError("LightRAG baseUrl 不能为空（LIGHTRAG_BASE_URL）");
    }
    this.baseUrl = baseUrl;
    this.apiKey = options.apiKey?.trim() ?? "";
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** 把一段文本送进 LightRAG；返回后仍在后台抽取，需查文档状态确认。 */
  async insertText(input: { text: string; fileSource: string }): Promise<void> {
    const text = input.text?.trim();
    if (!text) {
      throw new ValidationError("要入库的文本不能为空");
    }
    if (!input.fileSource?.trim()) {
      throw new ValidationError("fileSource 不能为空");
    }

    await this.request("POST", "/documents/text", {
      text,
      file_source: input.fileSource.trim(),
    }, this.timeoutMs);
  }

  async listDocuments(page = 1, pageSize = 50): Promise<LightragDocumentPage> {
    const data = await this.request<{
      documents?: RawDocument[];
      pagination?: { total_count?: number };
    }>("POST", "/documents/paginated", { page, page_size: pageSize }, this.timeoutMs);

    if (!data || !Array.isArray(data.documents)) {
      throw new DomainError("INTERNAL", "LightRAG 文档列表响应格式异常");
    }

    return {
      documents: data.documents.map((raw) => ({
        id: raw.id ?? "",
        filePath: raw.file_path ?? "",
        status: raw.status ?? "",
        chunksCount: raw.chunks_count ?? 0,
        errorMessage: raw.error_msg?.trim() || null,
        updatedAt: raw.updated_at ?? null,
      })),
      total: data.pagination?.total_count ?? data.documents.length,
    };
  }

  async deleteDocuments(docIds: string[]): Promise<LightragDeleteResult> {
    if (docIds.length === 0) return { status: "unknown", message: "" };
    const data = await this.request<{ status?: string; message?: string }>(
      "DELETE",
      "/documents/delete_document",
      { doc_ids: docIds },
      this.timeoutMs,
    );
    const status = data?.status;
    return {
      status:
        status === "deletion_started" || status === "busy" || status === "not_allowed"
          ? status
          : "unknown",
      message: data?.message ?? "",
    };
  }

  /** 图增强问答；`mix` 同时走图谱与向量检索。 */
  async query(input: { query: string; mode?: LightragQueryMode }): Promise<LightragAnswer> {
    const question = input.query?.trim();
    if (!question) {
      throw new ValidationError("问题不能为空");
    }

    const data = await this.request<{
      response?: string;
      references?: Array<{ reference_id?: string; file_path?: string }>;
    }>(
      "POST",
      "/query",
      { query: question, mode: input.mode ?? "mix", include_references: true },
      SLOW_TIMEOUT_MS,
    );

    return {
      response: data?.response?.trim() ?? "",
      references: (data?.references ?? []).map((ref) => ({
        referenceId: ref.reference_id ?? "",
        filePath: ref.file_path ?? "",
      })),
    };
  }

  async listLabels(): Promise<string[]> {
    const data = await this.request<string[]>("GET", "/graph/label/list", undefined, this.timeoutMs);
    if (!Array.isArray(data)) {
      throw new DomainError("INTERNAL", "LightRAG 标签列表响应格式异常");
    }
    return data.filter((label): label is string => typeof label === "string");
  }

  async getSubgraph(input: {
    label: string;
    maxDepth?: number;
    maxNodes?: number;
  }): Promise<LightragSubgraph> {
    const label = input.label?.trim();
    if (!label) {
      throw new ValidationError("label 不能为空");
    }

    const params = new URLSearchParams({
      label,
      max_depth: String(input.maxDepth ?? 2),
      max_nodes: String(input.maxNodes ?? 200),
    });
    const data = await this.request<{
      nodes?: RawGraphNode[];
      edges?: RawGraphEdge[];
    }>("GET", `/graphs?${params.toString()}`, undefined, this.timeoutMs);

    if (!data || !Array.isArray(data.nodes)) {
      throw new DomainError("INTERNAL", "LightRAG 图谱响应格式异常");
    }

    return {
      nodes: data.nodes.map((node) => ({
        id: node.id ?? "",
        type: stringProp(node.properties, "entity_type", "type"),
        description: stringProp(node.properties, "description"),
        filePath: stringProp(node.properties, "file_path"),
      })),
      edges: (data.edges ?? []).map((edge) => ({
        source: edge.source ?? "",
        target: edge.target ?? "",
        description: stringProp(edge.properties, "description"),
        filePath: stringProp(edge.properties, "file_path"),
      })),
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(this.apiKey ? { "X-API-Key": this.apiKey } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new DomainError("INTERNAL", `LightRAG 请求失败：${method} ${path}`, {
        cause: describe(error),
      });
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new DomainError("INTERNAL", `LightRAG 返回 ${response.status}`, {
        method,
        path,
        detail: detail.slice(0, 500),
      });
    }

    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }
}

export function createLightragClientFromEnv(
  env: Record<string, string | undefined> = process.env,
): LightragClient {
  return new LightragClient({
    baseUrl: env.LIGHTRAG_BASE_URL,
    apiKey: env.LIGHTRAG_API_KEY,
  });
}
