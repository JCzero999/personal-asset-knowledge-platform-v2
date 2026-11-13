import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 路由守卫扫描（ADR-019 第 3 层）。
 *
 * 人工评审会漏：新增一个 route.ts 忘记加 `requirePermission` 时，
 * 接口就是全开的。这里直接扫源码，要求每个导出的 HTTP 方法体内
 * 出现守卫调用，否则测试失败。白名单只有两个公共入口。
 */

const API_ROOT = path.resolve("src/app/api");

/** 公共路由：无需登录即可访问，其他一律必须有守卫。 */
const PUBLIC_ROUTES = ["health/route.ts", "logto/"];

/**
 * 纯跳转路由：只 308 到新地址，不读写数据，因此不需要权限守卫（ADR-023）。
 * 单独的用例会确认它们确实只做跳转。
 */
const REDIRECT_ROUTES = ["vocabulary/formats/route.ts", "vocabulary/formats/[code]/route.ts"];

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

function walk(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full));
    } else if (entry === "route.ts") {
      files.push(full);
    }
  }

  return files.sort();
}

function relative(file: string): string {
  return path.relative(API_ROOT, file).split(path.sep).join("/");
}

function isPublic(rel: string): boolean {
  return PUBLIC_ROUTES.some((entry) => (entry.endsWith("/") ? rel.startsWith(entry) : rel === entry));
}

/** 截取某个导出函数从声明到下一个顶层 `export`（或文件末尾）的源码。 */
function methodBody(source: string, start: number): string {
  const next = source.slice(start + 1).search(/\nexport /);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

interface RouteMethod {
  file: string;
  method: string;
  body: string;
}

function collect(): { file: string; methods: RouteMethod[] }[] {
  return walk(API_ROOT).map((file) => {
    const source = readFileSync(file, "utf8");
    const methods: RouteMethod[] = [];

    for (const method of HTTP_METHODS) {
      const pattern = new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`, "g");
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source)) !== null) {
        methods.push({ file, method, body: methodBody(source, match.index) });
      }
    }

    return { file, methods };
  });
}

describe("route guard：每个 API 方法都必须有权限守卫", () => {
  const routes = collect();

  it("扫描到了路由文件（防止空扫描假通过）", () => {
    expect(routes.length).toBeGreaterThan(10);
  });

  it("每个导出的方法都调用 requirePermission / adminGuard，或位于公共白名单", () => {
    const violations: string[] = [];

    for (const route of routes) {
      const rel = relative(route.file);
      if (isPublic(rel) || REDIRECT_ROUTES.includes(rel)) continue;

      if (route.methods.length === 0) {
        violations.push(`${rel}: 没有导出任何 HTTP 方法`);
        continue;
      }

      for (const method of route.methods) {
        if (!/requirePermission\s*\(|adminGuard\s*\(|inlineVocabularyGuard\s*\(/.test(method.body)) {
          violations.push(`${rel}#${method.method}: 方法体里没有权限守卫`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("旧词表地址只做 308 跳转", () => {
    for (const rel of REDIRECT_ROUTES) {
      const source = readFileSync(path.join(API_ROOT, rel), "utf8");
      expect(source).toContain("308");
      expect(source).toContain("/api/vocabulary/categories");
    }
  });

  it("公共白名单只包含 health 与 logto", () => {
    const publicFiles = routes
      .map((route) => relative(route.file))
      .filter((rel) => isPublic(rel));

    for (const file of publicFiles) {
      expect(
        file === "health/route.ts" || file.startsWith("logto/"),
        `白名单里出现了不该放行的路由：${file}`,
      ).toBe(true);
    }

    expect(publicFiles).toContain("health/route.ts");
  });

  it("路由层不得用 session.isAdmin 做授权判断（isAdmin 只用于导航显隐）", () => {
    const violations = routes
      .filter((route) => readFileSync(route.file, "utf8").includes("isAdmin"))
      .map((route) => relative(route.file));

    expect(violations).toEqual([]);
  });
});
