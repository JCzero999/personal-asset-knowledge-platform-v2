import { getDb } from "@/server/db/client";
import { fail, fromError, ok } from "@/server/http/respond";
import { getSession } from "@/server/session";
import { runSyncOnce } from "@/server/services/sync-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 手动触发一轮 outbox 投递；后台 worker 会按间隔自动跑同一段逻辑。 */
export async function POST() {
  const session = await getSession();
  if (!session) return fail("UNAUTHORIZED", "请先登录");

  try {
    return ok(await runSyncOnce(getDb(), { limit: 20 }));
  } catch (error) {
    return fromError(error);
  }
}
