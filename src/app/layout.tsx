import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

import { DEFAULT_THEME, THEME_BOOTSTRAP } from "@/lib/theme";

export const metadata: Metadata = {
  title: "个人资产与知识平台",
  description: "把资料沉淀成资产，把想法推进成作品的个人工作台。",
};

/**
 * 首屏防闪（设计稿 §3.5 / ADR-021 第 10 条）：
 * 脚本由 `src/lib/theme.ts` 的 `THEME_BOOTSTRAP` 生成，与运行时共用白名单与键名；
 * 同步读 `localStorage["pakp.theme"]`（含旧键 `theme` 的一次性迁移）并写
 * `<html data-theme>`，避免刷新时先渲染默认主题再跳变。任何异常都回落到默认主题。
 */

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // 浏览器扩展会在 React 加载前往 <html>/<body> 上挂属性（如 data-atm-ext-installed），
  // 只屏蔽这两个元素自身的属性比对，子树的真实水合问题仍会照常报告。
  return (
    <html lang="zh-CN" data-theme={DEFAULT_THEME} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
