import { getDb } from "@/server/db/client";
import { fail, fromError, ok } from "@/server/http/respond";
import { getSession } from "@/server/session";
import { parseSearchQuery, searchContent } from "@/server/services/search-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 内容检索：q 必填，limit 1–50，library / threshold 可选。 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return fail("UNAUTHORIZED", "请先登录");

  try {
    const query = parseSearchQuery(new URL(request.url).searchParams);
    return ok(await searchContent(getDb(), session.sub, query));
  } catch (error) {
    return fromError(error);
  }
}
