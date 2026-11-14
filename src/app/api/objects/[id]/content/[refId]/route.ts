import { getDb } from "@/server/db/client";
import {
  contentDisposition,
  inlineContentType,
} from "@/server/http/content-disposition";
import { fromError } from "@/server/http/respond";
import { downloadObjectContent } from "@/server/services/content-service";
import { requirePermission } from "@/server/authz";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 下载内容原文：只允许该对象自己的内容引用，文件流透传 RAGFlow。
 * `?inline=1` 改为浏览器内联展示（PDF / 图片预览、「查看原文」看文本），其余一律附件下载。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; refId: string }> },
) {
  const session = await getSession();
  const denied = requirePermission(session, "object:read");
  if (denied) return denied;

  try {
    const { id, refId } = await params;
    const inline = new URL(request.url).searchParams.get("inline") === "1";
    const { ref, file } = await downloadObjectContent(getDb(), session!.sub, id, refId);
    // RAGFlow 回传的文件名可能只剩扩展名（非 ASCII 被它过滤过），
    // 本地记录的上传名才是用户认得的那个，优先用它。
    const filename = ref.documentName ?? file.filename ?? "content";
    // RAGFlow 下载接口对部分格式（如 PDF）统一回 application/octet-stream，
    // 内嵌预览会因此被浏览器当成下载；本地记录的上传类型更准确。
    const contentType =
      file.contentType && file.contentType !== "application/octet-stream"
        ? file.contentType
        : (ref.mime ?? file.contentType ?? "application/octet-stream");
    const headers = new Headers({
      "Content-Type": inline ? inlineContentType(contentType, filename) : contentType,
      "Content-Disposition": contentDisposition(filename, inline),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (file.contentLength !== null) {
      headers.set("Content-Length", String(file.contentLength));
    }

    return new Response(file.body, { headers });
  } catch (error) {
    return fromError(error);
  }
}
