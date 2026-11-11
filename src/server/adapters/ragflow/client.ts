import {
  ConflictError,
  DomainError,
  NotFoundError,
  ValidationError,
} from "../../../domain/errors";

/**
 * RAGFlow HTTP API 客户端（v0.20.5 实测契约）。
 *
 * 只覆盖当前阶段需要的三个动作：列 dataset、上传 document、删除 document。
 * 不在这里做业务映射、重试或 outbox；那些属于 server/services。
 *
 * 鉴权：`Authorization: Bearer <token>`，token 取自 `api_token.token`（`ragflow-` 前缀），
 * 不是 `/v1/system/new_token` 返回的 `beta` 字段。
 */

export interface RagflowClientOptions {
  /** 例：http://localhost:9380 */
  baseUrl: string;
  apiKey: string;
  /** 便于单测注入；默认使用全局 fetch。 */
  fetch?: typeof fetch;
  /** 单次请求超时，默认 30s。 */
  timeoutMs?: number;
}

export interface ListDatasetsQuery {
  page?: number;
  pageSize?: number;
  /** 默认 create_time。 */
  orderBy?: string;
  /** 默认 true。 */
  desc?: boolean;
  name?: string;
}

export interface RagflowDataset {
  id: string;
  name: string;
  description: string | null;
  embeddingModel: string | null;
  documentCount: number;
  chunkCount: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CreateDatasetInput {
  name: string;
  description?: string;
  /** 不传则由 RAGFlow 落到租户默认 embedding 模型。 */
  embeddingModel?: string;
}

export interface CreateDocumentInput {
  filename: string;
  data: Uint8Array;
  /** 可选 MIME；不传时由 FormData 按 Blob 默认值处理。 */
  mimeType?: string;
}

/**
 * 写入 RAGFlow `meta_fields` 的镜像字段（ADR-007）。
 * RAGFlow 侧按字符串存储与过滤，这里不做类型臆测，一律用字符串。
 */
export type DocumentMetaFields = Record<string, string>;

export interface RagflowDocument {
  id: string;
  name: string;
  datasetId: string;
  chunkCount: number;
  tokenCount: number;
  chunkMethod: string;
  /** RAGFlow 的解析状态原值：UNSTART / RUNNING / DONE / FAIL / CANCEL。 */
  run: string;
  /** 解析任务日志，失败时用于定位原因。 */
  progressMessage: string | null;
}

export interface ListDocumentsQuery {
  page?: number;
  pageSize?: number;
}

export interface RagflowDocumentPage {
  documents: RagflowDocument[];
  total: number;
}

export interface RagflowDownload {
  body: ReadableStream<Uint8Array> | null;
  contentType: string;
  contentLength: number | null;
  filename: string | null;
}

export interface RetrievalInput {
  question: string;
  datasetIds: string[];
  documentIds?: string[];
  page?: number;
  pageSize?: number;
  similarityThreshold?: number;
  vectorSimilarityWeight?: number;
  topK?: number;
  keyword?: boolean;
  highlight?: boolean;
}

export interface RagflowChunk {
  id: string;
  content: string;
  highlight: string | null;
  documentId: string;
  documentName: string | null;
  datasetId: string;
  similarity: number;
  termSimilarity: number;
  vectorSimilarity: number;
}

export interface RagflowRetrievalResult {
  chunks: RagflowChunk[];
  total: number;
}

/** 解析后的分块原文（与检索命中不同，没有相似度）。 */
export interface RagflowDocumentChunk {
  id: string;
  content: string;
}

export interface RagflowChunkPage {
  chunks: RagflowDocumentChunk[];
  total: number;
}

/** RAGFlow 所有接口的统一响应信封。 */
interface RagflowEnvelope<T> {
  code: number;
  data?: T;
  message?: string;
}

interface RawDataset {
  id?: string;
  name?: string;
  description?: string | null;
  embedding_model?: string | null;
  document_count?: number;
  chunk_count?: number;
  create_date?: string | null;
  update_date?: string | null;
}

interface RawDocument {
  id?: string;
  name?: string;
  dataset_id?: string;
  chunk_count?: number;
  token_count?: number;
  chunk_method?: string;
  run?: string;
  progress_msg?: string | null;
}

interface RawDocumentList {
  docs?: RawDocument[];
  total?: number;
}

interface RawChunk {
  id?: string;
  content?: string;
  highlight?: string;
  document_id?: string;
  document_keyword?: string;
  dataset_id?: string;
  similarity?: number;
  term_similarity?: number;
  vector_similarity?: number;
}

interface RawRetrieval {
  chunks?: RawChunk[];
  total?: number;
}

interface RawDocumentChunks {
  chunks?: Array<{ id?: string; content?: string }>;
  total?: number;
}

function toDocument(raw: RawDocument, datasetId: string): RagflowDocument {
  return {
    id: raw.id ?? "",
    name: raw.name ?? "",
    datasetId: raw.dataset_id ?? datasetId,
    chunkCount: raw.chunk_count ?? 0,
    tokenCount: raw.token_count ?? 0,
    chunkMethod: raw.chunk_method ?? "",
    run: raw.run ?? "",
    progressMessage: raw.progress_msg?.trim() || null,
  };
}

function toDataset(raw: RawDataset): RagflowDataset {
  return {
    id: raw.id ?? "",
    name: raw.name ?? "",
    description: raw.description ?? null,
    embeddingModel: raw.embedding_model ?? null,
    documentCount: raw.document_count ?? 0,
    chunkCount: raw.chunk_count ?? 0,
    createdAt: raw.create_date ?? null,
    updatedAt: raw.update_date ?? null,
  };
}

const DEFAULT_TIMEOUT_MS = 30_000;
const SUCCESS_CODE = 0;

export class RagflowClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: RagflowClientOptions) {
    const baseUrl = options.baseUrl?.trim().replace(/\/+$/, "");
    const apiKey = options.apiKey?.trim();

