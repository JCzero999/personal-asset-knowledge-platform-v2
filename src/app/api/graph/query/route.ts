import { getDb } from "@/server/db/client";
import { ValidationError } from "@/domain/errors";
import { fail, fromError, ok } from "@/server/http/respond";
import { requirePermission } from "@/server/authz";
import { getSession } from "@/server/session";
import { queryGraph } from "@/server/services/graph-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 图增强问答：body `{ q, mode? }`；mode 默认 mix。 */
export async function POST(request: Request) {
  const session = await getSession();
  const denied = requirePermission(session, "object:read");
  if (denied) return denied;

  try {
    const body = (await request.json().catch(() => null)) as { q?: unknown } | null;
    if (!body || typeof body.q !== "string") {
      throw new ValidationError("请求体需要 q 字段", { field: "q" });
    }
    return ok(await queryGraph(getDb(), session!.sub, body.q));
  } catch (error) {
    return fromError(error);
  }
}
