import { getDb } from "@/server/db/client";
import { fail, fromError, ok } from "@/server/http/respond";
import { getSession } from "@/server/session";
import { pollParsingOnce } from "@/server/services/parse-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 手动推进一轮解析状态轮询；后台 worker 会按间隔自动跑同一段逻辑。 */
export async function POST() {
  const session = await getSession();
  if (!session) return fail("UNAUTHORIZED", "请先登录");

  try {
    return ok(await pollParsingOnce(getDb(), { limit: 50 }));
  } catch (error) {
    return fromError(error);
  }
}
