import { statSync } from "node:fs";
import path from "node:path";

import { eq, desc } from "drizzle-orm";

import type { AppDatabase } from "@/server/db/client";
import { contentRefs, objects, syncJobs } from "@/server/db/schema";

/**
 * 管理后台的只读统计 + 服务连通性探测。
 *
 * 统计直接在单表上取行再聚合：本地单用户库是几百行量级，
 * 用一条 SQL 的 GROUP BY 换不来可读性。
 */

export interface AdminOwnerSummary {
  ownerSub: string;
  objects: number;
  works: number;
  lastUpdatedAt: string | null;
}

export interface AdminOverview {
  objects: {
    total: number;
    assets: number;
    works: number;
    internal: number;
    external: number;
    archived: number;
    deleted: number;
  };
  content: {
    total: number;
    primary: number;
    attachment: number;
    parsePending: number;
    parseFailed: number;
    syncFailed: number;
  };
  jobs: {
    pending: number;
    running: number;
    done: number;
    failed: number;
  };
  owners: AdminOwnerSummary[];
  storage: { path: string; bytes: number | null };
}

export interface ServiceState {
  name: string;
  ok: boolean;
  detail: string;
}

function storageFile(): { path: string; bytes: number | null } {
  const file = path.resolve(process.env.DATABASE_PATH?.trim() || "data/app.db");

  try {
    return { path: file, bytes: statSync(file).size };
  } catch {
    return { path: file, bytes: null };
  }
}

export function loadAdminOverview(db: AppDatabase): AdminOverview {
  const objectRows = db
    .select({
      ownerSub: objects.ownerSub,
      type: objects.type,
      library: objects.library,
      archivedAt: objects.archivedAt,
      deletedAt: objects.deletedAt,
      updatedAt: objects.updatedAt,
    })
    .from(objects)
    .all();

  const contentRows = db
    .select({
      role: contentRefs.role,
      parseStatus: contentRefs.parseStatus,
      syncState: contentRefs.syncState,
      deletedAt: contentRefs.deletedAt,
    })
    .from(contentRefs)
    .all();

  const jobRows = db.select({ state: syncJobs.state }).from(syncJobs).all();

  const overview: AdminOverview = {
    objects: {
      total: 0,
      assets: 0,
      works: 0,
      internal: 0,
      external: 0,
      archived: 0,
      deleted: 0,
    },
    content: {
      total: 0,
      primary: 0,
      attachment: 0,
      parsePending: 0,
      parseFailed: 0,
      syncFailed: 0,
    },
    jobs: { pending: 0, running: 0, done: 0, failed: 0 },
    owners: [],
    storage: storageFile(),
  };

  const owners = new Map<string, AdminOwnerSummary>();

  for (const row of objectRows) {
    if (row.deletedAt) {
      overview.objects.deleted += 1;
      continue;
    }

    overview.objects.total += 1;
    if (row.type === "work") overview.objects.works += 1;
    else overview.objects.assets += 1;
    if (row.library === "internal") overview.objects.internal += 1;
    else overview.objects.external += 1;
    if (row.archivedAt) overview.objects.archived += 1;

    const summary = owners.get(row.ownerSub) ?? {
      ownerSub: row.ownerSub,
      objects: 0,
      works: 0,
      lastUpdatedAt: null,
    };
    summary.objects += 1;
    if (row.type === "work") summary.works += 1;
    if (!summary.lastUpdatedAt || row.updatedAt > summary.lastUpdatedAt) {
      summary.lastUpdatedAt = row.updatedAt;
    }
    owners.set(row.ownerSub, summary);
  }

  for (const row of contentRows) {
    if (row.deletedAt) continue;

    overview.content.total += 1;
    if (row.role === "primary") overview.content.primary += 1;
    else overview.content.attachment += 1;
    if (row.parseStatus === "pending" || row.parseStatus === "running") {
      overview.content.parsePending += 1;
    }
    if (row.parseStatus === "failed") overview.content.parseFailed += 1;
    if (row.syncState === "sync_failed") overview.content.syncFailed += 1;
  }

  for (const row of jobRows) {
    if (row.state === "pending") overview.jobs.pending += 1;
    else if (row.state === "running") overview.jobs.running += 1;
    else if (row.state === "done") overview.jobs.done += 1;
    else if (row.state === "failed") overview.jobs.failed += 1;
  }

  overview.owners = [...owners.values()].sort((a, b) => b.objects - a.objects);

  return overview;
}