    if (!baseUrl) {
      throw new ValidationError("RAGFlow baseUrl 不能为空");
    }
    if (!apiKey) {
      throw new ValidationError("RAGFlow apiKey 不能为空");
    }

    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async listDatasets(query: ListDatasetsQuery = {}): Promise<RagflowDataset[]> {
    const params = new URLSearchParams({
      page: String(query.page ?? 1),
      page_size: String(query.pageSize ?? 30),
      orderby: query.orderBy ?? "create_time",
      desc: String(query.desc ?? true),
    });
    if (query.name) {
      params.set("name", query.name);
    }

    const data = await this.request<RawDataset[]>(
      "GET",
      `/api/v1/datasets?${params.toString()}`,
    );
    if (!Array.isArray(data)) {
      throw unexpectedShape("GET /api/v1/datasets", data);
    }

    return data.map(toDataset);
  }

  /**
   * 新建 dataset：`POST /api/v1/datasets`，body 只传 name / description /
   * embedding_model（v0.20.5 实测契约）。响应 `data` 是单个对象而不是数组。
   */
  async createDataset(input: CreateDatasetInput): Promise<RagflowDataset> {
    const name = input.name?.trim();
    if (!name) {
      throw new ValidationError("dataset name 不能为空");
    }

    const body: Record<string, unknown> = { name };
    if (input.description) body.description = input.description;
    if (input.embeddingModel) body.embedding_model = input.embeddingModel;

    const data = await this.request<RawDataset>("POST", "/api/v1/datasets", body);
    if (!data || typeof data !== "object" || Array.isArray(data) || !data.id) {
      throw unexpectedShape("POST /api/v1/datasets", data);
    }

    return toDataset(data);
  }

  /**
   * 上传单个文档。RAGFlow v0.20.5 是单次 multipart POST
   * （`POST /api/v1/datasets/{dataset_id}/documents`，字段名 `file`），
   * 返回数组，这里取第一个元素。
   */
  async createDocument(
    datasetId: string,
    input: CreateDocumentInput,
  ): Promise<RagflowDocument> {
    if (!datasetId) {
      throw new ValidationError("datasetId 不能为空");
    }
    if (!input.filename) {
      throw new ValidationError("filename 不能为空");
    }
    if (input.data.byteLength === 0) {
      throw new ValidationError("文档内容不能为空");
    }

    const form = new FormData();
    const blob = new Blob([new Uint8Array(input.data)], {
      type: input.mimeType ?? "application/octet-stream",
    });
    form.append("file", blob, input.filename);

    const data = await this.request<RawDocument[]>(
      "POST",
      `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents`,
      form,
    );

    const raw = Array.isArray(data) ? data[0] : undefined;
    if (!raw) {
      throw unexpectedShape("POST /api/v1/datasets/{id}/documents", data);
    }

    const document = toDocument(raw, datasetId);
    return { ...document, name: document.name || input.filename };
  }

