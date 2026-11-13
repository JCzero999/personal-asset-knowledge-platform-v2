import { fail, fromError, ok } from "@/server/http/respond";
import { getDb } from "@/server/db/client";
import { requirePermission } from "@/server/authz";
import { getSession } from "@/server/session";
import { graphStatus } from "@/server/services/graph-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 构图进度：只汇总当前账号对象对应的图文档（ADR-011）。 */
export async function GET() {
  const session = await getSession();
  const denied = requirePermission(session, "object:read");
  if (denied) return denied;

  try {
    return ok(await graphStatus(getDb(), session!.sub));
  } catch (error) {
    return fromError(error);
  }
}
