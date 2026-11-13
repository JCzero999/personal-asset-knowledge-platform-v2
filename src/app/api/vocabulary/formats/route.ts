import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * ADR-023：`/api/vocabulary/formats` 已更名为 `/api/vocabulary/categories`。
 * 旧地址保留 308 一个版本（方法不变，客户端不需要改调用方式即可迁移）。
 */
const LEGACY_PREFIX = "/api/vocabulary/formats";

function redirectToCategories(request: Request): NextResponse {
  const url = new URL(request.url);
  const target = url.pathname.replace(LEGACY_PREFIX, "/api/vocabulary/categories");

  return NextResponse.redirect(new URL(`${target}${url.search}`, url), 308);
}

export const GET = redirectToCategories;
export const POST = redirectToCategories;
export const PATCH = redirectToCategories;
export const DELETE = redirectToCategories;
export const PUT = redirectToCategories;
