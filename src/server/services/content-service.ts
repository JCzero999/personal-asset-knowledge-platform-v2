import { createHash } from "node:crypto";

import type { ContentRef, ContentRole } from "../../domain/content-ref";
import { contentRoles } from "../../domain/content-ref";
import { DomainError, NotFoundError, ValidationError } from "../../domain/errors";
import type { BusinessObject } from "../../domain/objects";
import {
  createRagflowClientFromEnv,
  type CreateDatasetInput,
  type DocumentMetaFields,
  type RagflowDataset,
} from "../adapters/ragflow";
import type { AppDatabase } from "../db/client";
import { ulid } from "../db/id";
import { SqliteContentStore } from "../repositories/sqlite-content-store";
import { getObject } from "./object-service";

/**
 * 内容上传：把 multipart 文件写进 RAGFlow，并在本地落 `content_refs` + outbox。
 *
 * 关键约定（ADR-007）：
 * - 单一 Dataset；`dataset_id` 优先取 `RAGFLOW_DATASET_ID`，否则按名称查找，缺失即创建；
 * - `content_key` 是幂等键：主内容固定为 `obj:{objectId}:primary`，附件带 ULID；
 * - `document_id` 只是可变指针，正文更新走「删除旧文档 + 重传」。
 *
 * 顺序：先动 RAGFlow，最后写本地库。RAGFlow 任何一步失败都不落 refs，
 * 客户端拿到的是可读错误，而不是一条指向空文档的脏记录。
 */

/** 单次上传上限 25 MB（RAGFlow 端还有 10 MB 的注释掉的限制，这里按业务上限先挡）。 */
export const MAX_CONTENT_BYTES = 25 * 1024 * 1024;

/** 未配置 `RAGFLOW_DATASET_NAME` 时使用的统一内容库名。 */
export const DEFAULT_DATASET_NAME = "pakp-content";

/** RAGFlow 文件名上限按字节计，留出余量，避免中文文件名被拒。 */
const MAX_FILENAME_BYTES = 200;

const DEFAULT_FILENAME = "content.txt";

/**
 * 服务只依赖这几个动作，测试可注入假实现；`RagflowClient` 结构上即满足。
 */
export interface ContentGateway {
  listDatasets(query?: { name?: string; pageSize?: number }): Promise<RagflowDataset[]>;
  createDataset(input: CreateDatasetInput): Promise<RagflowDataset>;
  createDocument(
    datasetId: string,
    input: { filename: string; data: Uint8Array; mimeType?: string },
  ): Promise<{ id: string }>;
  deleteDocument(datasetId: string, documentIds: string | string[]): Promise<void>;
  renameDocument(datasetId: string, documentId: string, name: string): Promise<void>;
  updateDocumentMetaFields(
    datasetId: string,
    documentId: string,
    metaFields: DocumentMetaFields,
  ): Promise<void>;
}

export interface UploadContentOptions {
  /** 注入网关；缺省按环境变量构造真实 RAGFlow 客户端。 */
  client?: ContentGateway;
  /** 读取 dataset 配置的环境变量来源；缺省 process.env。 */
  env?: Record<string, string | undefined>;
  /** 固定写入时间，便于测试断言。 */
  now?: string;
}

interface ParsedUpload {
  role: ContentRole;
  filename: string;
  mime: string | null;
  data: Uint8Array;
}

function isFileLike(value: unknown): value is Blob {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Blob).arrayBuffer === "function" &&
    typeof (value as Blob).size === "number"
  );
}

/** 去掉客户端可能带上的路径，只留最后一段文件名。 */
function baseName(name: string): string {
  const segments = name.split(/[\\/]/);
  return (segments[segments.length - 1] ?? "").trim();
}

function truncateToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }

  // 按字符回退，直到 UTF-8 字节数达标；避免切断多字节字符。
  let result = value;
  while (result.length > 0 && Buffer.byteLength(result, "utf8") > maxBytes) {
    result = result.slice(0, -1);
  }
  return result;
}

function fileExtension(name: string): string {
  const match = /(\.[A-Za-z0-9]{1,10})$/.exec(name);
  return match ? match[1] : "";
}

/**
 * 替换主内容时先以临时名上传：同名重传在 RAGFlow v0.20.5 上行为不确定
 * （第二次返回新 id，但列表仍只保留第一次的记录），改名接口则实测可用。
 */
