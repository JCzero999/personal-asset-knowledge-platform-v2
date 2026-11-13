import { describe, expect, it } from "vitest";

import {
  buildSearchHref,
  DEFAULT_SEARCH_THRESHOLD,
  parseSearchParams,
  thresholdOptionsFor,
} from "@/lib/search-params";

describe("parseSearchParams", () => {
  it("空参数得到未检索状态", () => {
    const state = parseSearchParams({});
    expect(state).toEqual({
      q: "",
      library: null,
      threshold: DEFAULT_SEARCH_THRESHOLD,
      mode: "hybrid",
      error: null,
    });
  });

  it("去掉检索词首尾空格并解析库别与阈值", () => {
    const state = parseSearchParams({
      q: "  内容复盘  ",
      library: "internal",
      threshold: "0.35",
    });

    expect(state).toEqual({
      q: "内容复盘",
      library: "internal",
      threshold: 0.35,
      mode: "hybrid",
      error: null,
    });
  });

  it("非法库别给出明确错误", () => {
    const state = parseSearchParams({ q: "复盘", library: "cloud" });
    expect(state.library).toBeNull();
    expect(state.error).toContain("库别参数无效");
  });

  it("非法阈值给出明确错误并保留默认阈值", () => {
    for (const threshold of ["1.5", "-0.1", "abc"]) {
      const state = parseSearchParams({ q: "复盘", threshold });
      expect(state.threshold).toBe(DEFAULT_SEARCH_THRESHOLD);
      expect(state.error).toContain("0 到 1");
    }
  });

  it("检索词超过 200 字时给出错误", () => {
    const state = parseSearchParams({ q: "长".repeat(201) });
    expect(state.error).toContain("不能超过 200");
  });

  it("重复参数取第一个", () => {
    expect(parseSearchParams({ q: ["设计", "写作"] }).q).toBe("设计");
    expect(parseSearchParams({ library: ["external", "internal"] }).library).toBe("external");
  });

  it("解析检索模式，默认 hybrid", () => {
    expect(parseSearchParams({ q: "复盘" }).mode).toBe("hybrid");
    expect(parseSearchParams({ q: "复盘", mode: "lexical" }).mode).toBe("lexical");
    expect(parseSearchParams({ q: "复盘", mode: "semantic" }).mode).toBe("semantic");
  });

  it("非法检索模式给出错误并回落到默认值", () => {
    const state = parseSearchParams({ q: "复盘", mode: "fuzzy" });
    expect(state.mode).toBe("hybrid");
    expect(state.error).toContain("hybrid / lexical / semantic");
  });
});

describe("buildSearchHref", () => {
  it("空检索与默认阈值不写进 URL", () => {
    expect(buildSearchHref({ q: "" })).toBe("/search");
    expect(buildSearchHref({ q: "复盘", threshold: DEFAULT_SEARCH_THRESHOLD })).toBe(
      "/search?q=%E5%A4%8D%E7%9B%98",
    );
  });

  it("按固定顺序拼接检索词、库别与非默认阈值", () => {
    expect(
      buildSearchHref({ q: " 复盘 ", library: "external", threshold: 0.5 }),
    ).toBe(
      "/search?q=%E5%A4%8D%E7%9B%98&library=external&threshold=0.5",
    );
  });

  it("只选库别也能生成干净地址", () => {
    expect(buildSearchHref({ q: "", library: "internal" })).toBe(
      "/search?library=internal",
    );
  });

  it("非默认检索模式写进 URL，默认值省略", () => {
    expect(buildSearchHref({ q: "复盘", mode: "lexical" })).toBe(
      "/search?q=%E5%A4%8D%E7%9B%98&mode=lexical",
    );
    expect(buildSearchHref({ q: "复盘", mode: "hybrid" })).toBe(
      "/search?q=%E5%A4%8D%E7%9B%98",
    );
  });

  it("生成地址可被解析回同样的状态", () => {
    const href = buildSearchHref({ q: "知识 管理", library: "internal", threshold: 0.1 });
    const search = new URLSearchParams(href.split("?")[1]);
    const state = parseSearchParams(Object.fromEntries(search.entries()));

    expect(state).toEqual({
      q: "知识 管理",
      library: "internal",
      threshold: 0.1,
      mode: "hybrid",
      error: null,
    });
  });
});

describe("thresholdOptionsFor", () => {
  it("常用阈值直接返回预设选项", () => {
    expect(thresholdOptionsFor(0.35).some((option) => option.value === 0.35)).toBe(true);
  });

  it("手改 URL 的自定义阈值补进选项，避免下拉框空白", () => {
    const options = thresholdOptionsFor(0.13);
    expect(options[options.length - 1]).toEqual({ value: 0.13, label: "自定义 · 0.13" });
  });
});
