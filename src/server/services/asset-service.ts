import { createHash } from "node:crypto";

import { asc, inArray } from "drizzle-orm";

import { ConflictError, DomainError, ValidationError } from "../../domain/errors";
import { MAX_TAGS_PER_OBJECT, normalizeTag } from "../../domain/vocabulary";
import type { BusinessObject } from "../../domain/objects";
import { createRagflowClientFromEnv } from "../adapters/ragflow";
import type { ActorContext } from "../authz";
import { type AppDatabase } from "../db/client";
import { tags } from "../db/schema";
import type { ValueAssessmentInput } from "../ports/object-repository";
import { SqliteContentStore } from "../repositories/sqlite-content-store";
import { SqliteObjectRepository } from "../repositories/sqlite-object-repository";
import {
  evaluateValueScores,
  extractAssetCandidates,
  scoreAssetByModel,
  type AssetAiDeps,
} from "./asset-ai";
import { writeAudit } from "./audit-service";
import { getObject } from "./object-service";

/**
 * 内容流转与沉淀的服务层（规格 v2.0 第 3、5、6、7 节）。
 *
 * 五个动作各自对应一个 HTTP 端点，共同点：
 * - 只按 `ownerSub` 认人，别人的对象一律 NotFound；
 * - 模型只产出「分数 + 理由」，加权 / 阈值 / 等级全部由 `domain/value.ts` 计算；
 * - 写库收敛到仓储的单事务方法，服务层不做「先写一半」的操作。
 *
 * 模型调用在事务之前完成：better-sqlite3 的事务是同步的，不能在事务里 await；
 * 因此顺序固定为「读对象 → 问模型（异步）→ 单事务落库」。模型失败要么整体失败
 * （提炼、打分、主动重评），要么退回确定性兜底（自动沉淀、实践结算）。
 */

/** 提炼时送进模型的正文上限：本地 7B 模型的上下文窗口有限。 */
const MAX_EXTRACT_CONTENT_CHARS = 12_000;

/** 判定「关联与互补」时提供给模型的内库资产标题数量上限。 */
const MAX_INTERNAL_TITLES = 30;

/** practice_metrics 的体积上限（JSON 文本字节数），防止把大块日志写进对象行。 */
const MAX_PRACTICE_METRICS_BYTES = 4_000;

/** 提炼提示词里展示的已有标签上限（控制上下文长度）。 */
const MAX_PROMPT_TAGS = 60;

/** 正文快照：只留前 2000 字，完整原文仍经 origin_work_id 回指作品。 */
const SNAPSHOT_MAX_CHARS = 2_000;

/** 读取正文的超时上限：RAGFlow 卡住不能拖住结算。 */
const SNAPSHOT_READ_TIMEOUT_MS = 10_000;