function uniqueFilename(filename: string): string {
  const extension = fileExtension(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  return truncateToBytes(`${stem}.${ulid()}${extension}`, MAX_FILENAME_BYTES);
}

function readRole(formData: FormData): ContentRole {
  const raw = formData.get("role");

  if (raw === null) {
    return "primary";
  }
  if (typeof raw !== "string") {
    throw new ValidationError("role 必须是字符串", { field: "role" });
  }

  const value = raw.trim();
  if (!value) {
    return "primary";
  }
  if (!(contentRoles as readonly string[]).includes(value)) {
    throw new ValidationError("role 取值非法", { field: "role", allowed: contentRoles });
  }

  return value as ContentRole;
}

function readDocumentName(formData: FormData): string | null {
  const raw = formData.get("documentName");

  if (raw === null) {
    return null;
  }
  if (typeof raw !== "string") {
    throw new ValidationError("documentName 必须是字符串", { field: "documentName" });
  }

  const name = baseName(raw);
  if (!name) {
    return null;
  }
  if (Buffer.byteLength(name, "utf8") > MAX_FILENAME_BYTES) {
    throw new ValidationError(`documentName 不能超过 ${MAX_FILENAME_BYTES} 字节`, {
      field: "documentName",
    });
  }

  return name;
}

function assertUploadSize(bytes: number): void {
  if (bytes === 0) {
    throw new ValidationError("上传的文件不能为空", { field: "file" });
  }
  if (bytes > MAX_CONTENT_BYTES) {
    throw new ValidationError(`文件不能超过 ${MAX_CONTENT_BYTES / (1024 * 1024)} MB`, {
      field: "file",
      maxBytes: MAX_CONTENT_BYTES,
    });
  }
}

/** 解析并校验 multipart：字段 `file`（必填）、`role`、`documentName`。 */
async function parseUploadForm(formData: FormData): Promise<ParsedUpload> {
  const file = formData.get("file");

  if (file === null) {
    throw new ValidationError("缺少文件字段 file", { field: "file" });
  }
  if (!isFileLike(file)) {
    throw new ValidationError("file 必须是上传的文件", { field: "file" });
  }

  const declaredName = baseName((file as File).name ?? "");
  const documentName = readDocumentName(formData);

  // 文件名决定 RAGFlow 的解析器选择，必须带扩展名：自定义名缺后缀时继承原后缀。
  let filename = documentName ?? declaredName;
  if (!filename) {
    filename = DEFAULT_FILENAME;
  } else if (!fileExtension(filename)) {
    filename = `${filename}${fileExtension(declaredName) || fileExtension(DEFAULT_FILENAME)}`;
  }
  filename = truncateToBytes(filename, MAX_FILENAME_BYTES);

  // 先按声明的体积挡一次，避免把超大请求整个读进内存。
  assertUploadSize((file as File).size);

  const data = new Uint8Array(await file.arrayBuffer());
  assertUploadSize(data.byteLength);

  return {
    role: readRole(formData),
    filename,
    mime: file.type || null,
    data,
  };
}

/** 幂等键：主内容稳定，附件每次上传生成新键（允许同一对象挂多个附件）。 */
function buildContentKey(objectId: string, role: ContentRole): string {
  return role === "primary"
    ? `obj:${objectId}:primary`
    : `obj:${objectId}:attachment:${ulid()}`;
}

/** ADR-007 规定只镜像过滤要用的字段；`status` 不镜像。上传与同步共用一个实现。 */
export function buildMetaFields(
  object: BusinessObject,
  contentKey: string,
): DocumentMetaFields {
  const meta: DocumentMetaFields = {
    content_key: contentKey,
    owner_type: object.type,
    owner_id: object.id,
    library: object.library,
    archived: object.archivedAt ? "true" : "false",
    source: object.source,
  };

  if (object.format) {
    meta.format = object.format;
  }

  return meta;
}

/**
 * 解析目标 dataset（单一 Dataset，ADR-007）。
 * 名称查询在 RAGFlow 找不到时返回错误码而不是空列表，所以要当「没有」处理。
 */
async function resolveDatasetId(
  client: ContentGateway,
  env: Record<string, string | undefined>,
): Promise<string> {
  const configuredId = env.RAGFLOW_DATASET_ID?.trim();
  if (configuredId) {
    return configuredId;
  }

  const name = env.RAGFLOW_DATASET_NAME?.trim() || DEFAULT_DATASET_NAME;

  let datasets: RagflowDataset[] = [];
  try {
    datasets = await client.listDatasets({ name, pageSize: 100 });
  } catch (error) {
    if (!(error instanceof NotFoundError)) {
      throw error;
    }
  }

  const existing = datasets.find((dataset) => dataset.name === name && dataset.id);
  if (existing) {
    return existing.id;
  }

  const created = await client.createDataset({
    name,
    description: "个人资产与知识平台统一内容库（ADR-007 单一 Dataset）",
  });
  if (!created.id) {
    throw new DomainError("INTERNAL", "RAGFlow 新建 dataset 未返回 id", { name });
  }

  return created.id;
}

/** 删除旧主内容文档；已被删除视为成功，其余错误上抛。 */
async function deletePreviousDocument(
  client: ContentGateway,
  ref: ContentRef,
): Promise<void> {
  try {
    await client.deleteDocument(ref.datasetId, ref.documentId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return;
    }
    throw error;
  }
}

export async function uploadObjectContent(
  db: AppDatabase,
  ownerSub: string,
  objectId: string,
  formData: FormData,
  options: UploadContentOptions = {},
): Promise<ContentRef> {
  // 归属校验：不存在与不属于调用者一律 NotFound，避免按 id 探测。
  const object = await getObject(db, ownerSub, objectId);
  const upload = await parseUploadForm(formData);

  const env = options.env ?? process.env;
  const client = options.client ?? createRagflowClientFromEnv(env);
  const store = new SqliteContentStore(db);

  const datasetId = await resolveDatasetId(client, env);
  const contentKey = buildContentKey(object.id, upload.role);
  const previous =
    upload.role === "primary" ? await store.findPrimary(object.type, object.id) : null;

  // 替换先以临时名上传：新文档落库后才删旧文档，上传失败时旧内容仍然可用。
  const document = await client.createDocument(datasetId, {
    filename: previous ? uniqueFilename(upload.filename) : upload.filename,
    data: upload.data,
    ...(upload.mime ? { mimeType: upload.mime } : {}),
  });

  if (!document?.id) {
    throw new DomainError("INTERNAL", "RAGFlow 上传文档未返回 document_id", {
      datasetId,
      filename: upload.filename,
    });
  }

  try {
    await client.updateDocumentMetaFields(
      datasetId,
      document.id,
      buildMetaFields(object, contentKey),
    );
  } catch (error) {
    // 缺 meta 的文档会让后续过滤/对账失效，宁可删掉重来，也不留半成品。
    await client.deleteDocument(datasetId, document.id).catch(() => undefined);
    throw error;
  }

  let ref: ContentRef;

  try {
    ref = await store.upsert({
      ownerType: object.type,
      ownerId: object.id,
      datasetId,
      documentId: document.id,
      contentKey,
      role: upload.role,
      documentName: upload.filename,
      contentHash: createHash("sha256").update(upload.data).digest("hex"),
      mime: upload.mime,
      sizeBytes: upload.data.byteLength,
      parseStatus: "pending",
      syncState: "pending",
      ...(options.now ? { now: options.now } : {}),
    });
  } catch (error) {
    // 本地没记下来就等于没上传成功：删掉新文档，旧引用保持原样。
    await client.deleteDocument(datasetId, document.id).catch(() => undefined);
    throw error;
  }

  await store.enqueueJob({
    ownerType: object.type,
    ownerId: object.id,
    contentRefId: ref.id,
    action: "upsert",
    ...(options.now ? { now: options.now } : {}),
  });

  if (previous) {
    try {
      await deletePreviousDocument(client, previous);
    } catch (error) {
      // 新内容已生效，旧文档删不掉只留下重复文档，不影响本次上传结果。
      console.warn("[content] 旧文档删除失败，需后续对账清理", {
        documentId: previous.documentId,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    // 改名失败时文档保留临时名，内容本身不受影响。
    await client
      .renameDocument(datasetId, document.id, upload.filename)
      .catch(() => undefined);
  }

  return ref;
}
