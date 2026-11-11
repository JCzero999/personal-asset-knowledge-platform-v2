import { WorkspaceShell } from "@/components/workspace-shell";
import { getDb } from "@/server/db/client";
import { listObjects } from "@/server/services/object-service";
import { requireSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function WorkspacePage() {
  const session = await requireSession();
  const objects = await listObjects(getDb(), { ownerSub: session.sub });

  return <WorkspaceShell session={session} objects={objects} />;
}