export interface AssetServiceDeps extends AssetAiDeps {
  /** 注入作品正文读取（测试用）：默认从 content_refs 指向的 RAGFlow 文档取已解析分块。 */
  readContent?: (db: AppDatabase, ownerSub: string, objectId: string) => Promise<string>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function repoFor(db: AppDatabase): SqliteObjectRepository {
  return new SqliteObjectRepository(db);
}

/* -------------------------------------------------------------------------- */
/* 正文读取                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 取作品正文：优先主内容引用，其次第一条附件；正文用 RAGFlow 已解析的分块拼接。
 *
 * 没有内容引用时返回空串（由调用方转成 422）；RAGFlow 不可用则原样上抛——
 * 「没上传」和「上传了但服务挂了」是两种需要不同处理的情况。
 */
async function readWorkContentFromRagflow(
  db: AppDatabase,
  _ownerSub: string,
  objectId: string,
): Promise<string> {
  const store = new SqliteContentStore(db);
  const refs = await store.listByOwner("work", objectId);
  const primary = refs.find((ref) => ref.role === "primary") ?? refs[0];

  if (!primary) return "";

  const client = createRagflowClientFromEnv(process.env);
  const page = await client.listChunks(primary.datasetId, primary.documentId, {
    page: 1,
    pageSize: 100,
  });

  return page.chunks
    .map((chunk) => chunk.content.trim())
    .filter((text) => text.length > 0)
    .join("\n\n")
    .slice(0, MAX_EXTRACT_CONTENT_CHARS);
}

/* -------------------------------------------------------------------------- */
/* 标签与内库上下文                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 模型给的标签只有「词表里已存在」的才会挂上。
 *
 * 标签不允许隐式创建（ADR-023）：提炼是后台自动动作，替用户凭空造词条会污染
 * 词表，未知标签直接丢弃，用户需要时再手动添加。
 */
function existingTagLabels(db: AppDatabase, labels: readonly string[]): string[] {
  const normalized = [...new Set(labels.map(normalizeTag).filter((value) => value.length > 0))];

  if (normalized.length === 0) return [];

  const rows = db
    .select({ label: tags.label })
    .from(tags)
    .where(inArray(tags.normalized, normalized))
    .all();

  return rows.map((row) => row.label).slice(0, MAX_TAGS_PER_OBJECT);
}

async function listInternalAssetTitles(db: AppDatabase, ownerSub: string): Promise<string[]> {
  const rows = await repoFor(db).list({
    ownerSub,
    type: "asset",
    library: "internal",
    limit: MAX_INTERNAL_TITLES,
    sort: "updated",
  });

  return rows.map((row) => row.title);
}

/** 提示词里展示的已有标签：让模型优先复用词表，而不是每篇都造新词。 */
function listPromptTags(db: AppDatabase): string[] {
  return db
    .select({ label: tags.label })
    .from(tags)
    .orderBy(asc(tags.sortOrder), asc(tags.label))
    .limit(MAX_PROMPT_TAGS)
    .all()
    .map((row) => row.label);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface ContentSnapshot {
  contentHash: string;
  contentSnapshot: string;
  contentSnapshotAt: string;
}

/**
 * 实践结算的正文快照（规格 v2.1 §4）：读正文 → sha256 + 前 2000 字。
 *
 * 读取失败或超时都只记审计、返回 null，**不阻塞结算**——「已实践必须立即
 * 沉淀」是硬规则；快照只是让资产在作品大改后仍有据可查。
 */
async function readContentSnapshot(
  db: AppDatabase,
  actor: ActorContext,
  workId: string,
  deps: AssetServiceDeps,
  at: string,
): Promise<ContentSnapshot | null> {
  const reader = deps.readContent ?? readWorkContentFromRagflow;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`读取正文超过 ${SNAPSHOT_READ_TIMEOUT_MS / 1_000} 秒`)),
        SNAPSHOT_READ_TIMEOUT_MS,
      );
    });
    const content = (
      await Promise.race([reader(db, actor.sub, workId), timeout])
    ).trim();

    if (!content) return null;

    return {
      contentHash: sha256Hex(content),
      contentSnapshot: content.slice(0, SNAPSHOT_MAX_CHARS),
      contentSnapshotAt: at,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "读取正文失败";

    try {
      writeAudit(db, {
        actor,
        action: "value.snapshot_failed",
        targetType: "work",
        targetId: workId,
        detail: { reason },
        result: "error",
        createdAt: at,
      });
    } catch (auditError) {
      console.error("[asset] 写快照失败审计时出错", auditError);
    }

    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* 请求体                                                                      */
/* -------------------------------------------------------------------------- */

function asOptionalRecord(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};

  if (typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("请求体必须是 JSON 对象");
  }

  return body as Record<string, unknown>;
}

function readExpectedRevision(record: Record<string, unknown>): number | undefined {
  const value = record.expectedRevision;

  if (value === undefined || value === null) return undefined;

  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ValidationError("expectedRevision 必须是正整数", { field: "expectedRevision" });
  }

  return value;
}

export interface ReviewBody {
  decision: "approve" | "reject";
  note: string | null;
  expectedRevision?: number;
}

