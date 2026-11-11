import { describe, expect, it } from "vitest";

import { buildHighlightSnippet, decodeHtmlEntities } from "@/lib/search-highlight";

/**
 * 检索摘要来自 RAGFlow 的 HTML 字符串，页面只按片段渲染成纯文本与 `<mark>`。
 * 这组用例守住两件事：标签不会漏进页面，重点标记只来自受控规则。
 */

describe("buildHighlightSnippet 清洗", () => {
  it("保留强调标签的语义，其余标签全部剥离", () => {
    const snippet = buildHighlightSnippet(
      '<p>先看<em>知识管理</em>，再看<a href="/x" onclick="alert(1)">原文</a></p>',
      "",
      "",
    );

    expect(snippet.segments).toEqual([
      { text: "先看", strong: false },
      { text: "知识管理", strong: true },
      { text: "，再看原文", strong: false },
    ]);
    expect(snippet.text).toBe("先看知识管理，再看原文");
  });

  it("丢弃脚本、样式与事件属性所在的标签，不把 HTML 交给浏览器", () => {
    const snippet = buildHighlightSnippet(
      '<script>alert(1)</script><style>.x{color:red}</style><img src=x onerror="alert(2)">正文',
      "",
      "",
    );

    expect(snippet.text).toBe("正文");
    expect(snippet.text).not.toContain("<");
    expect(snippet.text).not.toContain("alert");
  });

  it("块级标签折叠成单个空格，不把两段粘在一起", () => {
    const snippet = buildHighlightSnippet(
      "<p>第一段</p><p>第二段</p><br>第三段",
      "",
      "",
    );

    expect(snippet.text).toBe("第一段 第二段 第三段");
  });

  it("解码常见实体与数字实体，实体内容仍按纯文本处理", () => {
    const snippet = buildHighlightSnippet(
      "A &amp; B &lt;tag&gt; &#20320;&#x597D;",
      "",
      "",
    );

    expect(snippet.text).toBe("A & B <tag> 你好");
  });

  it("highlight 为空时退回原文，两者都空时返回空片段", () => {
    expect(buildHighlightSnippet("  ", "原文内容", "原文").text).toBe("原文内容");
    expect(buildHighlightSnippet("", "", "")).toEqual({ segments: [], text: "" });
  });

  it("highlight 有内容时优先使用 highlight", () => {
    expect(buildHighlightSnippet("高亮内容", "原文内容", "").text).toBe("高亮内容");
  });

  it("未闭合的强调标签不会丢失后面的文字", () => {
    const snippet = buildHighlightSnippet("<em>没有闭合", "", "");
    expect(snippet.segments).toEqual([{ text: "没有闭合", strong: true }]);
  });
});

describe("buildHighlightSnippet 检索词标记", () => {
  it("非强调片段里的检索词大小写不敏感地加粗", () => {
    const snippet = buildHighlightSnippet(null, "RAGFlow 的部署记录", "ragflow");
    expect(snippet.segments).toEqual([
      { text: "RAGFlow", strong: true },
      { text: " 的部署记录", strong: false },
    ]);
  });

  it("多词检索按空白切分，长词优先且不重复标记", () => {
    const snippet = buildHighlightSnippet(null, "如何做内容复盘与内容归档", "内容 复盘 内容");
    const strongText = snippet.segments
      .filter((segment) => segment.strong)
      .map((segment) => segment.text);

    expect(strongText).toEqual(["内容复盘", "内容"]);
  });

  it("检索词里的正则特殊字符按字面量匹配", () => {
    const snippet = buildHighlightSnippet(null, "1+1=2（草稿）", "1+1");
    expect(snippet.segments).toEqual([
      { text: "1+1", strong: true },
      { text: "=2（草稿）", strong: false },
    ]);
  });

  it("已有强调片段不会被重复拆分", () => {
    const snippet = buildHighlightSnippet("<em>知识管理</em>的方法", "", "知识");
    expect(snippet.segments).toEqual([
      { text: "知识管理", strong: true },
      { text: "的方法", strong: false },
    ]);
  });
});

describe("buildHighlightSnippet 截断", () => {
  it("长文本从首个命中词附近截取，并补省略号", () => {
    const text = `${"前".repeat(200)}关键词${"后".repeat(200)}`;
    const snippet = buildHighlightSnippet(null, text, "关键词", 100);

    expect(snippet.text.startsWith("…")).toBe(true);
    expect(snippet.text.endsWith("…")).toBe(true);
    expect(snippet.text).toContain("关键词");
    expect(snippet.segments.some((segment) => segment.strong)).toBe(true);
    expect(snippet.text.length).toBeLessThanOrEqual(102);
  });

  it("短文本不截断也不补省略号", () => {
    const snippet = buildHighlightSnippet(null, "很短的内容", "内容", 100);
    expect(snippet.text).toBe("很短的内容");
  });
});

describe("decodeHtmlEntities", () => {
  it("解码命名、十进制与十六进制实体", () => {
    expect(decodeHtmlEntities("&amp;&lt;&gt;&quot;&apos;&nbsp;")).toBe("&<>\"' ");
    expect(decodeHtmlEntities("&#20320;&#x597D;")).toBe("你好");
  });

  it("未知实体与越界码点原样保留或忽略", () => {
    expect(decodeHtmlEntities("&unknown;")).toBe("&unknown;");
    expect(decodeHtmlEntities("&#x110000;")).toBe("");
  });
});
