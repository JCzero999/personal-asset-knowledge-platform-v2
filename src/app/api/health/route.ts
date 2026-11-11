export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    status: "ok",
    service: "personal-asset-knowledge-platform",
    timestamp: new Date().toISOString(),
  });
}