export function parseReviewBody(body: unknown): ReviewBody {
  const record = asOptionalRecord(body);
  const decision = record.decision;

  if (decision !== "approve" && decision !== "reject") {
    throw new ValidationError("decision 只能是 approve 或 reject", {
      field: "decision",
      allowed: ["approve", "reject"],
    });
  }

  const note = record.note;

  if (note !== undefined && note !== null && typeof note !== "string") {
    throw new ValidationError("note 必须是字符串", { field: "note" });
  }

  const trimmed = typeof note === "string" ? note.trim() : "";

  if (trimmed.length > 500) {
    throw new ValidationError("note 不能超过 500 个字符", { field: "note", max: 500 });
  }

  const expectedRevision = readExpectedRevision(record);

  return {
    decision,
    note: trimmed || null,
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
  };
}

export interface PracticeBody {
  metrics: Record<string, unknown> | null;
  expectedRevision?: number;
}

export function parsePracticeBody(body: unknown): PracticeBody {
  const record = asOptionalRecord(body);
  const raw = record.metrics;
  let metrics: Record<string, unknown> | null = null;

  if (raw !== undefined && raw !== null) {
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new ValidationError("metrics 必须是 JSON 对象", { field: "metrics" });
    }

    const text = JSON.stringify(raw);

    if (text.length > MAX_PRACTICE_METRICS_BYTES) {
      throw new ValidationError("metrics 过大，请只保留关键数据快照", {
        field: "metrics",
        maxBytes: MAX_PRACTICE_METRICS_BYTES,
      });
    }

    metrics = raw as Record<string, unknown>;
  }

  const expectedRevision = readExpectedRevision(record);

  return {
    metrics,
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* 1) AI 提炼                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 仅外库作品的「草稿」状态可触发（规格第 3.1 节第 2 条、第 7 节第 1 条）。
 *
 * 提炼出的外库资产先落库，再逐条打分：打分失败的那条保持 `unscored`，
 * 不阻塞其余资产——用户可以对单条再点「打分」，比整批回滚更接近真实用法。
 */
export async function extractAssetsFromWork(
  db: AppDatabase,
  actor: ActorContext,
  objectId: string,
  deps: AssetServiceDeps = {},
): Promise<BusinessObject[]> {
  const work = await getObject(db, actor.sub, objectId);

  if (work.type !== "work") {
    throw new ConflictError("AI 提炼只能从作品触发", { id: objectId, type: work.type });
  }

  if (work.library !== "external") {
    throw new ConflictError("AI 提炼只能从外库作品触发", {
      id: objectId,
      library: work.library,
    });
  }

  if (work.status !== "draft") {
    throw new ConflictError("AI 自动提炼只允许从「草稿」状态触发", {
      id: objectId,
      status: work.status,
    });
  }

  // 幂等：同一草稿已有提炼产物时直接拒绝，避免连点两次生成两份资产。
  // 删除旧资产后可重新提炼（查重只看未删除的行）。
  const existing = await repoFor(db).findExtractedByOriginWork(work.id);

  if (existing) {
    throw new DomainError(
      "EXTRACT_DUPLICATE",
      "该草稿已提炼过资产，如需重新提炼请先删除旧资产",
      { id: objectId, assetId: existing.id },
    );
  }

  const reader = deps.readContent ?? readWorkContentFromRagflow;
  const content = (await reader(db, actor.sub, objectId)).trim();

  if (!content) {
    throw new DomainError(
      "NO_CONTENT",
      "作品没有可提炼的正文：请先上传内容并等待解析完成",
      { id: objectId },
    );
  }

  const candidates = await extractAssetCandidates(db, work, content, deps, {
    availableTags: listPromptTags(db),
  });

  if (candidates.length === 0) return [];

  const repo = repoFor(db);
  const at = nowIso();
  // 快照口径（v2.1 §1）：excerpt 存 content_snapshot，hash 用整篇正文。
  const contentHash = sha256Hex(content);
  const created: BusinessObject[] = [];

  for (const candidate of candidates) {
    created.push(
      await repo.create({
        type: "asset",
        title: candidate.title,
        description: candidate.description || null,
        // 提炼产物一律进外库等待打分，绝不直接进内库。
        library: "external",
        source: "ai_extracted",
        sourceType: "ai_extract",
        aiStatus: "unscored",
        origin: "self",
        category: work.category,
        tags: existingTagLabels(db, candidate.tags),
        priority: work.priority,
        ownerSub: actor.sub,
        // 来源线索：批量提炼的资产都指回触发它的草稿（幂等查重也看这一列）。
        originWorkId: work.id,
        // 正文快照：模型逐字摘录的片段 + 整篇正文 hash，作品大改后仍可核对。
        contentHash,
        contentSnapshot: candidate.excerpt,
        contentSnapshotAt: at,
        now: at,
      }),
    );
  }

  const scored: BusinessObject[] = [];

  for (const asset of created) {
    try {
      scored.push(await scoreExternalAsset(db, actor, asset.id, deps));
    } catch {
      // 打分失败保留 unscored：提炼成果不该因为一次评分抖动而丢失。
      scored.push(asset);
    }
  }

  return scored;
}

