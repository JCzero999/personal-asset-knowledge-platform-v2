import { signIn } from "@logto/next/server-actions";

import { createLogtoConfig } from "@/server/adapters/session/logto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const config = createLogtoConfig();

  await signIn(config, {
    redirectUri: `${config.baseUrl}/api/logto/sign-in-callback`,
    postRedirectUri: `${config.baseUrl}/workspace`,
  });
}
