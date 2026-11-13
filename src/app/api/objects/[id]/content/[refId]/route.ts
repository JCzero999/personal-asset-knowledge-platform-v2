import { getDb } from "@/server/db/client";
import { fromError } from "@/server/http/respond";
import { downloadObjectContent } from "@/server/services/content-service";
import { requirePermission } from "@/server/authz";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 下载内容原文：只允许该对象自己的内容引用，文件流透传 RAGFlow。 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; refId: string }> },
) {
  const session = await getSession();
  const denied = requirePermission(session, "object:read");
  if (denied) return denied;

  try {
    const { id, refId } = await params;
    const { ref, file } = await downloadObjectContent(getDb(), session!.sub, id, refId);
    // RAGFlow 回传的文件名可能只剩扩展名（非 ASCII 被它过滤过），
    // 本地记录的上传名才是用户认得的那个，优先用它。
    const filename = ref.documentName ?? file.filename ?? "content";
    const headers = new Headers({
      "Content-Type": file.contentType,
      "Content-Disposition": contentDisposition(filename),
      "Cache-Control": "private, no-store",
    });
    if (file.contentLength !== null) {
      headers.set("Content-Length", String(file.contentLength));
    }

    return new Response(file.body, { headers });
  } catch (error) {
    return fromError(error);
  }
}

/** 同时给出 ASCII 兜底名与 UTF-8 原名，中文文件名在两种浏览器上都能还原。 */
function contentDisposition(filename: string): string {
  const safe = filename.replace(/[\r\n"\\]/g, "").trim() || "content";
  const extension = /\.[A-Za-z0-9]{1,8}$/.exec(safe)?.[0] ?? "";
  const stem = safe
    .slice(0, safe.length - extension.length)
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/[:*?<>|/]/g, "")
    .trim();
  const fallback = `${stem || "download"}${extension}`;

  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
