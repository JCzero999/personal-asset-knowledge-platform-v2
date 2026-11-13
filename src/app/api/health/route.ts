import { resolveAuthMode } from "@/server/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 公共健康检查。保持同步与无依赖：探活不应触发迁移或鉴权。
 * `authMode` 让部署方一眼看出是否误把 mock 当生产（ADR-019 风险 A6）。
 */
export function GET() {
  return Response.json({
    status: "ok",
    service: "personal-asset-knowledge-platform",
    timestamp: new Date().toISOString(),
    authMode: resolveAuthMode(),
  });
}
