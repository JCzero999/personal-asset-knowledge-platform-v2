import { describe, expect, it } from "vitest";

import {
  compareSearchRank,
  LEXICAL_SCORES,
  matchLexicalObject,
  meetsSearchLength,
  normalizeSearchText,
  parseSearchInput,
  SearchSyntaxError,
  type LexicalCandidateText,
  type SearchTerm,
} from "../../src/lib/search-query";

/**
 * 纯函数层单测（ADR-024 第 3、4 条）：归一化、语法、长度门槛、六级评分、排序。
 * 这里不碰数据库，SQL 侧的过滤另在 lexical-search.test.ts 断言。
 */

function terms(query: string): SearchTerm[] {
  return parseSearchInput(query).terms;
}

function candidate(overrides: Partial<LexicalCandidateText> = {}): LexicalCandidateText {
  return {
    title: "随手记",
    description: null,
    categoryLabel: null,
    tagLabels: [],
    ...overrides,
  };
}

describe("normalizeSearchText", () => {
  it("全角转半角、统一小写、压缩空白", () => {
    expect(normalizeSearchText("  ＡＢＣ　 复盘 ")).toBe("abc 复盘");
    expect(normalizeSearchText("知识\t\n系统")).toBe("知识 系统");
    expect(normalizeSearchText("")).toBe("");
  });
});

