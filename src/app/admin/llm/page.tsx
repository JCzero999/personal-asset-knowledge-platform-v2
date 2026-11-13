import { AdminForbidden, AdminPageShell } from "@/components/admin-shell";
import { LlmSettingsPanel } from "@/components/llm-settings";
import { hasPermission } from "@/server/authz";
import { getDb } from "@/server/db/client";
import { listVocabulary } from "@/server/services/vocabulary-service";
import { requireSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 系统 → 大模型（ADR-025）。
 *
 * 页面只判定权限与渲染骨架；配置的读取、保存、测试、应用都在客户端完成，
 * 这样「后端未就绪」时能就地提示，而不是整页 500。
 */
export default async function AdminLlmPage() {
  const session = await requireSession();

  if (!hasPermission(session, "settings:read")) {
    return <AdminForbidden session={session} area="大模型" permission="settings:read" />;
  }

  const vocabulary = listVocabulary(getDb());

  return (
    <AdminPageShell
      session={session}
      active="/admin/llm"
      kicker="系统 · 接入"
      title="大模型"
      description="图谱的实体抽取由这里配置的模型完成。本机模型免费但慢；换成外部服务后，同样的内容通常几十秒抽完。"
      taxonomyCounts={{
        categories: vocabulary.categories.filter((item) => item.state === "active").length,
        tags: vocabulary.tags.length,
      }}
    >
      <LlmSettingsPanel canWrite={hasPermission(session, "settings:write")} />
    </AdminPageShell>
  );
}
