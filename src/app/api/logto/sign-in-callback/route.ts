import { handleSignIn } from "@logto/next/server-actions";
import { redirect } from "next/navigation";

import { createLogtoConfig } from "@/server/adapters/session/logto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // 传完整回调 URL：助手默认按 `${baseUrl}/callback` 拼地址，与登记的
  // `/api/logto/sign-in-callback` 不一致时会报 redirect_uri_mismatched。
  await handleSignIn(createLogtoConfig(), new URL(request.url));
  redirect("/workspace");
}
