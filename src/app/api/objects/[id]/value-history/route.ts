import { getDb } from "@/server/db/client";
import { fromError, ok } from "@/server/http/respond";
import {
  listObjectValueHistory,
  parseValueHistoryLimit,
} from "@/server/services/object-service";
import { requirePermission } from "@/server/authz";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 价值评估历史（v2.1 §3）：倒序，默认 20 条；跨 owner 一律 404。 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  const denied = requirePermission(session, "object:read");
  if (denied) return denied;

  try {
    const limit = parseValueHistoryLimit(new URL(request.url).searchParams);
    const { id } = await params;
    const items = await listObjectValueHistory(getDb(), session!.sub, id, limit);
    return ok({ items });
  } catch (error) {
    return fromError(error);
  }
}
