import { notFound } from "next/navigation";

import { WorkspaceView } from "@/components/workspace-view";
import { filterByLifecycle, parseLifecycleFilters } from "@/components/lifecycle";
import {
  LIST_LIMIT,
  SUMMARY_LIMIT,
  parseWorkspaceFilters,
  toListObjectsQuery,
  type WorkspaceSearchParams,
} from "@/lib/workspace-filters";
import { NotFoundError } from "@/domain/errors";
import type { ContentRef } from "@/domain/content-ref";
import type { BusinessObject } from "@/domain/objects";
import { getDb } from "@/server/db/client";
import { listObjectContent } from "@/server/services/content-service";
import { getObject, listObjects } from "@/server/services/object-service";
import { listVocabulary } from "@/server/services/vocabulary-service";
import { requireSession, resolveAuthMode } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 工作台唯一入口：`/workspace` 是概览 + 列表，`/workspace/{id}` 是同一屏里
 * 选中一条内容。用可选 catch-all 把两种状态收进一个页面，列表与详情共享筛选。
 */
export default async function WorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug?: string[] }>;
  searchParams: Promise<WorkspaceSearchParams>;
}) {
  const session = await requireSession();
  const search = await searchParams;
  const filters = parseWorkspaceFilters(search);
  // 复核状态 / 价值等级与主筛选并列：仓库还未按新字段过滤时，在页面层裁一次，
  // 保证入口链接（如「待人工复核 N」）落到正确结果集。
  const lifecycle = parseLifecycleFilters(search);
  const { slug } = await params;
  const selectedId = slug?.[0] ?? null;
  const db = getDb();

  // 词表是列表 / 详情 / 新建面板 / 筛选 / 目录的唯一来源（ADR-016 第 5 条）。
  const vocabulary = listVocabulary(db);

  const [listed, allObjects, archivedObjects] = await Promise.all([
    listObjects(db, { ownerSub: session.sub, ...toListObjectsQuery(filters, LIST_LIMIT) }),
    listObjects(db, { ownerSub: session.sub, limit: SUMMARY_LIMIT }),
    listObjects(db, {
      ownerSub: session.sub,
      archivedOnly: true,
      limit: SUMMARY_LIMIT,
    }),
  ]);
  const objects = filterByLifecycle(listed, lifecycle);

  let selected: BusinessObject | null = null;
  let selectedRefs: ContentRef[] = [];

  if (selectedId) {
    try {
      selected = await getObject(db, session.sub, selectedId);
      selectedRefs = await listObjectContent(db, session.sub, selected.id);
    } catch (error) {
      if (error instanceof NotFoundError) notFound();
      throw error;
    }
  }

  return (
    <WorkspaceView
      session={session}
      objects={objects}
      allObjects={allObjects}
      archivedObjects={archivedObjects}
      filters={filters}
      lifecycle={lifecycle}
      selected={selected}
      selectedRefs={selectedRefs}
      vocabulary={vocabulary}
      signOutHref={resolveAuthMode() === "logto" ? "/api/logto/sign-out" : null}
    />
  );
}
