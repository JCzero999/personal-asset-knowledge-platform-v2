import type { Session } from "../ports/session";
import { requireAnyPermission, requirePermission, type PermissionKey } from "../authz";

/**
 * 薄封装（ADR-019 第 4 条）：不新增第二套判定，只是给词表维护接口一个
 * 语义化入口。真正的强制层永远是 `requirePermission`。
 */
export function adminGuard(
  session: Session | null,
  key: PermissionKey = "vocabulary:category:write",
): Response | null {
  return requirePermission(session, key, "当前账号没有维护词表的权限");
}

/**
 * 内联创建（ADR-023 第 8 条）：普通编辑者（`object:write`）也能在新建 /
 * 编辑弹窗里通过「＋ 自定义」新增词条；管理与别名操作仍要词表权限。
 * 这里按「任一满足」放行，仍然走同一个 `requirePermission` 强制层。
 */
export function inlineVocabularyGuard(
  session: Session | null,
  key: "vocabulary:category:write" | "vocabulary:tag:write",
): Response | null {
  return requireAnyPermission(
    session,
    ["object:write", key],
    "当前账号没有新建词条的权限",
  );
}
