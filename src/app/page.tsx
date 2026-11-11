import { WelcomePage } from "@/components/welcome-page";
import { getSession, resolveAuthMode } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getSession();

  return (
    <WelcomePage
      signedIn={Boolean(session)}
      userName={session?.name ?? null}
      signInHref={resolveAuthMode() === "logto" ? "/api/logto/sign-in" : null}
    />
  );
}
