import type { SearchField } from "./search-query";
import { normalizeSearchText } from "./search-query";

/**
 * 首页内联预览的纯逻辑（ADR-024 第 8 条）。
 *
 * Hook 负责定时器、AbortController 与 React 状态；「什么时候该发请求」
 * 「按键该做什么」「响应怎么收敛」这些可断言的部分留在这里，测试不需要
 * 渲染组件，也不引入新依赖。
 */

export const PREVIEW_MIN_LENGTH = 2;
export const PREVIEW_DEBOUNCE_MS = 200;
export const PREVIEW_LIMIT = 8;

export type PreviewStatus = "idle" | "loading" | "ready" | "empty" | "error";

export interface PreviewItem {
  id: string;
  title: string;
  type: "asset" | "work";
  library: "internal" | "external";
  category: string | null;
  tags: string[];
  /** 摘要原文；高亮由 `buildHighlightSnippet` 在渲染时生成。 */
  snippet: string;
  highlightTerms: string[];
  matchedFields: SearchField[];
}

export interface PreviewData {
  items: PreviewItem[];
  /** 词法命中总数（可能大于返回条数）。 */
  total: number;
  truncated: boolean;
  hint: string | null;
}

/** 是否达到发请求的门槛：已登录、非输入法组合中、归一化后 ≥ 2 字。 */
export function shouldRequestPreview(input: {
  signedIn: boolean;
  composing: boolean;
  value: string;
}): boolean {
  if (!input.signedIn || input.composing) return false;

  return [...normalizeSearchText(input.value)].length >= PREVIEW_MIN_LENGTH;
}

export interface RequestTracker {
  /** 取一个新的序号；只有序号仍是最新的响应才允许落状态。 */
  next(): number;
  isCurrent(token: number): boolean;
}

export function createRequestTracker(): RequestTracker {
  let latest = 0;

  return {
    next() {
      latest += 1;
      return latest;
    },
    isCurrent(token: number) {
      return token === latest;
    },
  };
}

export interface Debouncer {
  schedule(task: () => void): void;
  cancel(): void;
}

/** 可取消的防抖器；`cancel` 只清定时器，不会触发任务。 */
export function createDebouncer(delayMs: number): Debouncer {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    schedule(task: () => void) {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        task();
      }, delayMs);
    },
    cancel,
  };
}

export type PreviewKeyIntent =
  | "next"
  | "prev"
  | "open"
  | "submit"
  | "close"
  | "clear"
  | "ignore";

/**
 * 键盘语义：↑↓ 选择、Enter 打开选中项（无选中则进结果页）、
 * Esc 先关面板再清空。组合输入由调用方先行拦截。
 */
export function resolvePreviewKey(input: {
  key: string;
  open: boolean;
  activeIndex: number;
  count: number;
  hasValue: boolean;
}): PreviewKeyIntent {
  switch (input.key) {
    case "ArrowDown":
      return input.count > 0 ? "next" : "ignore";
    case "ArrowUp":
      return input.count > 0 ? "prev" : "ignore";
    case "Enter":
      return input.open && input.count > 0 && input.activeIndex >= 0 ? "open" : "submit";
    case "Escape":
      if (input.open) return "close";

      return input.hasValue ? "clear" : "ignore";
    default:
      return "ignore";
  }
}

/** 环形移动选中项；从 -1 开始，第一次 ↓ 落到 0，第一次 ↑ 落到末尾。 */
export function nextActiveIndex(current: number, count: number, delta: number): number {
  if (count <= 0) return -1;

  if (current < 0) return delta > 0 ? 0 : count - 1;

  return (current + delta + count) % count;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asFields(value: unknown): SearchField[] {
  if (!Array.isArray(value)) return [];

  const allowed: SearchField[] = ["title", "description", "category", "tag"];

  return value.filter((item): item is SearchField =>
    allowed.includes(item as SearchField),
  );
}

/**
 * 把 `/api/search?mode=lexical` 的响应收敛成预览项。
 *
 * 服务端永远返回结构化的 `hits`；这里仍然逐字段校验，坏数据只跳过单条，
 * 不让首页下拉因为一条脏数据整体崩掉。
 */
export function parsePreviewResponse(payload: unknown, limit = PREVIEW_LIMIT): PreviewData {
  const root = (payload ?? {}) as Record<string, unknown>;
  const rawHits = Array.isArray(root.hits) ? root.hits : [];
  const items: PreviewItem[] = [];

  for (const raw of rawHits) {
    if (items.length >= limit) break;

    const hit = (raw ?? {}) as Record<string, unknown>;
    const object = (hit.object ?? {}) as Record<string, unknown>;
    const id = asString(object.id);
    const title = asString(object.title);

    if (!id || !title) continue;

    const type = object.type === "work" ? "work" : "asset";
    const library = object.library === "external" ? "external" : "internal";
    const category = typeof object.category === "string" ? object.category : null;
    const tags = Array.isArray(object.tags)
      ? object.tags.filter((tag): tag is string => typeof tag === "string")
      : [];

    items.push({
      id,
      title,
      type,
      library,
      category,
      tags,
      snippet: asString(hit.content),
      highlightTerms: Array.isArray(hit.highlightTerms)
        ? hit.highlightTerms.filter((term): term is string => typeof term === "string")
        : [],
      matchedFields: asFields(hit.matchedFields),
    });
  }

  const lexical = (root.lexical ?? {}) as Record<string, unknown>;
  const total = typeof lexical.total === "number" ? lexical.total : items.length;

  return {
    items,
    total,
    truncated: lexical.truncated === true,
    hint: typeof lexical.hint === "string" ? lexical.hint : null,
  };
}
