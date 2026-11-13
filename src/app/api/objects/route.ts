import { ValidationError } from "@/domain/errors";
import { getDb } from "@/server/db/client";
import { created, fail, fromError, ok } from "@/server/http/respond";
import {
  createObject,
  listObjects,
  parseListObjectsQuery,
} from "@/server/services/object-service";
import { requirePermission, toActor } from "@/server/authz";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await getSession();
  const denied = requirePermission(session, "object:read");
  if (denied) return denied;

  try {
    const query = parseListObjectsQuery(new URL(request.url).searchParams);
    return ok(await listObjects(getDb(), { ...query, ownerSub: session!.sub }));
  } catch (error) {
    return fromError(error);
  }
}

export async function POST(request: Request) {
  const session = await getSession();
  const denied = requirePermission(session, "object:write");
  if (denied) return denied;

  try {
    const body = await request.json().catch(() => {
      throw new ValidationError("请求体不是合法 JSON");
    });
    return created(await createObject(getDb(), toActor(session!), body));
  } catch (error) {
    return fromError(error);
  }
}
