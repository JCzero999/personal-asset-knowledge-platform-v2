import { signOut } from "@logto/next/server-actions";

import { createLogtoConfig } from "@/server/adapters/session/logto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const config = createLogtoConfig();
  await signOut(config, `${config.baseUrl}/`);
}
