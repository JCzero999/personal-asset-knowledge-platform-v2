"use client";

/**
 * 2D 聚焦阅读舞台（ADR-022 A8 / 设计稿 §5.2、§6）。
 *
 * 只消费 `GraphViewModel` + `GraphHighlight`：类型 / 形状 / 颜色 / 度数 / 邻域 / 路径
 * 全部来自冻结件，组件里不出现类型名、色值、形状映射，也不自己做 BFS。
 *
 * 交互：单击选中、双击聚焦、拖动平移、滚轮 / 双指缩放、Shift+单击选路径终点；
 * 键盘：Tab 进入画布，方向键在节点间空间移动，Enter 选中，F / Space 聚焦，
 * Esc 取消选中，+ / − 缩放，0 适配。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ENTITY_STYLE, type GraphNode, type GraphViewModel } from "@/lib/graph-model";
import {
  anchorsForSize,
  layoutForce2d,
  layoutTicksForNodeCount,
  placeLabels,
  type Layout2DResult,
} from "@/lib/graph-layout-2d";
import type { GraphHighlight } from "@/lib/graph-selectors";

export interface GraphStage2DProps {
  readonly view: GraphViewModel;
  readonly highlight: GraphHighlight;
  readonly selectedId: string | null;
  readonly focusId: string | null;
  readonly onSelect: (id: string | null, options?: { shiftKey?: boolean }) => void;
  readonly onFocus: (id: string) => void;
  readonly onHover?: (id: string | null) => void;
}

interface Size {
  width: number;
  height: number;
}

interface Camera {
  scale: number;
  x: number;
  y: number;
}

const MIN_SCALE = 0.4;
const MAX_SCALE = 2.4;
const DEFAULT_CAMERA: Camera = { scale: 1, x: 0, y: 0 };

/** 尚未量到画布尺寸时的空布局：首帧不出图，等 ResizeObserver 报出真实宽度再排。 */
const EMPTY_LAYOUT: Layout2DResult = {
  nodes: [],
  indexById: new Map(),
  ticks: 0,
  truncated: false,
  bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
};

