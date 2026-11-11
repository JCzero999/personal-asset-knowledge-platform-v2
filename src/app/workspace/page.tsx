import { WorkspaceShell } from "@/components/workspace-shell";
import {
  LIST_LIMIT,
  SUMMARY_LIMIT,
  parseWorkspaceFilters,
  toListObjectsQuery,
  type WorkspaceSearchParams,
} from "@/lib/workspace-filters";
import { getDb } from "@/server/db/client";
import { listObjects } from "@/server/services/object-service";
import { requireSession, resolveAuthMode } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function WorkspacePage({
  searchParams,
}: {
  searchParams: Promise<WorkspaceSearchParams>;
}) {
  const session = await requireSession();
  const filters = parseWorkspaceFilters(await searchParams);
  const db = getDb();

  // 列表跟随 URL 上的筛选；概览与阶段统计始终取「在用」全量，避免数字随筛选跳动。
  const [objects, allObjects] = await Promise.all([
    listObjects(db, { ownerSub: session.sub, ...toListObjectsQuery(filters, LIST_LIMIT) }),
    listObjects(db, { ownerSub: session.sub, limit: SUMMARY_LIMIT }),
  ]);

  return (
    <WorkspaceShell
      session={session}
      objects={objects}
      allObjects={allObjects}
      filters={filters}
      signOutHref={resolveAuthMode() === "logto" ? "/api/logto/sign-out" : null}
    />
  );
}
