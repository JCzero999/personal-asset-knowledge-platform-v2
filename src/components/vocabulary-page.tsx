import { AdminDirectory } from "@/components/directory";
import { Icon } from "@/components/icon";
import { NavRail } from "@/components/nav-rail";
import { VocabularyManager } from "@/components/vocabulary-manager";
import { getDb } from "@/server/db/client";
import { hasPermission } from "@/server/authz";
import { requireSession, resolveAuthMode } from "@/server/session";
import { listVocabulary } from "@/server/services/vocabulary-service";

/**
 * 词表管理页的共用骨架（ADR-019 / ADR-023）：`/admin/vocabulary/categories` 与
 * `/admin/vocabulary/tags` 只在标题和列表类型上不同，导航、权限与数据读取
 * 完全一致，因此放在一个服务端组件里，避免两份 403 兜底和责任页头。
 */
export type VocabularyTab = "categories" | "tags";

export async function VocabularyPage({ tab }: { tab: VocabularyTab }) {
  const session = await requireSession();
  const signOutHref = resolveAuthMode() === "logto" ? "/api/logto/sign-out" : null;

  const canManage = hasPermission(
    session,
    tab === "categories" ? "vocabulary:category:write" : "vocabulary:tag:write",
  );

  if (!canManage) {
    return (
      <div className="app-frame">
        <NavRail session={session} active="admin" signOutHref={signOutHref} />
        <main className="record-detail">
          <div className="detail-scroll">
            <div className="workspace">
              <header className="workspace-header">
                <div className="workspace-greeting">
                  <p className="workspace-date">系统管理 · 词表</p>
                  <h1>没有访问权限</h1>
                  <p className="workspace-subtitle">
                    当前账号不在管理员名单里，看不到这个页面。
                  </p>
                </div>
              </header>
              <section className="panel empty-state" role="alert">
                <span className="empty-icon"><Icon name="alert" size={26} /></span>
                <div className="empty-copy">
                  <strong>当前账号没有管理员权限</strong>
                  <p>管理词表需要管理员权限，请联系管理员开通后再进入。</p>
                </div>
              </section>
            </div>
          </div>
        </main>
      </div>
    );
  }

  const vocabulary = listVocabulary(getDb());
  const taxonomyCounts = {
    categories: vocabulary.categories.filter((item) => item.state === "active").length,
    tags: vocabulary.tags.length,
  };
  const isCategories = tab === "categories";

  return (
    <div className="app-frame">
      <NavRail session={session} active="admin" signOutHref={signOutHref} />
      <AdminDirectory
        session={session}
        active={tab === "categories" ? "/admin/vocabulary/categories" : "/admin/vocabulary/tags"}
        taxonomyCounts={taxonomyCounts}
      />

      <main className="record-detail">
        <div className="detail-scroll">
          <div className="workspace admin-workspace">
            <header className="workspace-header">
              <div className="workspace-greeting">
                <p className="workspace-date">系统管理 · 词表</p>
                <h1>{isCategories ? "管理分类" : "管理标签"}</h1>
                <p className="workspace-subtitle">
                  {isCategories
                    ? "分类决定内容的归属。改动会立刻同步到新建弹窗、编辑弹窗、详情与导出。"
                    : "标签是内容的横切属性。改名、合并都会保留已有对象的关联。"}
                </p>
              </div>
              <div className="header-actions">
                <a className="text-button" href="/admin">返回总览</a>
              </div>
            </header>

            <VocabularyManager tab={tab} vocabulary={vocabulary} />
          </div>
        </div>
      </main>
    </div>
  );
}
