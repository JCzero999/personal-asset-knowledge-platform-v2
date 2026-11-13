import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDebouncer,
  createRequestTracker,
  nextActiveIndex,
  parsePreviewResponse,
  PREVIEW_DEBOUNCE_MS,
  resolvePreviewKey,
  shouldRequestPreview,
} from "../../src/lib/search-preview";

/**
 * 首页内联预览的纯逻辑（ADR-024 第 8 条）。
 * 定时器用假时钟，不渲染组件、不发真实请求。
 */

describe("shouldRequestPreview", () => {
  it("已登录、非组合输入、归一化后 ≥ 2 字才请求", () => {
    expect(shouldRequestPreview({ signedIn: true, composing: false, value: "复盘" })).toBe(true);
    expect(shouldRequestPreview({ signedIn: true, composing: false, value: "复" })).toBe(false);
    expect(shouldRequestPreview({ signedIn: true, composing: false, value: " 复 " })).toBe(false);
    expect(shouldRequestPreview({ signedIn: true, composing: false, value: "ＡＢ" })).toBe(true);
    expect(shouldRequestPreview({ signedIn: true, composing: true, value: "复盘" })).toBe(false);
    expect(shouldRequestPreview({ signedIn: false, composing: false, value: "复盘" })).toBe(false);
  });
});

describe("createDebouncer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("只执行最后一次，延迟 200ms", () => {
    const debouncer = createDebouncer(PREVIEW_DEBOUNCE_MS);
    const first = vi.fn();
    const second = vi.fn();

    debouncer.schedule(first);
    vi.advanceTimersByTime(150);
    debouncer.schedule(second);
    vi.advanceTimersByTime(150);

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("cancel 只清定时器，不触发任务", () => {
    const debouncer = createDebouncer(PREVIEW_DEBOUNCE_MS);
    const task = vi.fn();

    debouncer.schedule(task);
    debouncer.cancel();
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS * 2);

    expect(task).not.toHaveBeenCalled();
  });
});

describe("createRequestTracker", () => {
  it("丢弃过期响应", () => {
    const tracker = createRequestTracker();
    const older = tracker.next();
    const newer = tracker.next();

    expect(tracker.isCurrent(older)).toBe(false);
    expect(tracker.isCurrent(newer)).toBe(true);
  });
});

describe("resolvePreviewKey", () => {
  const base = { open: true, activeIndex: 0, count: 3, hasValue: true };

  it("↑↓ 在面板打开时移动选中项", () => {
    expect(resolvePreviewKey({ ...base, key: "ArrowDown" })).toBe("next");
    expect(resolvePreviewKey({ ...base, key: "ArrowUp" })).toBe("prev");
    expect(resolvePreviewKey({ ...base, key: "ArrowDown", count: 0 })).toBe("ignore");
  });

  it("回车：选中项时打开对象，否则进完整结果页", () => {
    expect(resolvePreviewKey({ ...base, key: "Enter" })).toBe("open");
    expect(resolvePreviewKey({ ...base, key: "Enter", activeIndex: -1 })).toBe("submit");
    expect(resolvePreviewKey({ ...base, key: "Enter", open: false })).toBe("submit");
    expect(resolvePreviewKey({ ...base, key: "Enter", count: 0 })).toBe("submit");
  });

  it("Esc：先关面板，已经关了才清空输入", () => {
    expect(resolvePreviewKey({ ...base, key: "Escape" })).toBe("close");
    expect(resolvePreviewKey({ ...base, key: "Escape", open: false })).toBe("clear");
    expect(resolvePreviewKey({ ...base, key: "Escape", open: false, hasValue: false })).toBe(
      "ignore",
    );
  });

  it("其它按键交给输入框自己处理", () => {
    expect(resolvePreviewKey({ ...base, key: "a" })).toBe("ignore");
  });
});

describe("nextActiveIndex", () => {
  it("从 -1 开始：↓ 落到首项、↑ 落到末项，并环形回绕", () => {
    expect(nextActiveIndex(-1, 3, 1)).toBe(0);
    expect(nextActiveIndex(-1, 3, -1)).toBe(2);
    expect(nextActiveIndex(2, 3, 1)).toBe(0);
    expect(nextActiveIndex(0, 3, -1)).toBe(2);
    expect(nextActiveIndex(0, 0, 1)).toBe(-1);
  });
});

describe("parsePreviewResponse", () => {
  const hit = {
    object: {
      id: "obj_1",
      title: "复盘模板",
      type: "work",
      library: "external",
      category: "course",
      tags: ["工具", "模板"],
    },
    content: "分类：课程 · 标签：工具",
    highlightTerms: ["复盘"],
    matchedFields: ["title", "tag"],
  };

  it("收敛为预览项，并读出总数与截断标记", () => {
    const data = parsePreviewResponse({
      hits: [hit],
      total: 12,
      lexical: { total: 12, truncated: true, hint: "结果较多" },
    });

    expect(data.items).toEqual([
      {
        id: "obj_1",
        title: "复盘模板",
        type: "work",
        library: "external",
        category: "course",
        tags: ["工具", "模板"],
        snippet: "分类：课程 · 标签：工具",
        highlightTerms: ["复盘"],
        matchedFields: ["title", "tag"],
      },
    ]);
    expect(data).toMatchObject({ total: 12, truncated: true, hint: "结果较多" });
  });

  it("坏数据只跳过单条，不整体崩溃", () => {
    const data = parsePreviewResponse({
      hits: [
        null,
        { object: null },
        { object: { id: "", title: "无 id" } },
        { object: { id: "obj_2", title: "正常", type: "unknown", library: "x" }, matchedFields: ["nope", 3] },
      ],
      lexical: { total: "bad" },
    });

    expect(data.items).toHaveLength(1);
    expect(data.items[0]).toMatchObject({ id: "obj_2", type: "asset", library: "internal" });
    expect(data.items[0].matchedFields).toEqual([]);
    expect(data.total).toBe(1);
    expect(data.truncated).toBe(false);
  });

  it("按 limit 截断，非 JSON 形状返回空预览", () => {
    const hits = Array.from({ length: 5 }, (_, index) => ({
      object: { id: `obj_${index}`, title: `对象 ${index}` },
    }));

    expect(parsePreviewResponse({ hits }, 3).items).toHaveLength(3);
    expect(parsePreviewResponse(null)).toEqual({
      items: [],
      total: 0,
      truncated: false,
      hint: null,
    });
  });
});