describe("parseSearchInput", () => {
  it("空格即 AND，AND 关键字等价", () => {
    const spaced = parseSearchInput("知识 系统");
    expect(spaced.positive.map((term) => term.value)).toEqual(["知识", "系统"]);
    expect(spaced.positive.every((term) => term.field === null)).toBe(true);

    const explicit = parseSearchInput("知识 AND 系统");
    expect(explicit.positive.map((term) => term.value)).toEqual(["知识", "系统"]);
  });

  it("引号短语保留空格，并标记 phrase", () => {
    const parsed = parseSearchInput('"个人 知识" 系统');
    expect(parsed.positive[0]).toMatchObject({
      value: "个人 知识",
      phrase: true,
      position: 0,
    });
    expect(parsed.positive[1]).toMatchObject({ value: "系统", phrase: false });
  });

  it("字段前缀中英文都认，值归一化", () => {
    const parsed = parseSearchInput("title:ABC 标题:知识 desc:描述 描述:说明 category:课程 分类:文章 tag:工具 标签:模板");

    expect(parsed.terms.map((term) => [term.field, term.value])).toEqual([
      ["title", "abc"],
      ["title", "知识"],
      ["description", "描述"],
      ["description", "说明"],
      ["category", "课程"],
      ["category", "文章"],
      ["tag", "工具"],
      ["tag", "模板"],
    ]);
  });

  it("前缀加引号按短语处理", () => {
    const parsed = parseSearchInput('title:"个人 知识系统"');
    expect(parsed.positive[0]).toMatchObject({
      field: "title",
      value: "个人 知识系统",
      phrase: true,
    });
  });

  it("未知前缀与 URL 按普通文本处理", () => {
    expect(parseSearchInput("http://example.com").positive[0]).toMatchObject({
      field: null,
      value: "http://example.com",
    });
    expect(parseSearchInput("author:张三").positive[0]).toMatchObject({
      field: null,
      value: "author:张三",
    });
  });

  it("排除支持 - 与 NOT，且可带字段", () => {
    const dashed = parseSearchInput("知识 -草稿 -tag:工具");
    expect(dashed.positive.map((term) => term.value)).toEqual(["知识"]);
    expect(dashed.negative.map((term) => [term.field, term.value])).toEqual([
      [null, "草稿"],
      ["tag", "工具"],
    ]);

    const notted = parseSearchInput("知识 NOT 草稿");
    expect(notted.negative.map((term) => term.value)).toEqual(["草稿"]);
  });

  it("~ 按普通字符处理，并给一次提示", () => {
    const parsed = parseSearchInput("复盘~模板");
    expect(parsed.positive[0].value).toBe("复盘~模板");
    expect(parsed.hint).toContain("普通字符");
  });

  it("拒绝 OR 并给出位置", () => {
    const error = (() => {
      try {
        parseSearchInput("复盘 OR 写作");
        return null;
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(SearchSyntaxError);
    expect((error as SearchSyntaxError).position).toBe(3);
    expect((error as SearchSyntaxError).message).toContain("OR");
  });

  it("拒绝括号并给出位置", () => {
    expect(() => parseSearchInput("复盘 (写作)")).toThrowError(SearchSyntaxError);
    expect(() => parseSearchInput("复盘 (写作)")).toThrowError(/位置|括号/);
    expect(catchPosition("复盘 (写作)")).toBe(3);
  });

  it("未闭合引号在开引号处报错", () => {
    expect(catchPosition('复盘 "未闭合')).toBe(3);
    expect(catchPosition('title:"未闭合')).toBe(6);
  });

  it("拒绝空串、孤立负号、连写负号与空字段值", () => {
    expect(catchPosition("   ")).toBe(0);
    expect(catchPosition("复盘 -")).toBe(3);
    expect(catchPosition("复盘 --草稿")).toBe(4);
    expect(catchPosition("title:复盘")).toBe(-1); // 合法
    expect(() => parseSearchInput("title:")).toThrowError(/缺少检索词/);
  });

  it("限制检索词数量", () => {
    expect(() => parseSearchInput(Array.from({ length: 31 }, (_, i) => `词${i}`).join(" "))).toThrowError(
      /最多 30 个/,
    );
  });
});

/** 解析失败时返回错误位置；不报错返回 -1。 */
function catchPosition(query: string): number {
  try {
    parseSearchInput(query);
    return -1;
  } catch (error) {
    if (error instanceof SearchSyntaxError) return error.position;
    throw error;
  }
}

describe("meetsSearchLength", () => {
  it("按归一化后的字符数判断 2 字门槛", () => {
    expect(meetsSearchLength(parseSearchInput("复"))).toBe(false);
    expect(meetsSearchLength(parseSearchInput(" 复 "))).toBe(false);
    expect(meetsSearchLength(parseSearchInput("复盘"))).toBe(true);
    expect(meetsSearchLength(parseSearchInput("ab"))).toBe(true);
    expect(meetsSearchLength(parseSearchInput("😀😀"))).toBe(true);
  });
});

describe("matchLexicalObject", () => {
  it("标题完全相等为最高档（仅单词裸查询）", () => {
    expect(matchLexicalObject(candidate({ title: "复盘" }), terms("复盘"))).toMatchObject({
      score: LEXICAL_SCORES.titleExact,
      matchedFields: ["title"],
    });

    // 短语与多词查询不享受 T1。
    expect(matchLexicalObject(candidate({ title: "复盘" }), terms('"复盘"'))?.score).toBe(
      LEXICAL_SCORES.titleContains + LEXICAL_SCORES.titlePrefixBonus,
    );
    expect(
      matchLexicalObject(candidate({ title: "复盘" }), terms("复盘 模板"))?.score,
    ).toBeUndefined();
  });

  it("标题前缀比包含高 10 分", () => {
    expect(matchLexicalObject(candidate({ title: "复盘模板" }), terms("复盘"))?.score).toBe(90);
    expect(matchLexicalObject(candidate({ title: "如何复盘" }), terms("复盘"))?.score).toBe(80);
  });

  it("分类 / 标签 / 描述按层级给分", () => {
    expect(
      matchLexicalObject(candidate({ categoryLabel: "课程" }), terms("课程"))?.score,
    ).toBe(LEXICAL_SCORES.categoryExact);
    expect(
      matchLexicalObject(candidate({ tagLabels: ["工具"] }), terms("工具"))?.score,
    ).toBe(LEXICAL_SCORES.tagExact);
    expect(
      matchLexicalObject(candidate({ categoryLabel: "课程复盘" }), terms("复盘"))?.score,
    ).toBe(LEXICAL_SCORES.categoryOrTagContains);
    expect(
      matchLexicalObject(candidate({ description: "关于复盘" }), terms("复盘"))?.score,
    ).toBe(LEXICAL_SCORES.descriptionContains);
  });

  it("同一对象多条证据取最高档，matchedFields 取并集", () => {
    const match = matchLexicalObject(
      candidate({ title: "复盘模板", description: "复盘笔记", tagLabels: ["复盘"] }),
      terms("复盘"),
    );

    expect(match?.score).toBe(90);
    expect(match?.matchedFields).toEqual(["title", "description", "tag"]);
  });

  it("任一正词落空即不匹配", () => {
    expect(matchLexicalObject(candidate({ title: "知识" }), terms("知识 系统"))).toBeNull();
  });

  it("排除词命中即不匹配，字段限定只作用于该字段", () => {
    expect(matchLexicalObject(candidate({ title: "知识草稿" }), terms("知识 -草稿"))).toBeNull();
    expect(
      matchLexicalObject(candidate({ title: "知识", description: "草稿" }), terms("知识 -title:草稿")),
    ).not.toBeNull();
    expect(
      matchLexicalObject(candidate({ title: "知识", description: "草稿" }), terms("知识 -草稿")),
    ).toBeNull();
  });

  it("字段前缀把命中限死在对应字段", () => {
    expect(matchLexicalObject(candidate({ description: "知识" }), terms("title:知识"))).toBeNull();
    expect(
      matchLexicalObject(candidate({ tagLabels: ["知识"] }), terms("标签:知识"))?.matchedFields,
    ).toEqual(["tag"]);
  });

  it("高亮词去重并按长度倒序", () => {
    const match = matchLexicalObject(
      candidate({ title: "知识 管理 系统" }),
      terms("系统 知识 管理"),
    );

    expect(match?.highlightTerms).toEqual(["系统", "知识", "管理"]);
  });
});

describe("compareSearchRank", () => {
  it("分数 → 更新时间 → id", () => {
    const rows = [
      { id: "b", score: 80, updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "c", score: 100, updatedAt: "2025-01-01T00:00:00.000Z" },
      { id: "a", score: 80, updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "d", score: 80, updatedAt: "2026-02-01T00:00:00.000Z" },
    ];

    expect(rows.sort(compareSearchRank).map((row) => row.id)).toEqual(["c", "d", "a", "b"]);
  });
});
