import type { Metadata } from "next";

import { GalaxyHome } from "@/components/galaxy-home";
import { buildCategoryLabelMap } from "@/lib/category-labels";
import { navItemsFor } from "@/lib/nav-items";
import { getDb } from "@/server/db/client";
import { listVocabulary } from "@/server/services/vocabulary-service";
import { getSession, resolveAuthMode } from "@/server/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "知产工作台",
  description: "从一个问题开始：搜索你的资产、作品与笔记。",
};

/**
 * 首页（ADR-018）。
 *
 * 会话判断只发生在服务端：未登录时不渲染任何需要登录的内容，
 * 也不把用户信息带进客户端。搜索框是否可用由 `signedIn` 决定。
 */
export default async function Home() {
  const session = await getSession();
  const authMode = resolveAuthMode();

  // 分类展示名只从词表来（ADR-023）。首页是公开页，词表读失败不该让首页崩，
  // 此时预览里回落到 code 本身。
  let categoryLabels: Record<string, string> = {};
  try {
    categoryLabels = Object.fromEntries(
      buildCategoryLabelMap(listVocabulary(getDb()).categories),
    );
  } catch (error) {
    console.error("[home] 分类词表读取失败", error);
  }

  return (
    <GalaxyHome
      navItems={session ? navItemsFor(session.isAdmin) : []}
      signedIn={Boolean(session)}
      signInHref={authMode === "logto" ? "/api/logto/sign-in" : null}
      signOutHref={authMode === "logto" ? "/api/logto/sign-out" : null}
      userName={session?.name ?? null}
      categoryLabels={categoryLabels}
    />
  );
}