  /**
   * 列出一个 dataset 下的文档（含解析状态）。
   * v0.20.5 的列表响应是 `{ docs: [...], total }`，不是数组。
   * 注意：`GET /documents/{id}` 是下载接口，不能当详情用。
   */
  async listDocuments(
    datasetId: string,
    query: ListDocumentsQuery = {},
  ): Promise<RagflowDocumentPage> {
    if (!datasetId) {
      throw new ValidationError("datasetId 不能为空");
    }

    const params = new URLSearchParams({
      page: String(query.page ?? 1),
      page_size: String(query.pageSize ?? 100),
    });
    const data = await this.request<RawDocumentList>(
      "GET",
      `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents?${params.toString()}`,
    );

    if (!data || !Array.isArray(data.docs)) {
      throw unexpectedShape("GET /api/v1/datasets/{id}/documents", data);
    }

    return {
      documents: data.docs.map((raw) => toDocument(raw, datasetId)),
      total: data.total ?? data.docs.length,
    };
  }

  /**
   * 列出某个文档已解析出的分块原文：
   * `GET /api/v1/datasets/{dataset_id}/documents/{document_id}/chunks`，
   * 响应 `data` 为 `{ chunks, doc, total }`。用于把内容送进 LightRAG 构图。
   */
  async listChunks(
    datasetId: string,
    documentId: string,
    query: { page?: number; pageSize?: number } = {},
  ): Promise<RagflowChunkPage> {
    if (!datasetId) {
      throw new ValidationError("datasetId 不能为空");
    }
    if (!documentId) {
      throw new ValidationError("documentId 不能为空");
    }

    const params = new URLSearchParams({
      page: String(query.page ?? 1),
      page_size: String(query.pageSize ?? 100),
    });
    const data = await this.request<RawDocumentChunks>(
      "GET",
      `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents/${encodeURIComponent(documentId)}/chunks?${params.toString()}`,
    );

    if (!data || !Array.isArray(data.chunks)) {
      throw unexpectedShape("GET /api/v1/datasets/{id}/documents/{docId}/chunks", data);
    }

    return {
      chunks: data.chunks
        .map((chunk) => ({ id: chunk.id ?? "", content: chunk.content ?? "" }))
        .filter((chunk) => chunk.content.trim().length > 0),
      total: data.total ?? data.chunks.length,
    };
  }

  /**
   * 检索：`POST /api/v1/retrieval`，返回命中的 chunk 及相似度。
   * 过滤（库别、归属）不在这里做：RAGFlow 只认内容与 meta，业务规则在服务层。
   */
  async retrieve(input: RetrievalInput): Promise<RagflowRetrievalResult> {
    const question = input.question?.trim();
    if (!question) {
      throw new ValidationError("question 不能为空");
    }
    if (!Array.isArray(input.datasetIds) || input.datasetIds.length === 0) {
      throw new ValidationError("datasetIds 不能为空");
    }

    const body: Record<string, unknown> = {
      question,
      dataset_ids: input.datasetIds,
      page: input.page ?? 1,
      page_size: input.pageSize ?? 10,
      similarity_threshold: input.similarityThreshold ?? 0.2,
      vector_similarity_weight: input.vectorSimilarityWeight ?? 0.3,
      top_k: input.topK ?? 1024,
      keyword: input.keyword ?? false,
      highlight: input.highlight ?? true,
    };
    if (input.documentIds?.length) {
      body.document_ids = input.documentIds;
    }

    const data = await this.request<RawRetrieval>("POST", "/api/v1/retrieval", body);
    if (!data || !Array.isArray(data.chunks)) {
      throw unexpectedShape("POST /api/v1/retrieval", data);
    }

    return {
      chunks: data.chunks.map((chunk) => ({
        id: chunk.id ?? "",
        content: chunk.content ?? "",
        highlight: chunk.highlight?.trim() || null,
        documentId: chunk.document_id ?? "",
        documentName: chunk.document_keyword?.trim() || null,
        datasetId: chunk.dataset_id ?? "",
        similarity: chunk.similarity ?? 0,
        termSimilarity: chunk.term_similarity ?? 0,
        vectorSimilarity: chunk.vector_similarity ?? 0,
      })),
      total: data.total ?? data.chunks.length,
    };
  }

