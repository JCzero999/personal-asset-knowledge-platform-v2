"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

import {
  createDebouncer,
  createRequestTracker,
  nextActiveIndex,
  parsePreviewResponse,
  PREVIEW_DEBOUNCE_MS,
  PREVIEW_LIMIT,
  shouldRequestPreview,
  type PreviewItem,
  type PreviewStatus,
} from "@/lib/search-preview";

/**
 * 首页搜索框的内联预览状态机（ADR-024 第 8 条）。
 *
 * 约束都落在这里：≥ 2 字、200ms 防抖、IME 组合期间不发请求、
 * AbortController + 序号丢弃过期响应、只调 `mode=lexical`。
 * 纯决策在 `search-preview.ts`，组件只负责渲染与导航。
 *
 * 「面板是否打开」「是否在加载」都由当前输入推导，不在 effect 里同步
 * setState：清空或输入过短时面板立即收起，不必等一次额外渲染。
 */
export interface SearchPreview {
  value: string;
  setValue: (next: string) => void;
  open: boolean;
  status: PreviewStatus;
  items: PreviewItem[];
  total: number;
  truncated: boolean;
  hint: string | null;
  activeIndex: number;
  composing: boolean;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  onFocus: () => void;
  move: (delta: number) => void;
  close: () => void;
  reset: () => void;
}

const NO_ITEMS: PreviewItem[] = [];

export function useSearchPreview({
  signedIn,
  rootRef,
}: {
  signedIn: boolean;
  /** 搜索框外层容器；点击它之外的区域收起面板。 */
  rootRef: RefObject<HTMLElement | null>;
}): SearchPreview {
  const [value, setValueState] = useState("");
  const [status, setStatus] = useState<PreviewStatus>("idle");
  const [items, setItems] = useState<PreviewItem[]>(NO_ITEMS);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [composing, setComposing] = useState(false);
  /** 响应已经落到的检索词；与当前输入不一致时视为加载中。 */
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  /** 被 Esc / 点击外部收起的检索词；输入变化后自动重新展开。 */
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  const [debouncer] = useState(() => createDebouncer(PREVIEW_DEBOUNCE_MS));
  const [tracker] = useState(() => createRequestTracker());
  const abortRef = useRef<AbortController | null>(null);

  const key = value.trim();
  const requestable = shouldRequestPreview({ signedIn, composing, value });
  const settled = requestable && loadedKey === key;
  const open = requestable && dismissedKey !== key;
  const visibleItems = settled && status === "ready" ? items : NO_ITEMS;

  useEffect(() => {
    debouncer.cancel();

    if (!requestable) {
      abortRef.current?.abort();
      abortRef.current = null;
      return;
    }

    debouncer.schedule(() => {
      void (async () => {
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        const token = tracker.next();
        const params = new URLSearchParams({
          q: key,
          mode: "lexical",
          limit: String(PREVIEW_LIMIT),
        });

        try {
          const response = await fetch(`/api/search?${params.toString()}`, {
            signal: controller.signal,
            headers: { accept: "application/json" },
          });

          if (!response.ok) throw new Error(`search failed: ${response.status}`);

          const payload = await response.json();

          if (!tracker.isCurrent(token)) return;

          const data = parsePreviewResponse(payload);
          setItems(data.items);
          setTotal(data.total);
          setTruncated(data.truncated);
          setHint(data.hint);
          // 默认不选中：回车仍进完整结果页，↓ 才落到第一条。
          setActiveIndex(-1);
          setStatus(data.items.length > 0 ? "ready" : "empty");
          setLoadedKey(key);
        } catch {
          if (controller.signal.aborted || !tracker.isCurrent(token)) return;

          setItems(NO_ITEMS);
          setTotal(0);
          setTruncated(false);
          setHint(null);
          setActiveIndex(-1);
          setStatus("error");
          setLoadedKey(key);
        }
      })();
    });

    return () => debouncer.cancel();
  }, [key, requestable, debouncer, tracker]);

  // 卸载时取消定时器与在途请求，避免离开首页后仍写状态。
  useEffect(() => {
    const pending = debouncer;

    return () => {
      pending.cancel();
      abortRef.current?.abort();
    };
  }, [debouncer]);

  // 点击面板与输入框之外的区域关闭。
  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      const root = rootRef.current;
      if (root && event.target instanceof Node && !root.contains(event.target)) {
        setDismissedKey(key);
      }
    }

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, key, rootRef]);

  function setValue(next: string) {
    setValueState(next);
    if (!next) setActiveIndex(-1);
  }

  function move(delta: number) {
    setDismissedKey(null);
    setActiveIndex((current) => nextActiveIndex(current, visibleItems.length, delta));
  }

  function close() {
    setDismissedKey(key);
    setActiveIndex(-1);
  }

  function reset() {
    setValueState("");
    setDismissedKey(null);
    setActiveIndex(-1);
    setStatus("idle");
    setItems(NO_ITEMS);
    setTotal(0);
    setTruncated(false);
    setHint(null);
    setLoadedKey(null);
  }

  return {
    value,
    setValue,
    open,
    status: requestable ? (settled ? status : "loading") : "idle",
    items: visibleItems,
    total: settled ? total : 0,
    truncated: settled ? truncated : false,
    hint: settled ? hint : null,
    activeIndex,
    composing,
    onCompositionStart: () => setComposing(true),
    onCompositionEnd: () => setComposing(false),
    onFocus: () => {
      if (visibleItems.length > 0) setDismissedKey(null);
    },
    move,
    close,
    reset,
  };
}