export function GraphStage2D({
  view,
  highlight,
  selectedId,
  focusId,
  onSelect,
  onFocus,
  onHover,
}: GraphStage2DProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const anchorsRef = useRef<Record<string, readonly [number, number]>>({});
  // null = 还没量到尺寸。首帧不按 760 的兜底宽度布局，否则窄屏下所有锚点会被夹到边界（阻断项 1）。
  const [size, setSize] = useState<Size | null>(null);
  const sizeRef = useRef<Size | null>(null);
  const [cameraState, setCameraState] = useState<{ key: string | null; camera: Camera }>({
    key: focusId,
    camera: DEFAULT_CAMERA,
  });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const dragRef = useRef<{ x: number; y: number; camX: number; camY: number } | null>(null);
  const pinchRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchDistanceRef = useRef<number | null>(null);
  const nodeRefs = useRef<Map<string, SVGGElement | null>>(new Map());

  // 换中心（新的邻域已加载）后回到默认取景：缩放与平移不再指向旧位置的节点。
  // 相机与中心一起存，中心变了就按默认值读，避免在 effect 里回写 state。
  const camera = cameraState.key === focusId ? cameraState.camera : DEFAULT_CAMERA;
  const setCamera = useCallback(
    (patch: Camera | ((current: Camera) => Camera)) => {
      setCameraState((state) => {
        const current = state.key === focusId ? state.camera : DEFAULT_CAMERA;
        return { key: focusId, camera: typeof patch === "function" ? patch(current) : patch };
      });
    },
    [focusId],
  );

  // 尺寸按 32px 分档：ResizeObserver 抖动不会导致每次 1px 都重排。
  useEffect(() => {
    const element = wrapperRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      const width = Math.max(240, Math.round(rect.width / 32) * 32);
      const height = Math.max(240, Math.round(rect.height / 32) * 32);
      const current = sizeRef.current;
      if (current && current.width === width && current.height === height) return;
      // 换档后旧锚点没有意义：继续钉住会把全部节点夹在新画布的边界上。
      anchorsRef.current = anchorsForSize(anchorsRef.current, current, { width, height });
      sizeRef.current = { width, height };
      setSize(sizeRef.current);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(() => {
    if (!size) return EMPTY_LAYOUT;
    return layoutForce2d(view, {
      width: size.width,
      height: size.height,
      centerId: focusId,
      // 锚点跨渲染复用（A8）：ref 只缓存坐标，不驱动渲染；回写发生在布局后的 effect 里。
      // eslint-disable-next-line react-hooks/refs
      anchors: anchorsRef.current,
      maxTicks: layoutTicksForNodeCount(view.nodes.length),
      padding: 40,
    });
  }, [view, size, focusId]);

  // 布局结果回写为下一轮锚点：同一画布尺寸下换中心时原节点不重排，新节点在邻域附近松弛。
  useEffect(() => {
    const next: Record<string, readonly [number, number]> = {};
    for (const node of layout.nodes) next[node.id] = [node.x, node.y];
    anchorsRef.current = next;
  }, [layout]);

  const positionById = useMemo(
    () => new Map(layout.nodes.map((node) => [node.id, node])),
    [layout],
  );

  // 路径边只认 selectGraphHighlight 给出的 `edges`（A4 唯一真值）。
  // 早前这里用 `view.edges.find` 自己配对，平行边合并后可能与选择器选到不同一条。
  // 动画延迟按集合顺序排，纯装饰，不影响「哪条边亮」。
  const pathEdgeIds = useMemo(() => {
    const ids = new Map<string, number>();
    if (!highlight.path || highlight.path.length < 2) return ids;
    let index = 0;
    for (const id of highlight.edges) ids.set(id, index++);
    return ids;
  }, [highlight.edges, highlight.path]);

  // 键盘焦点：进入画布时落在选中节点或中心节点上。
  const rovingId = activeId && positionById.has(activeId)
    ? activeId
    : selectedId && positionById.has(selectedId)
      ? selectedId
      : layout.nodes.find((node) => node.center)?.id ?? layout.nodes[0]?.id ?? null;

  const stageWidth = size?.width ?? 0;
  const stageHeight = size?.height ?? 0;
  const labelFont = stageWidth < 420 ? 10 : 11;
  const labelIds = useMemo(() => {
    const chosen = new Set<string>();
    for (const node of view.nodes) {
      const isSelected = node.id === selectedId;
      const inPath = highlight.path?.includes(node.id) ?? false;
      if (camera.scale < 0.55) {
        if (node.flags.isCenter || isSelected || inPath) chosen.add(node.id);
        continue;
      }
      if (stageWidth < 420) {
        if (node.flags.isCenter || isSelected || inPath || node.degree >= 4) chosen.add(node.id);
        continue;
      }
      if (camera.scale < 0.85) {
        if (node.flags.isCenter || isSelected || inPath || node.degree >= 6) chosen.add(node.id);
        continue;
      }
      chosen.add(node.id);
    }
    return chosen;
  }, [camera.scale, highlight.path, selectedId, stageWidth, view.nodes]);

  const labels = useMemo(
    () =>
      placeLabels(
        layout.nodes,
        Object.fromEntries(view.nodes.map((node) => [node.id, node.shortLabel])),
        {
          width: stageWidth,
          height: stageHeight,
          fontSize: labelFont,
          padding: 6,
          priorityIds: [
            ...(selectedId ? [selectedId] : []),
            ...(highlight.path ?? []),
            ...layout.nodes.filter((node) => node.center).map((node) => node.id),
          ],
          onlyIds: labelIds,
        },
      ),
    [highlight.path, labelFont, labelIds, layout.nodes, selectedId, stageHeight, stageWidth, view.nodes],
  );
  const labelById = useMemo(() => new Map(labels.map((label) => [label.id, label])), [labels]);

  const zoomAt = useCallback((nextScale: number, originX?: number, originY?: number) => {
    setCamera((current) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
      if (scale === current.scale) return current;
      const ox = originX ?? stageWidth / 2;
      const oy = originY ?? stageHeight / 2;
      const ratio = scale / current.scale;
      return {
        scale,
        x: ox - (ox - current.x) * ratio,
        y: oy - (oy - current.y) * ratio,
      };
    });
  }, [stageHeight, stageWidth, setCamera]);

  // React 的 wheel 监听是 passive 的，缩放要阻止页面滚动，只能自己挂原生监听。
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      zoomAt(camera.scale * factor, event.clientX - rect.left, event.clientY - rect.top);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [camera.scale, zoomAt]);

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    pinchRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinchRef.current.size === 1) {
      dragRef.current = { x: event.clientX, y: event.clientY, camX: camera.x, camY: camera.y };
    }
    (event.target as Element).setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!pinchRef.current.has(event.pointerId)) return;
    pinchRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pinchRef.current.size >= 2) {
      const [a, b] = [...pinchRef.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const previous = pinchDistanceRef.current;
      pinchDistanceRef.current = distance;
      if (previous && previous > 0) zoomAt(camera.scale * (distance / previous));
      return;
    }

    const drag = dragRef.current;
    if (!drag) return;
    setCamera((current) => ({
      ...current,
      x: drag.camX + (event.clientX - drag.x),
      y: drag.camY + (event.clientY - drag.y),
    }));
  };

  const endPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    pinchRef.current.delete(event.pointerId);
    if (pinchRef.current.size === 0) {
      dragRef.current = null;
      pinchDistanceRef.current = null;
    }
  };

  const moveFocusTo = (direction: "up" | "down" | "left" | "right") => {
    if (!rovingId) return;
    const from = positionById.get(rovingId);
    if (!from) return;
    let best: { id: string; score: number } | null = null;
    for (const node of layout.nodes) {
      if (node.id === rovingId) continue;
      const dx = node.x - from.x;
      const dy = node.y - from.y;
      const primary = direction === "up" ? -dy : direction === "down" ? dy : direction === "left" ? -dx : dx;
      if (primary <= 4) continue;
      const cross = direction === "up" || direction === "down" ? Math.abs(dx) : Math.abs(dy);
      const score = primary + cross * 1.8;
      if (!best || score < best.score) best = { id: node.id, score };
    }
    if (!best) return;
    setActiveId(best.id);
    nodeRefs.current.get(best.id)?.focus({ preventScroll: true });
  };

  const onKeyDown = (event: React.KeyboardEvent<SVGSVGElement>) => {
    switch (event.key) {
      case "ArrowUp":
      case "ArrowDown":
      case "ArrowLeft":
      case "ArrowRight":
        event.preventDefault();
        moveFocusTo(
          event.key === "ArrowUp" ? "up" : event.key === "ArrowDown" ? "down" : event.key === "ArrowLeft" ? "left" : "right",
        );
        return;
      case "Enter":
        if (rovingId) {
          event.preventDefault();
          onSelect(rovingId);
        }
        return;
      case " ":
      case "f":
      case "F":
        if (rovingId) {
          event.preventDefault();
          onFocus(rovingId);
        }
        return;
      case "Escape":
        event.preventDefault();
        onSelect(null);
        return;
      case "+":
      case "=":
        event.preventDefault();
        zoomAt(camera.scale * 1.15);
        return;
      case "-":
        event.preventDefault();
        zoomAt(camera.scale / 1.15);
        return;
      case "0":
        event.preventDefault();
        setCamera({ scale: 1, x: 0, y: 0 });
        return;
      default:
        return;
    }
  };

  const centerNode = layout.nodes.find((node) => node.center) ?? null;

  return (
    <div
      className="g2-stage"
      ref={wrapperRef}
      data-surface="graph"
      data-mode="2d"
      data-scale={camera.scale.toFixed(2)}
    >
      <svg
        ref={svgRef}
        className="g2-svg"
        viewBox={`0 0 ${stageWidth || 1} ${stageHeight || 1}`}
        role="group"
        aria-label={`二维聚焦视图，${view.nodes.length} 个实体、${view.edges.length} 条关系${
          centerNode ? `，中心是 ${centerNode.id}` : ""
        }。方向键移动，回车选中，F 聚焦，按 3 切换到星系视图。`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onDoubleClick={(event) => {
          if (event.target === event.currentTarget) setCamera({ scale: 1, x: 0, y: 0 });
        }}
      >
        <defs>
          <radialGradient id="g2-halo">
            <stop offset="0%" stopColor="var(--graph-accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--graph-accent)" stopOpacity="0" />
          </radialGradient>
        </defs>

        <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.scale})`}>
          <g className="g2-edges" aria-hidden="true">
            {view.edges.map((edge) => {
              const from = positionById.get(edge.source);
              const to = positionById.get(edge.target);
              if (!from || !to) return null;
              const pathIndex = pathEdgeIds.get(edge.id);
              const lit = highlight.edges.has(edge.id) || pathIndex !== undefined;
              const dimmed = highlight.dimmedEdges.has(edge.id);
              return (
                <line
                  key={edge.id}
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  className={[
                    "g2-edge",
                    edge.strong ? "is-strong" : "",
                    lit ? "is-lit" : "",
                    pathIndex !== undefined ? "is-path" : "",
                    dimmed && pathIndex === undefined ? "is-dim" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={
                    pathIndex !== undefined
                      ? { animationDelay: `${pathIndex * 180}ms` }
                      : undefined
                  }
                >
                  <title>{edge.description || `${edge.source} —${edge.type}→ ${edge.target}`}</title>
                </line>
              );
            })}
          </g>

          <g className="g2-nodes">
            {view.nodes.map((node) => {
              const position = positionById.get(node.id);
              if (!position) return null;
              const isSelected = node.id === selectedId;
              const isFocus = node.id === focusId || node.flags.isCenter;
              const isPath = highlight.path?.includes(node.id) ?? false;
              const isLit = highlight.nodes.has(node.id);
              const isDim = highlight.dimmed.has(node.id);
              const isHover = node.id === hoverId;

              return (
                <g
                  key={node.id}
                  ref={(element) => {
                    nodeRefs.current.set(node.id, element);
                  }}
                  className={[
                    "g2-node",
                    node.flags.isCenter ? "is-center" : "",
                    isSelected ? "is-selected" : "",
                    isPath ? "is-path-node" : "",
                    isLit ? "is-lit" : "",
                    isDim ? "is-dim" : "",
                    isHover ? "is-hover" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  transform={`translate(${position.x} ${position.y})`}
                  role="button"
                  tabIndex={node.id === rovingId ? 0 : -1}
                  aria-label={`${node.label}，${ENTITY_STYLE[node.type].labelZh}，${node.degree} 条关系${
                    isSelected ? "，已选中" : ""
                  }`}
                  aria-pressed={isSelected}
                  data-node-id={node.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    setActiveId(node.id);
                    onSelect(node.id, { shiftKey: event.shiftKey });
                  }}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    onFocus(node.id);
                  }}
                  onPointerEnter={() => {
                    setHoverId(node.id);
                    onHover?.(node.id);
                  }}
                  onPointerLeave={() => {
                    setHoverId(null);
                    onHover?.(null);
                  }}
                  onFocus={() => setActiveId(node.id)}
                >
                  {(isSelected || isPath) && (
                    <circle r={position.radius + 14} fill="url(#g2-halo)" className="g2-halo" />
                  )}
                  {isFocus && !isSelected && <circle r={position.radius + 5} className="g2-focus-halo" />}
                  <NodeShape node={node} radius={position.radius} />
                  {isSelected && <circle r={position.radius + 4} className="g2-selection-ring" />}
                  <circle r={position.radius + 7} className="g2-keyboard-ring" />
                </g>
              );
            })}
          </g>

          <g className="g2-labels" aria-hidden="true">
            {layout.nodes.map((node) => {
              const label = labelById.get(node.id);
              if (!label?.visible) return null;
              const isSelected = node.id === selectedId;
              return (
                <text
                  key={node.id}
                  x={label.x}
                  y={label.y}
                  textAnchor={label.anchor}
                  className={`g2-label${isSelected ? " is-selected" : ""}${
                    node.center ? " is-center" : ""
                  }`}
                >
                  {view.nodes.find((item) => item.id === node.id)?.shortLabel ?? node.id}
                </text>
              );
            })}
          </g>
        </g>
      </svg>

      <div className="g2-zoom" aria-hidden="true">
        <button type="button" onClick={() => zoomAt(camera.scale * 1.15)} tabIndex={-1}>
          ＋
        </button>
        <button type="button" onClick={() => zoomAt(camera.scale / 1.15)} tabIndex={-1}>
          －
        </button>
        <button type="button" onClick={() => setCamera({ scale: 1, x: 0, y: 0 })} tabIndex={-1}>
          适配
        </button>
      </div>
    </div>
  );
}

function NodeShape({ node, radius }: { node: GraphNode; radius: number }) {
  const style = {
    stroke: `var(${node.colorToken})`,
    fill: "var(--graph-node-disk)",
  };
  const innerStyle = { fill: `var(${node.colorToken})` };

  switch (node.shape) {
    case "double-ring":
      return (
        <>
          <circle r={radius} style={style} className="g2-shape" />
          <circle r={radius * 0.6} style={{ ...style, fill: "none" }} className="g2-shape-inner" />
          <circle r={radius * 0.26} style={innerStyle} className="g2-core" />
        </>
      );
    case "round-square":
      return (
        <>
          <rect
            x={-radius}
            y={-radius}
            width={radius * 2}
            height={radius * 2}
            rx={radius * 0.34}
            style={style}
            className="g2-shape"
          />
          <circle r={radius * 0.3} style={innerStyle} className="g2-core" />
        </>
      );
    case "diamond":
      return (
        <>
          <polygon points={polygon(4, radius * 1.12, Math.PI / 4)} style={style} className="g2-shape" />
          <circle r={radius * 0.3} style={innerStyle} className="g2-core" />
        </>
      );
    case "hexagon":
      return (
        <>
          <polygon points={polygon(6, radius * 1.05, 0)} style={style} className="g2-shape" />
          <circle r={radius * 0.3} style={innerStyle} className="g2-core" />
        </>
      );
    case "dot":
      return (
        <>
          <circle r={radius * 0.82} style={style} className="g2-shape" />
          <circle r={radius * 0.3} style={innerStyle} className="g2-core" />
        </>
      );
    case "circle":
    default:
      return (
        <>
          <circle r={radius} style={style} className="g2-shape" />
          <circle r={radius * 0.3} style={innerStyle} className="g2-core" />
        </>
      );
  }
}

function polygon(sides: number, radius: number, offset: number): string {
  return Array.from({ length: sides }, (_, index) => {
    const angle = offset + (Math.PI * 2 * index) / sides;
    return `${(radius * Math.cos(angle)).toFixed(2)},${(radius * Math.sin(angle)).toFixed(2)}`;
  }).join(" ");
}