  /**
   * 下载文档原始内容：`GET /api/v1/datasets/{dataset_id}/documents/{document_id}`。
   * 该路径返回的是文件流而不是 JSON 信封，因此不能走 `request()`。
   */
  async downloadDocument(
    datasetId: string,
    documentId: string,
  ): Promise<RagflowDownload> {
    if (!datasetId) {
      throw new ValidationError("datasetId 不能为空");
    }
    if (!documentId) {
      throw new ValidationError("documentId 不能为空");
    }

    const path = `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents/${encodeURIComponent(documentId)}`;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new DomainError("INTERNAL", `RAGFlow 请求失败：GET ${path}`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    if (!response.ok) {
      throw await this.errorFromResponse(response, `GET ${path}`);
    }

    const disposition = response.headers.get("content-disposition");
    const filenameMatch = disposition ? /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition) : null;
    const rawFilename = filenameMatch?.[1]?.replace(/"$/, "") ?? null;
    let filename: string | null = rawFilename;
    if (rawFilename) {
      try {
        filename = decodeURIComponent(rawFilename);
      } catch {
        filename = rawFilename;
      }
    }
    const length = Number(response.headers.get("content-length"));

    return {
      body: response.body,
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
      contentLength: Number.isFinite(length) && length > 0 ? length : null,
      filename,
    };
  }

  /**
   * 触发解析：`POST /api/v1/datasets/{dataset_id}/chunks`，body `{ document_ids }`。
   * 调用返回即代表任务已被接收，完成后状态需通过 `listDocuments` 轮询。
   */
  async startParsing(
    datasetId: string,
    documentIds: string | string[],
  ): Promise<void> {
    if (!datasetId) {
      throw new ValidationError("datasetId 不能为空");
    }
    const ids = Array.isArray(documentIds) ? documentIds : [documentIds];
    if (ids.length === 0 || ids.some((id) => !id)) {
      throw new ValidationError("documentIds 不能为空");
    }

    await this.request<unknown>(
      "POST",
      `/api/v1/datasets/${encodeURIComponent(datasetId)}/chunks`,
      { document_ids: ids },
    );
  }

  /**
   * 写文档的 `meta_fields`：`PUT /api/v1/datasets/{dataset_id}/documents/{document_id}`，
   * body `{ "meta_fields": { ... } }`。
   *
   * 两个实测结论（v0.20.5）：
   * 1. 上传接口 `POST .../documents` **不接受** meta_fields，只能上传后再更新；
   * 2. 该更新是**整体替换**（`DocumentService.update_meta_fields` 直接覆盖 JSON 列），
   *    因此调用方每次都要传完整字段集，不能只传变化的键。
   */
  async updateDocumentMetaFields(
    datasetId: string,
    documentId: string,
    metaFields: DocumentMetaFields,
  ): Promise<void> {
    if (!datasetId) {
      throw new ValidationError("datasetId 不能为空");
    }
    if (!documentId) {
      throw new ValidationError("documentId 不能为空");
    }
    if (!metaFields || typeof metaFields !== "object" || Array.isArray(metaFields)) {
      throw new ValidationError("metaFields 必须是对象");
    }

    await this.request<unknown>(
      "PUT",
      `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents/${encodeURIComponent(documentId)}`,
      { meta_fields: metaFields },
    );
  }

  /**
   * 重命名文档。实测 v0.20.5 的 `PUT .../documents/{id}` 接受 `{ name }`，
   * 与 meta_fields 一样是部分字段更新，可分开调用。
   */
  async renameDocument(
    datasetId: string,
    documentId: string,
    name: string,
  ): Promise<void> {
    if (!datasetId) {
      throw new ValidationError("datasetId 不能为空");
    }
    if (!documentId) {
      throw new ValidationError("documentId 不能为空");
    }
    if (!name.trim()) {
      throw new ValidationError("name 不能为空");
    }

    await this.request<unknown>(
      "PUT",
      `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents/${encodeURIComponent(documentId)}`,
      { name },
    );
  }

  /** 删除一个或多个文档；RAGFlow 只按 `{ ids: [...] }` 批量删除。 */
  async deleteDocument(
    datasetId: string,
    documentIds: string | string[],
  ): Promise<void> {
    if (!datasetId) {
      throw new ValidationError("datasetId 不能为空");
    }
    const ids = Array.isArray(documentIds) ? documentIds : [documentIds];
    if (ids.length === 0 || ids.some((id) => !id)) {
      throw new ValidationError("documentIds 不能为空");
    }

    await this.request<unknown>(
      "DELETE",
      `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents`,
      { ids },
    );
  }

  private async request<T>(
    method: string,
    path: string,
    body?: FormData | Record<string, unknown>,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    let payload: BodyInit | undefined;

    if (body instanceof FormData) {
      // 让 fetch 自己带 multipart boundary。
      payload = body;
    } else if (body) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new DomainError("INTERNAL", `RAGFlow 请求失败：${method} ${path}`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    if (!response.ok) {
      throw await this.errorFromResponse(response, `${method} ${path}`);
    }

    let envelope: RagflowEnvelope<T>;
    try {
      envelope = (await response.json()) as RagflowEnvelope<T>;
    } catch (error) {
      throw new DomainError("INTERNAL", "RAGFlow 返回了非 JSON 响应", {
        method,
        path,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    if (typeof envelope?.code !== "number" || envelope.code !== SUCCESS_CODE) {
      throw this.errorFromEnvelope(envelope, `${method} ${path}`);
    }

    return envelope.data as T;
  }

  private async errorFromResponse(
    response: Response,
    context: string,
  ): Promise<DomainError> {
    let message = `RAGFlow ${context} 返回 HTTP ${response.status}`;
    try {
      const text = await response.text();
      if (text) {
        message = `${message}：${text.slice(0, 500)}`;
      }
    } catch {
      // 读不到 body 时保留状态码信息。
    }

    if (response.status === 404) {
      return new NotFoundError(message, { status: response.status, context });
    }
    if (response.status === 409) {
      return new ConflictError(message, { status: response.status, context });
    }
    if (response.status === 400 || response.status === 422) {
      return new ValidationError(message, { status: response.status, context });
    }
    return new DomainError("INTERNAL", message, {
      status: response.status,
      context,
    });
  }

  private errorFromEnvelope(
    envelope: RagflowEnvelope<unknown>,
    context: string,
  ): DomainError {
    const message = `RAGFlow ${context} 调用失败（code=${String(envelope?.code)}）：${
      envelope?.message ?? "未知错误"
    }`;
    const details = { code: envelope?.code, context };

    if (/(not found|can't find|don't own|lacks permission)/i.test(message)) {
      return new NotFoundError(message, details);
    }
    // RAGFlow 用 code=102 表示参数错误。
    if (envelope?.code === 102) {
      return new ValidationError(message, details);
    }
    return new DomainError("INTERNAL", message, details);
  }
}

function unexpectedShape(context: string, data: unknown): DomainError {
  return new DomainError("INTERNAL", `RAGFlow ${context} 返回结构不符合预期`, {
    received: JSON.stringify(data)?.slice(0, 500),
  });
}

/** 从应用环境变量构造客户端；缺少配置时抛 DomainError，避免带病启动。 */
export function createRagflowClientFromEnv(
  env: Record<string, string | undefined> = process.env,
): RagflowClient {
  const baseUrl = env.RAGFLOW_BASE_URL;
  const apiKey = env.RAGFLOW_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new DomainError(
      "INTERNAL",
      "缺少 RAGFlow 配置：需要 RAGFLOW_BASE_URL 与 RAGFLOW_API_KEY",
    );
  }
  return new RagflowClient({ baseUrl, apiKey });
}
