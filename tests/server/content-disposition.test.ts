import { describe, expect, it } from "vitest";

import {
  contentDisposition,
  inlineContentType,
  isTextLikeContent,
} from "@/server/http/content-disposition";

describe("内容下载响应头", () => {
  it("默认是附件下载", () => {
    expect(contentDisposition("读书笔记.md")).toMatch(/^attachment;/);
  });

  it("inline 时改成内联，并保留 UTF-8 原名", () => {
    const value = contentDisposition("读书笔记.md", true);
    expect(value).toMatch(/^inline;/);
    expect(value).toContain("filename*=UTF-8''");
  });

  it("文件名里的换行与引号不会撑破响应头", () => {
    expect(contentDisposition('a"b\r\nc.txt')).not.toMatch(/[\r\n]/);
  });

  it("文本类内容内联时按纯文本回，避免下载或在站内执行脚本", () => {
    expect(inlineContentType("text/markdown", "笔记.md")).toBe("text/plain; charset=utf-8");
    expect(inlineContentType("text/html", "页面.html")).toBe("text/plain; charset=utf-8");
    expect(inlineContentType("application/octet-stream", "说明.txt")).toBe(
      "text/plain; charset=utf-8",
    );
    // SVG 也是 XML，能携带脚本，所以同样降成纯文本
    expect(inlineContentType("image/svg+xml", "图标.svg")).toBe("text/plain; charset=utf-8");
  });

  it("PDF 与位图图片保持原类型", () => {
    expect(inlineContentType("application/pdf", "手册.pdf")).toBe("application/pdf");
    expect(inlineContentType("image/png", "截图.png")).toBe("image/png");
    expect(isTextLikeContent("image/png", "截图.png")).toBe(false);
  });

  it("可执行与压缩包不算文本", () => {
    expect(isTextLikeContent("application/zip", "打包.zip")).toBe(false);
    expect(isTextLikeContent("application/octet-stream", "工具.exe")).toBe(false);
  });
});
