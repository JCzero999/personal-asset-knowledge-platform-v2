"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

/**
 * 列表 / 详情之间的拖拽分隔条。
 *
 * 拖动时只把宽度写进 `.app-frame` 的 `--list-width` 变量，两列由 grid 自适应，
 * 整个过程不触发 React 渲染；松手与键盘调整时才落一次 localStorage。
 * 宽度范围 300–560px，超出上下限就夹住；<1100px 时由 CSS 隐藏（单列/互斥布局）。
 */

const MIN_WIDTH = 300;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 340;
const KEYBOARD_STEP = 16;
const STORAGE_KEY = "pakp.workspace.list-width";

function clamp(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));
}

/** 当前列表列宽：优先读 CSS 变量（拖动后即时值），退回到实际盒子宽度。 */
function readWidth(frame: HTMLElement): number {
  const raw = getComputedStyle(frame).getPropertyValue("--list-width").trim();
  const parsed = Number.parseFloat(raw);
  if (Number.isFinite(parsed) && parsed > 0) return clamp(parsed);

  const list = frame.querySelector<HTMLElement>(".record-list");
  return list ? clamp(list.getBoundingClientRect().width) : DEFAULT_WIDTH;
}

function readStored(): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? clamp(parsed) : null;
  } catch {
    // 隐私模式 / 被禁用的存储：不记忆宽度，拖动照常可用。
    return null;
  }
}

function persist(width: number) {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(clamp(width)));
  } catch {
    // 同上：存不下就只影响「刷新后保留」。
  }
}

export function ListResizer() {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const apply = useCallback((width: number) => {
    const node = ref.current;
    const frame = node?.parentElement;
    if (!node || !frame) return;
    const next = clamp(width);
    frame.style.setProperty("--list-width", `${next}px`);
    // 屏幕阅读器不读 CSS 变量，同步一次当前值。
    node.setAttribute("aria-valuenow", String(next));
  }, []);

  // 首帧就把记忆的宽度写回去，避免先按默认 340 排一次再跳。
  useLayoutEffect(() => {
    const frame = ref.current?.parentElement;
    if (!frame) return;

    const stored = readStored();
    if (stored !== null) apply(stored);
    ref.current?.setAttribute("aria-valuenow", String(stored ?? readWidth(frame)));
  }, [apply]);

  useEffect(() => {
    if (!dragging) return;
    // 拖动期间锁掉文本选择，避免速度一快就选中列表里的标题。
    const previous = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.userSelect = previous;
    };
  }, [dragging]);

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    const frame = event.currentTarget.parentElement;
    if (!frame || event.button !== 0) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: readWidth(frame) };
    setDragging(true);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state) return;
    apply(state.startWidth + (event.clientX - state.startX));
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const frame = event.currentTarget.parentElement;
    if (frame) persist(readWidth(frame));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const frame = event.currentTarget.parentElement;
    if (!frame) return;

    const current = readWidth(frame);
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = current - KEYBOARD_STEP;
    else if (event.key === "ArrowRight") next = current + KEYBOARD_STEP;
    else if (event.key === "Home") next = MIN_WIDTH;
    else if (event.key === "End") next = MAX_WIDTH;
    if (next === null) return;

    event.preventDefault();
    apply(next);
    persist(next);
  }

  function handleDoubleClick() {
    apply(DEFAULT_WIDTH);
    persist(DEFAULT_WIDTH);
  }

  return (
    <div
      ref={ref}
      className={`list-resizer${dragging ? " is-dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="调整列表与详情的宽度"
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={MAX_WIDTH}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
    >
      <span className="list-resizer-grip" aria-hidden="true" />
    </div>
  );
}
