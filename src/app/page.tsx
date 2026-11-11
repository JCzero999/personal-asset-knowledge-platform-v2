import { WelcomePage } from "@/components/welcome-page";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getSession();

  return <WelcomePage signedIn={Boolean(session)} userName={session?.name ?? null} />;
}