/* -------------------------------------------------------------------------- */
/* 2) 6 维打分                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 外库资产打分 → 三档处置：
 *   ≥75 自动进内库（同时完成 5 维评估，兜底保证一定有等级）
 *   60–74 待人工复核
 *   <60  低价值，留在外库
 */
export async function scoreExternalAsset(
  db: AppDatabase,
  actor: ActorContext,
  objectId: string,
  deps: AssetServiceDeps = {},
): Promise<BusinessObject> {
  const asset = await getObject(db, actor.sub, objectId);

  if (asset.type !== "asset") {
    throw new ConflictError("只有资产可以打 AI 分", { id: objectId, type: asset.type });
  }

  if (asset.library !== "external") {
    throw new ConflictError("只有外库资产需要打分，内库资产请直接重评价值", {
      id: objectId,
      library: asset.library,
    });
  }

  const at = nowIso();
  const internalTitles = await listInternalAssetTitles(db, actor.sub);
  const detail = await scoreAssetByModel(db, asset, internalTitles, deps, at);

  const assessment =
    detail.verdict === "auto_pass"
      ? await assessForInternal(db, asset, deps, at)
      : null;

  return repoFor(db).applyAiScore({
    objectId,
    detail,
    assessment,
    actor,
    now: at,
  });
}

/** 进入内库前的 5 维评估：模型不可用时退回确定性兜底，绝不因为评分失败而拒绝入库。 */
async function assessForInternal(
  db: AppDatabase,
  asset: BusinessObject,
  deps: AssetServiceDeps,
  at: string,
): Promise<ValueAssessmentInput> {
  const scores = await evaluateValueScores(db, asset, deps, {
    now: at,
    fallbackOnError: true,
  });

  return {
    valueLevel: scores.level,
    valueScores: scores,
    valueAssessedAt: scores.assessedAt,
  };
}

/* -------------------------------------------------------------------------- */
/* 3) 人工复核                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 只有「待人工复核」的资产可以复核（规格第 4.2 节）：
 * approve → 内库 + 5 维评估 + approved；reject → 低价值外库。
 */
export async function reviewAsset(
  db: AppDatabase,
  actor: ActorContext,
  objectId: string,
  body: unknown,
  deps: AssetServiceDeps = {},
): Promise<BusinessObject> {
  const params = parseReviewBody(body);
  const asset = await getObject(db, actor.sub, objectId);

  if (asset.type !== "asset") {
    throw new ConflictError("只有资产可以人工复核", { id: objectId, type: asset.type });
  }

  if (asset.aiStatus !== "needs_review") {
    throw new ConflictError("只有待人工复核的资产可以复核", {
      id: objectId,
      aiStatus: asset.aiStatus,
    });
  }

  const at = nowIso();
  const assessment =
    params.decision === "approve" ? await assessForInternal(db, asset, deps, at) : null;

  return repoFor(db).reviewAsset({
    objectId,
    decision: params.decision,
    note: params.note,
    assessment,
    expectedRevision: params.expectedRevision,
    actor,
    now: at,
  });
}