async function probe(
  name: string,
  url: string | null,
  init: RequestInit = {},
  timeoutMs = 2500,
): Promise<ServiceState> {
  if (!url) {
    return { name, ok: false, detail: "未配置地址" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      cache: "no-store",
    });

    if (!response.ok) {
      return { name, ok: false, detail: `HTTP ${response.status}` };
    }

    const text = (await response.text()).trim();
    return { name, ok: true, detail: text ? text.slice(0, 80) : "已连接" };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return { name, ok: false, detail: aborted ? "请求超时" : "无法连接" };
  } finally {
    clearTimeout(timer);
  }
}

/** 三个外部依赖各探一次；任何一个挂了都不影响后台其余部分。 */
export async function checkServices(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ServiceState[]> {
  const ragflowBase = env.RAGFLOW_BASE_URL?.trim().replace(/\/+$/, "");
  const lightragBase = env.LIGHTRAG_BASE_URL?.trim().replace(/\/+$/, "");
  const logtoBase = env.LOGTO_ENDPOINT?.trim().replace(/\/+$/, "");

  const [ragflow, lightrag, logto] = await Promise.all([
    probe(
      "RAGFlow",
      ragflowBase ? `${ragflowBase}/v1/system/version` : null,
      env.RAGFLOW_API_KEY
        ? { headers: { Authorization: `Bearer ${env.RAGFLOW_API_KEY.trim()}` } }
        : {},
    ),
    probe(
      "LightRAG",
      lightragBase ? `${lightragBase}/health` : null,
      env.LIGHTRAG_API_KEY ? { headers: { "X-API-Key": env.LIGHTRAG_API_KEY.trim() } } : {},
    ),
    probe("Logto", logtoBase ? `${logtoBase}/api/status` : null),
  ]);

  return [ragflow, lightrag, logto];
}

/** 总览页的最近失败：同步任务与解析失败各取几条，合并按时间倒序。 */
export interface AdminFailure {
  id: string;
  kind: "sync" | "parse";
  target: string;
  message: string;
  at: string;
}

export function listRecentFailures(db: AppDatabase, limit = 5): AdminFailure[] {
  const syncRows = db
    .select({
      id: syncJobs.id,
      action: syncJobs.action,
      message: syncJobs.lastError,
      at: syncJobs.updatedAt,
      title: objects.title,
    })
    .from(syncJobs)
    .leftJoin(objects, eq(objects.id, syncJobs.ownerId))
    .where(eq(syncJobs.state, "failed"))
    .orderBy(desc(syncJobs.updatedAt))
    .limit(limit)
    .all();

  const parseRows = db
    .select({
      id: contentRefs.id,
      message: contentRefs.parseError,
      at: contentRefs.updatedAt,
      title: objects.title,
      name: contentRefs.documentName,
    })
    .from(contentRefs)
    .leftJoin(objects, eq(objects.id, contentRefs.ownerId))
    .where(eq(contentRefs.parseStatus, "failed"))
    .orderBy(desc(contentRefs.updatedAt))
    .limit(limit)
    .all();

  const failures: AdminFailure[] = [
    ...syncRows.map((row) => ({
      id: row.id,
      kind: "sync" as const,
      target: row.title ?? row.action,
      message: row.message?.trim() || "同步失败，没有留下原因",
      at: row.at,
    })),
    ...parseRows.map((row) => ({
      id: row.id,
      kind: "parse" as const,
      target: row.title ?? row.name ?? "内容引用",
      message: row.message?.trim() || "解析失败，没有留下原因",
      at: row.at,
    })),
  ];

  return failures.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
