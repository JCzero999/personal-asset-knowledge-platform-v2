import { describe, expect, it } from "vitest";

import {
  isMarkdownContent,
  parseInline,
  parseMarkdown,
  safeHref,
} from "../../src/lib/markdown";

describe("safeHref", () => {
  it("只放行 http(s)、mailto、站内路径与锚点", () => {
    expect(safeHref("https://example.com/a")).toBe("https://example.com/a");
    expect(safeHref("/workspace")).toBe("/workspace");
    expect(safeHref("#recent")).toBe("#recent");
    expect(safeHref("mailto:a@b.com")).toBe("mailto:a@b.com");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,hi")).toBeNull();
    expect(safeHref("")).toBeNull();
  });
});

describe("parseInline", () => {
  it("解析粗体、行内代码与安全链接，脚本链接退化为文本", () => {
    expect(parseInline("**重点** 和 `code`")).toEqual([
      { kind: "strong", children: [{ kind: "text", text: "重点" }] },
      { kind: "text", text: " 和 " },
      { kind: "code", text: "code" },
    ]);

    expect(parseInline("[工作台](/workspace)")).toEqual([
      {
        kind: "link",
        href: "/workspace",
        children: [{ kind: "text", text: "工作台" }],
      },
    ]);

    expect(parseInline("[点我](javascript:alert(1))")).toEqual([
      { kind: "text", text: "[点我](javascript:alert(1))" },
    ]);
  });

  it("未闭合的标记按普通文本保留", () => {
    expect(parseInline("**没有闭合")).toEqual([{ kind: "text", text: "**没有闭合" }]);
  });
});

describe("parseMarkdown", () => {
  it("拆分标题、列表、引用、代码块与分隔线", () => {
    const blocks = parseMarkdown(
      [
        "# 标题",
        "",
        "第一段",
        "续行",
        "",
        "- 一",
        "- 二",
        "",
        "1. 甲",
        "2. 乙",
        "",
        "> 引用",
        "",
        "```ts",
        "const a = 1;",
        "```",
        "",
        "---",
      ].join("\n"),
    );

    expect(blocks[0]).toMatchObject({ kind: "heading", level: 1 });
    expect(blocks[1]).toMatchObject({ kind: "paragraph" });
    expect(blocks[2]).toMatchObject({ kind: "list", ordered: false });
    expect(blocks[3]).toMatchObject({ kind: "list", ordered: true });
    expect(blocks[4]).toMatchObject({ kind: "quote" });
    expect(blocks[5]).toEqual({
      kind: "code",
      lang: "ts",
      code: "const a = 1;",
    });
    expect(blocks[6]).toEqual({ kind: "hr" });
  });
});

describe("isMarkdownContent", () => {
  it("按 MIME 与扩展名判断，其他纯文本不算 Markdown", () => {
    expect(isMarkdownContent({ mime: "text/markdown", documentName: "a.txt" })).toBe(true);
    expect(isMarkdownContent({ mime: null, documentName: "笔记.MD" })).toBe(true);
    expect(isMarkdownContent({ mime: "text/plain", documentName: "a.txt" })).toBe(false);
    expect(isMarkdownContent(null)).toBe(false);
  });
});
