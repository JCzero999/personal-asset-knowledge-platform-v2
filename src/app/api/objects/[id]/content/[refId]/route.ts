import { getDb } from "@/server/db/client";
import { fromError } from "@/server/http/respond";
import { downloadObjectContent } from "@/server/services/content-service";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 下载内容原文：只允许该对象自己的内容引用，文件流透传 RAGFlow。 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; refId: string }> },
) {
  const session = await getSession();
  if (!session) return new Response("请先登录", { status: 401 });

  try {
    const { id, refId } = await params;
    const { ref, file } = await downloadObjectContent(getDb(), session.sub, id, refId);
    const filename = file.filename ?? ref.documentName ?? "content";
    const headers = new Headers({
      "Content-Type": file.contentType,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
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
