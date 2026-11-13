import { ValidationError } from "@/domain/errors";
import { getDb } from "@/server/db/client";
import { requirePermission } from "@/server/authz";
import { fromError, ok } from "@/server/http/respond";
import { getSession } from "@/server/session";
import { retryGraphObjects } from "@/server/services/graph-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 重新抽取失败对象（只作用于当前账号的失败态对象）。
 *
 * 请求体：`{ "objectIds": ["…", "…"] }`，1–20 个，重复项按一次算。
 * 每个对象单独回显结果（resubmitted / skipped / failed），前端逐条展示。
 * 抽取仍在 LightRAG 后台进行，进度以 `GET /api/graph/status` 为准。
 */
export async function POST(request: Request) {
  const session = await getSession();
  const denied = requirePermission(session, "content:sync");
  if (denied) return denied;

  try {
    const body = await request.json().catch(() => {
      throw new ValidationError("请求体不是合法 JSON");
    });
    const payload =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    const raw = payload?.objectIds;
    if (!Array.isArray(raw)) {
      throw new ValidationError("objectIds 必须是数组", { field: "objectIds" });
    }
    const objectIds = raw.filter((item): item is string => typeof item === "string");

    return ok(await retryGraphObjects(getDb(), session!.sub, objectIds));
  } catch (error) {
    return fromError(error);
  }
}
