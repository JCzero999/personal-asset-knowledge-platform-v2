import { ValidationError } from "@/domain/errors";
import { getDb } from "@/server/db/client";
import { fail, fromError, ok } from "@/server/http/respond";
import { changeObjectStatus } from "@/server/services/object-service";
import { practiceWork } from "@/server/services/asset-service";
import { requirePermission, toActor } from "@/server/authz";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  const denied = requirePermission(session, "object:write");
  if (denied) return denied;

  try {
    const body = await request.json().catch(() => {
      throw new ValidationError("请求体不是合法 JSON");
    });
    const { id } = await params;
    const actor = toActor(session!);

    // 「已实践」不是普通状态迁移：必须同时沉淀内库资产（规格 v2.0 第 5 节），
    // 所以这里直接走实践结算，仓储的 changeStatus 会拒绝直达 practiced。
    if (body?.to === "practiced") {
      const { work } = await practiceWork(getDb(), actor, id, body);
      return ok(work);
    }

    return ok(await changeObjectStatus(getDb(), actor, id, body));
  } catch (error) {
    return fromError(error);
  }
}
