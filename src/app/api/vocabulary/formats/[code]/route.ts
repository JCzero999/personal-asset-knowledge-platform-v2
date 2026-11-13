import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** ADR-023：单个形态的旧地址 → 分类地址，308 保留方法与查询串。 */
async function permanentRedirectToCategory(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code } = await params;
  const url = new URL(request.url);

  return NextResponse.redirect(
    new URL(`/api/vocabulary/categories/${code}${url.search}`, url),
    308,
  );
}

export const GET = permanentRedirectToCategory;
export const POST = permanentRedirectToCategory;
export const PATCH = permanentRedirectToCategory;
export const DELETE = permanentRedirectToCategory;
export const PUT = permanentRedirectToCategory;