/* -------------------------------------------------------------------------- */
/* 4) 实践结算                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 标记「已实践」：外库 + published 的作品，一次性完成
 *   建内库资产（source_type = practiced_work，复制标题/描述/分类/标签/优先级）
 *   → 5 维评估赋级 → 作品 practiced / practiced_at / metrics / settled_asset_id（不归档）。
 *
 * 模型不可用时用确定性兜底（C 级），结算照常完成——「已实践必须立即沉淀」
 * 是硬规则，不能因为模型抖动而失败（规格第 7 节第 2 条）。
 */
export async function practiceWork(
  db: AppDatabase,
  actor: ActorContext,
  objectId: string,
  body: unknown,
  deps: AssetServiceDeps = {},
): Promise<{ work: BusinessObject; asset: BusinessObject }> {
  const params = parsePracticeBody(body);
  const work = await getObject(db, actor.sub, objectId);

  if (work.type !== "work") {
    throw new ConflictError("只有作品可以标记已实践", { id: objectId, type: work.type });
  }

  if (work.library !== "external") {
    throw new DomainError("WORK_MUST_BE_EXTERNAL", "作品只能在外库标记已实践", {
      id: objectId,
      library: work.library,
    });
  }

  if (work.status !== "published") {
    throw new ConflictError("只有已发布的作品可以标记已实践", {
      id: objectId,
      status: work.status,
    });
  }

  const at = nowIso();
  // 快照与模型评估都在事务外完成：RAGFlow 读取失败 / 模型失败都不能把
  // 「已实践」卡在半路（快照失败只记审计，模型失败退回确定性兜底）。
  const snapshot = await readContentSnapshot(db, actor, objectId, deps, at);
  const scores = await evaluateValueScores(db, work, deps, {
    now: at,
    fallbackOnError: true,
  });

  const settled = await repoFor(db).settlePractice({
    workId: objectId,
    expectedRevision: params.expectedRevision,
    metrics: params.metrics,
    assessment: {
      valueLevel: scores.level,
      valueScores: scores,
      valueAssessedAt: scores.assessedAt,
    },
    asset: {
      title: work.title,
      description: work.description,
      category: work.category,
      tags: work.tags,
      priority: work.priority,
      source: work.source,
      origin: work.origin,
      ...(snapshot ?? {}),
    },
    actor,
    now: at,
  });

  if (scores.source === "fallback") {
    // 兜底结算会让资产直接落 C 级，必须留痕供「批量重评 / 指标」发现。
    try {
      writeAudit(db, {
        actor,
        action: "value.fallback",
        targetType: "asset",
        targetId: settled.asset.id,
        detail: { workId: objectId, reason: "模型不可用或返回脏数据，按确定性兜底评为 C" },
        result: "error",
        createdAt: at,
      });
    } catch (error) {
      console.error("[asset] 写兜底审计失败", error);
    }
  }

  return settled;
}

/* -------------------------------------------------------------------------- */
/* 5) 内库资产重评                                                             */
/* -------------------------------------------------------------------------- */

/**
 * 主动重评：模型失败直接报错，不做静默降级——用户点「重评」的预期是拿到
 * 新结果，把好资产悄悄判成 C 比明确失败更伤人。已有的 `value_*` 保持不动。
 */
export async function assessAssetValue(
  db: AppDatabase,
  actor: ActorContext,
  objectId: string,
  deps: AssetServiceDeps = {},
): Promise<BusinessObject> {
  const asset = await getObject(db, actor.sub, objectId);

  if (asset.type !== "asset") {
    throw new ConflictError("只有资产需要价值评估", { id: objectId, type: asset.type });
  }

  if (asset.library !== "internal") {
    throw new ConflictError("只有内库资产需要价值评估", {
      id: objectId,
      library: asset.library,
    });
  }

  const at = nowIso();
  const scores = await evaluateValueScores(db, asset, deps, {
    now: at,
    fallbackOnError: false,
  });

  return repoFor(db).applyValueAssessment({
    objectId,
    assessment: {
      valueLevel: scores.level,
      valueScores: scores,
      valueAssessedAt: scores.assessedAt,
    },
    actor,
    now: at,
  });
}

