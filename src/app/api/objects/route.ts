import { ValidationError } from "@/domain/errors";
import { getDb } from "@/server/db/client";
import { created, fail, fromError, ok } from "@/server/http/respond";
import {
  createObject,
  listObjects,
  parseListObjectsQuery,
} from "@/server/services/object-service";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return fail("UNAUTHORIZED", "请先登录");

  try {
    const query = parseListObjectsQuery(new URL(request.url).searchParams);
    return ok(await listObjects(getDb(), { ...query, ownerSub: session.sub }));
  } catch (error) {
    return fromError(error);
  }
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return fail("UNAUTHORIZED", "请先登录");

  try {
    const body = await request.json().catch(() => {
      throw new ValidationError("请求体不是合法 JSON");
    });
    return created(await createObject(getDb(), session.sub, body));
  } catch (error) {
    return fromError(error);
  }
}
