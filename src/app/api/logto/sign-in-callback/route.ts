import { handleSignIn } from "@logto/next/server-actions";
import { redirect } from "next/navigation";

import { createLogtoConfig } from "@/server/adapters/session/logto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  await handleSignIn(createLogtoConfig(), new URL(request.url).searchParams);
  redirect("/workspace");
}
