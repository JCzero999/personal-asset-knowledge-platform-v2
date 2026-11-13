import { permanentRedirect } from "next/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ADR-023：管理页路由更名为 `/admin/vocabulary/categories`。
 * 旧地址用 308（永久重定向）保留一年，书签与站内旧链接都不失效。
 */
export default function LegacyVocabularyFormatsPage() {
  permanentRedirect("/admin/vocabulary/categories");
}
