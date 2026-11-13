"use client";

/**
 * 图谱容器（ADR-022 A3 / A5 / A7，Phase 6D-3）。
 *
 * 职责只有四件：取数、维护 URL 视图状态、把 `GraphViewModel` 交给渲染器、处理状态与详情。
 * 2D 舞台、3D 场景、列表都只读同一份模型；选中 / 悬停 / 路径是容器内的视图态，
 * 按 A3 不进 URL、也不进模型（URL 只有 mode / focus / depth，外加诊断参数 maxNodes）。
 *
 * 3D 已是真实渲染器（B 线），桌面默认进 3D；无 WebGL / reduced-motion / 移动端仍回落 2D。
 * 容器在 3D 分支额外负责两件事：超出档位预算时先 `decimate` 出渲染视图，
 * 以及按 stats 读数只降不升地压档（ADR-022 第 8 条）——两者都只影响 3D，
 * 2D / 列表始终读完整的 `view`。
 */

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { pickInitialLabel, sortLabels } from "@/lib/graph-labels";
import {
  ENTITY_STYLE,
  buildGraphViewModel,
  type GraphHop,
  type GraphNode,
  type GraphViewModel,
} from "@/lib/graph-model";
import {
  TIER_BUDGETS,
  TIER_ORDER,
  decimate,
  selectGraphMode,
  type GraphViewMode,
  type QualityTier,
} from "@/lib/graph-quality";
import { selectGraphHighlight, type GraphHighlight } from "@/lib/graph-selectors";
import type { LightragSubgraph } from "@/server/adapters/lightrag/client";
import type { GraphStatus } from "@/server/services/graph-service";

import { GraphStage2D } from "./graph/graph-stage-2d";
import { Icon } from "./icon";

const GraphScene3D = dynamic(() => import("./graph/graph-scene-3d"), {
  ssr: false,
  loading: () => (
    <div className="g3-stub g3-stub-loading" data-surface="graph" data-mode="3d">
      <p className="g3-stub-title">正在准备星系视图…</p>
    </div>
  ),
});

/**
 * 自适应降档的判定口径（ADR-022 第 8 条）。
 *
 * stats 每 30 帧发布一次，所以「连续 60 帧平均帧时 > 20ms」= 连续两个 stats 窗口超阈值；
 * 任一次回到 20ms 以内就清零。最多降两次，两次之间至少 3 秒，降完清零计数。
 */
const SLOW_FRAME_MS = 20;
const SLOW_WINDOWS = 2;
const MAX_TIER_DROPS = 2;
const TIER_DROP_COOLDOWN_MS = 3000;

export type GraphSubgraphView = LightragSubgraph;
export type GraphStatusView = GraphStatus;

export interface GraphReferenceView {
  objectId: string;
  title: string;
  type: "asset" | "work";
  library: "internal" | "external";
}

export interface GraphAnswerView {
  question: string;
  response: string;
  references: GraphReferenceView[];
}

export interface GraphSyncResultView {
  candidates: number;
  submitted: number;
  unchanged: number;
  skipped: Array<{ objectId: string; title: string; reason: string }>;
  removed: number;
  errors: Array<{ objectId: string; title: string; message: string }>;
}

export interface GraphExplorerProps {
  initialLabels: string[];
  initialStatus: GraphStatusView | null;
  initialStatusFailed?: boolean;
  initialSubgraph: GraphSubgraphView | null;
  /** 服务端首屏取景的实体；URL 没有 ?focus 时沿用它。 */
  initialCenter: string | null;
  initialDepth: GraphHop;
  initialError: string | null;
  /** 客户端请求规模；必须与服务端预取一致（ADR-022 A5）。 */
  maxNodes: number;
}

const EMPTY_SUBGRAPH: LightragSubgraph = { nodes: [], edges: [] };
const RELATION_LIMIT = 20;
const EMPTY_HIGHLIGHT: GraphHighlight = {
  nodes: new Set<string>(),
  edges: new Set<string>(),
  dimmed: new Set<string>(),
  dimmedEdges: new Set<string>(),
  path: null,
};

function isWorking(status: GraphStatusView | null): boolean {
  if (!status) return false;
  return (status.byStatus.pending ?? 0) + (status.byStatus.processing ?? 0) > 0;
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: { message?: string } })
    | null;
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `请求失败（${response.status}）`);
  }
  return payload as T;
}

function parseMode(raw: string | null): GraphViewMode | null {
  return raw === "2d" || raw === "3d" || raw === "list" ? raw : null;
}

function parseDepth(raw: string | null): GraphHop | null {
  if (raw === "1" || raw === "2" || raw === "3") return Number(raw) as GraphHop;
  return null;
}

function focusKey(center: string | null, depth: GraphHop, maxNodes: number): string {
  return `${center ?? ""}|${depth}|${maxNodes}`;
}

function modeLabel(mode: GraphViewMode): string {
  if (mode === "list") return "列表";
  if (mode === "3d") return "星系";
  return "2D 聚焦";
}

const MODE_OPTIONS: Array<{ value: GraphViewMode; label: string; icon: "graph" | "galaxy" | "grid" }> = [
  { value: "2d", label: "2D 聚焦", icon: "graph" },
  { value: "3d", label: "星系", icon: "galaxy" },
  { value: "list", label: "列表", icon: "grid" },
];

interface DeviceCapabilities {
  readonly webgl: boolean;
  readonly softwareRenderer: boolean;
  readonly hardwareConcurrency: number | null;
}

const NO_DEVICE: DeviceCapabilities = {
  webgl: false,
  softwareRenderer: false,
  hardwareConcurrency: null,
};

let cachedDevice: DeviceCapabilities | null = null;

/**
 * 设备能力是「读一次就不会变」的外部快照：用 useSyncExternalStore 的
 * server snapshot 兜住 SSR 首帧，水合后再换成真实值，避免 setState-in-effect。
 */
function readDevice(): DeviceCapabilities {
  if (typeof window === "undefined") return NO_DEVICE;
  if (cachedDevice) return cachedDevice;

  let webgl = false;
  let softwareRenderer = false;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    webgl = gl !== null;
    if (gl) {
      const info = gl.getExtension("WEBGL_debug_renderer_info") as
        | { UNMASKED_RENDERER_WEBGL: number }
        | null;
      const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
      softwareRenderer = /swiftshader|llvmpipe|software|basic render/i.test(renderer);
    }
  } catch {
    webgl = false;
  }

  cachedDevice = {
    webgl,
    softwareRenderer,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
  };
  return cachedDevice;
}

function subscribeNothing(): () => void {
  return () => {};
}

function subscribeReducedMotion(callback: () => void): () => void {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}

function readReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function subscribeMobile(callback: () => void): () => void {
  const query = window.matchMedia("(max-width: 767px)");
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}

function readIsMobile(): boolean {
  return window.matchMedia("(max-width: 767px)").matches;
}

export function GraphExplorer({
  initialLabels,
  initialStatus,
  initialStatusFailed = false,
  initialSubgraph,
  initialCenter,
  initialDepth,
  initialError,
  maxNodes,
}: GraphExplorerProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [labels, setLabels] = useState<string[]>(() => sortLabels(initialLabels));
  const [status, setStatus] = useState<GraphStatusView | null>(initialStatus);
  const [statusFailed, setStatusFailed] = useState(initialStatusFailed);
  const [serviceError, setServiceError] = useState<string | null>(initialError);

  const [subgraph, setSubgraph] = useState<GraphSubgraphView | null>(initialSubgraph);
  const [loadedKey, setLoadedKey] = useState(() =>
    initialSubgraph && initialCenter ? focusKey(initialCenter, initialDepth, maxNodes) : "",
  );
  // 图与「它是谁的邻域」一起记：换中心时 focus 先变、图后到，
  // 若用新中心配旧图，computeHops 找不到中心，整张图会被标成不可达（阻断项 2）。
  const [loadedCenter, setLoadedCenter] = useState<string | null>(() =>
    initialSubgraph && initialCenter ? initialCenter : null,
  );
  const [graphErrorState, setGraphErrorState] = useState<{ key: string; message: string } | null>(
    null,
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [pathTo, setPathTo] = useState<string | null>(null);
  const [pathPick, setPathPick] = useState(false);

  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<GraphAnswerView | null>(null);
  const [answerError, setAnswerError] = useState<string | null>(null);

  const [announcement, setAnnouncement] = useState("");
  const [sceneError, setSceneError] = useState<string | null>(null);
  // ADR-022 A8：默认不转；只有用户点开关才动，reduced-motion 下开关不出现。
  const [autoRotate, setAutoRotate] = useState(false);

  const requestRef = useRef(0);
  const readyRef = useRef<{ layoutMs: number; layoutTicks: number; truncated: boolean; drawCalls: number } | null>(null);
  const sceneStatsRef = useRef<{
    frames: number;
    avgFrameMs: number;
    labels: number;
    drawCalls: number;
    dpr: number;
    rafActive: boolean;
    layoutTicks: number;
    truncated: boolean;
  } | null>(null);
  const [debugVersion, setDebugVersion] = useState(0);
  // 自动降档的上限：只降不升、不持久化，刷新页面回到设备基础档位（ADR-022 第 8 条）。
  const [tierCeiling, setTierCeiling] = useState<QualityTier | null>(null);
  const perfGuardRef = useRef({ frames: 0, slowWindows: 0, drops: 0, lastDropAt: 0 });
  // stats 回调不随 mode / tier 重建：渲染循环里的 setState 不该被每次渲染换掉的闭包拖住。
  const modeRef = useRef<GraphViewMode>("2d");
  const tierRef = useRef<QualityTier>("balanced");

  // URL 是 mode / focus / depth 的唯一来源；非法值按默认处理。
  const urlMode = parseMode(searchParams.get("mode"));
  const focusParam = searchParams.get("focus");
  const focus = (focusParam?.trim() || initialCenter || labels[0] || null) as string | null;
  const depth = parseDepth(searchParams.get("depth")) ?? initialDepth;

  const device = useSyncExternalStore(subscribeNothing, readDevice, () => NO_DEVICE);
  const { webgl, softwareRenderer, hardwareConcurrency } = device;
  const reducedMotion = useSyncExternalStore(subscribeReducedMotion, readReducedMotion, () => false);
  const isMobile = useSyncExternalStore(subscribeMobile, readIsMobile, () => false);

  // 取数状态由「目标 key / 已加载 key / 该 key 的错误」推导，不在 effect 里同步 setState。
  const pendingKey = focus ? focusKey(focus, depth, maxNodes) : "";
  const graphError =
    graphErrorState && graphErrorState.key === pendingKey ? graphErrorState.message : null;
  const graphLoading = Boolean(focus) && pendingKey !== loadedKey && graphError === null;

  // urlMode 传原值：别把 "2d" 塞进判定，否则 no-webgl / reduced-motion / mobile 三条分支和文案永远走不到。
  // previousTier 传自动降档的上限：`selectGraphMode` 只取更低的那档，容器不另造档位表。
  const decision = useMemo(
    () =>
      selectGraphMode({
        webgl,
        reducedMotion,
        isMobile,
        nodeCount: subgraph?.nodes.length ?? 0,
        urlMode,
        hardwareConcurrency,
        softwareRenderer,
        previousTier: tierCeiling,
      }),
    [webgl, reducedMotion, isMobile, subgraph, urlMode, hardwareConcurrency, softwareRenderer, tierCeiling],
  );
  const mode: GraphViewMode = decision.mode;
  const tier: QualityTier = decision.tier;
  const canUse3d = decision.canUse3d;

  useEffect(() => {
    modeRef.current = mode;
    tierRef.current = tier;
  }, [mode, tier]);

  const setView = useCallback(
    (patch: { mode?: GraphViewMode | null; focus?: string | null; depth?: GraphHop | null }) => {
      const params = new URLSearchParams(searchParams.toString());
      if ("mode" in patch) {
        if (patch.mode) params.set("mode", patch.mode);
        else params.delete("mode");
      }
      if ("focus" in patch) {
        if (patch.focus) params.set("focus", patch.focus);
        else params.delete("focus");
      }
      if ("depth" in patch) {
        if (patch.depth) params.set("depth", String(patch.depth));
        else params.delete("depth");
      }
      const query = params.toString();
      router.replace(query ? `/graph?${query}` : "/graph", { scroll: false });
    },
    [router, searchParams],
  );

  // 数据：图与状态并发取；任一失败按 A5.2 降级（图失败保留上一张图并标灰，状态失败只影响状态条）。
  useEffect(() => {
    if (!focus) return;
    const key = pendingKey;
    if (key === loadedKey) return;

    const ticket = ++requestRef.current;
    const controller = new AbortController();

    void (async () => {
      const [graphResult, statusResult] = await Promise.allSettled([
        fetch(`/api/graph?label=${encodeURIComponent(focus)}&depth=${depth}&maxNodes=${maxNodes}`, {
          cache: "no-store",
          signal: controller.signal,
        }).then((response) => readJson<GraphSubgraphView>(response)),
        fetch("/api/graph/status", { cache: "no-store", signal: controller.signal }).then((response) =>
          readJson<GraphStatusView>(response),
        ),
      ]);

      if (ticket !== requestRef.current || controller.signal.aborted) return;

      if (graphResult.status === "fulfilled") {
        setSubgraph(graphResult.value);
        setLoadedCenter(focus);
        setLoadedKey(key);
        setGraphErrorState(null);
        setServiceError(null);
      } else {
        setGraphErrorState({
          key,
          message: graphResult.reason instanceof Error ? graphResult.reason.message : "图谱加载失败",
        });
      }

      if (statusResult.status === "fulfilled") {
        setStatus(statusResult.value);
        setStatusFailed(false);
      } else {
        setStatusFailed(true);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [focus, depth, maxNodes, pendingKey, loadedKey]);

  const retryGraph = useCallback(() => {
    setGraphErrorState(null);
    setLoadedKey("");
  }, []);

  const refreshStatus = useCallback(async (): Promise<GraphStatusView | null> => {
    try {
      const data = await readJson<GraphStatusView>(
        await fetch("/api/graph/status", { cache: "no-store" }),
      );
      setStatus(data);
      setStatusFailed(false);
      return data;
    } catch (error) {
      setStatusFailed(true);
      setServiceError(error instanceof Error ? error.message : "图谱服务没有响应");
      return null;
    }
  }, []);

  const refreshLabels = useCallback(async () => {
    try {
      const data = await readJson<{ labels: string[] }>(
        await fetch("/api/graph/labels", { cache: "no-store" }),
      );
      const next = sortLabels(data.labels);
      setLabels(next);
      setServiceError(null);
      if (focus && next.length > 0 && !next.includes(focus)) {
        const fallback = pickInitialLabel(next);
        if (fallback) setView({ focus: fallback });
      }
    } catch (error) {
      setServiceError(error instanceof Error ? error.message : "图谱服务没有响应");
    }
  }, [focus, setView]);

  useEffect(() => {
    if (!isWorking(status)) return;
    const timer = setInterval(() => {
      void refreshStatus().then((next) => {
        if (next && next.byStatus.processed) void refreshLabels();
      });
    }, 15_000);
    return () => clearInterval(timer);
  }, [status, refreshStatus, refreshLabels]);

  const modelInput = subgraph ?? EMPTY_SUBGRAPH;
  // 标题、舞台、模型一律用「已加载那张图的中心」，而不是正在请求的中心。
  const displayCenter = loadedCenter ?? focus;

  // 只构建一次；所有渲染器与选择器共用这一个 view-model。
  const view: GraphViewModel = useMemo(
    () =>
      buildGraphViewModel({
        subgraph: modelInput,
        status,
        statusFailed,
        center: loadedCenter ?? "",
        depth,
        maxNodes,
      }),
    [modelInput, status, statusFailed, loadedCenter, depth, maxNodes],
  );

  // 模型换代后节点可能已不存在：选中与路径按「当前模型里查得到」降级，
  // 不在 effect 里回写 state（避免级联渲染），状态本身保留到下次点选。
  const activeSelectedId = selectedId && view.nodeIndex.has(selectedId) ? selectedId : null;
  const activePathTo =
    pathTo && activeSelectedId && view.nodeIndex.has(pathTo) ? pathTo : null;

  /**
   * 3D 的渲染视图（ADR-022 第 9 条）：超出档位预算时先抽稀再交给场景。
   *
   * - 只对 `mode === "3d"` 生效：2D / 列表与详情栏继续读完整的 `view`，`highlight` 的 id 语义不变；
   * - `keepIds` 放当前中心、选中、hover、路径端点——抽稀不能把用户正在看的点删掉；
   * - 默认 150 节点时各档预算都够（low 150 / balanced 300 / high 600），这段不触发；
   * - 抽稀后重建 `nodeIndex`，因为场景 / 标签层都用它反查节点。
   */
  const renderView: GraphViewModel = useMemo(() => {
    if (mode !== "3d" || !decision.overBudget) return view;

    const budget = TIER_BUDGETS[tier].maxNodes;
    const keepIds = new Set<string>();
    if (displayCenter) keepIds.add(displayCenter);
    if (activeSelectedId) keepIds.add(activeSelectedId);
    if (activePathTo) keepIds.add(activePathTo);
    if (hoverId) keepIds.add(hoverId);

    const thinned = decimate(view, { budget, keepIds });
    if (!thinned.truncated) return view;

    const nodeIndex = new Map(thinned.nodes.map((node, index) => [node.id, index]));
    return { ...view, nodes: thinned.nodes, edges: thinned.edges, nodeIndex };
  }, [mode, decision.overBudget, tier, view, displayCenter, activeSelectedId, activePathTo, hoverId]);

  // 只数「因为预算被挡在提示条后面的」节点，2D / 列表下恒为 0。
  const hiddenNodes = view.nodes.length - renderView.nodes.length;

  const highlight = useMemo(
    () =>
      selectGraphHighlight(view, {
        focusId: focus,
        selectedId: activeSelectedId,
        hoverId,
        pathTo: activePathTo,
      }),
    [view, focus, activeSelectedId, hoverId, activePathTo],
  );

  const labelOf = useCallback(
    (id: string | null): string => {
      if (!id) return "";
      const index = view.nodeIndex.get(id);
      return index === undefined ? id : view.nodes[index].label;
    },
    [view],
  );

  const handleSelect = useCallback(
    (id: string | null, options?: { shiftKey?: boolean }) => {
      if (!id) {
        setSelectedId(null);
        setPathTo(null);
        setPathPick(false);
        setAnnouncement("已取消选中");
        return;
      }
      if (pathPick && activeSelectedId && activeSelectedId !== id) {
        setSelectedId(activeSelectedId);
        setPathTo(id);
        setPathPick(false);
        setAnnouncement(`已选择路径终点 ${labelOf(id)}`);
        return;
      }
      if (options?.shiftKey && activeSelectedId && activeSelectedId !== id) {
        setSelectedId(activeSelectedId);
        setPathTo(id);
        setPathPick(false);
        setAnnouncement(`正在显示到 ${labelOf(id)} 的路径`);
        return;
      }
      setSelectedId(id);
      setPathTo(null);
      setPathPick(false);
      setAnnouncement(`已选中 ${labelOf(id)}`);
    },
    [pathPick, activeSelectedId, labelOf],
  );

  const handleFocus = useCallback(
    (id: string) => {
      const label = labelOf(id);
      setView({ focus: id });
      setAnnouncement(`已切换到 ${label} 的邻域`);
    },
    [labelOf, setView],
  );

  const handleHover = useCallback((id: string | null) => {
    setHoverId(id);
  }, []);

  // 快捷键 2 / 3 / L 切模式；输入控件内不拦截。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.key === "2") setView({ mode: "2d" });
      else if (event.key === "3" && canUse3d) setView({ mode: "3d" });
      else if (event.key === "l" || event.key === "L") setView({ mode: "list" });
      else if (event.key === "Escape" && pathPick) {
        setPathPick(false);
        setAnnouncement("已取消选择路径终点");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canUse3d, pathPick, setView]);

  // 调试读数（设计稿 §8.3）：只在开发态暴露，生产不写全局。
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const stats = sceneStatsRef.current;
    const ready = readyRef.current;
    (window as Window & { __graphStats?: Record<string, unknown> }).__graphStats = {
      mode,
      tier,
      reason: decision.reason,
      webgl,
      softwareRenderer,
      nodes: view.meta.total,
      edges: view.edges.length,
      // 3D 抽稀后才真正进场景的节点数；2D / 列表下与 nodes 相同。
      rendered: renderView.nodes.length,
      hidden: hiddenNodes,
      focus,
      truncated: view.meta.truncated,
      layoutMs: ready?.layoutMs ?? 0,
      layoutTicks: ready?.layoutTicks ?? 0,
      drawCalls: ready?.drawCalls ?? stats?.drawCalls ?? 0,
      frames: stats?.frames ?? 0,
      avgFrameMs: stats?.avgFrameMs ?? 0,
      labels: stats?.labels ?? 0,
      dpr: stats?.dpr ?? 1,
      rafActive: stats?.rafActive ?? false,
    };
  }, [mode, tier, decision.reason, webgl, softwareRenderer, view, renderView, hiddenNodes, focus, debugVersion]);

  const handleReady = useCallback((next: { layoutMs: number; layoutTicks: number; truncated: boolean; drawCalls: number }) => {
    readyRef.current = next;
    // 生产环境不为调试读数重渲染整棵树；数字仍在 ref 里，够诊断时用。
    if (process.env.NODE_ENV !== "production") setDebugVersion((current) => current + 1);
  }, []);

  const handleStats = useCallback((next: {
    frames: number;
    avgFrameMs: number;
    labels: number;
    drawCalls: number;
    dpr: number;
    rafActive: boolean;
    layoutTicks: number;
    truncated: boolean;
  }) => {
    sceneStatsRef.current = next;
    if (process.env.NODE_ENV !== "production") setDebugVersion((current) => current + 1);

    // 自适应降档（ADR-022 第 8 条）：只看 3D 且 rafActive 的窗口。
    const guard = perfGuardRef.current;
    if (next.frames < guard.frames) {
      // 布局换了，场景里的帧计数器归零；重新起算，不把这次回绕当成「没出帧」。
      guard.frames = next.frames;
      guard.slowWindows = 0;
      return;
    }
    if (modeRef.current !== "3d" || !next.rafActive) {
      // 2D / 后台标签页都是一次空闲，连续性在这里断掉（ADR-022 第 8 条）。
      guard.frames = next.frames;
      guard.slowWindows = 0;
      return;
    }
    if (next.frames === guard.frames) {
      // 同一窗口重复发布：没有新帧就不算一个窗口，也不保留上一次的慢窗口计数。
      guard.slowWindows = 0;
      return;
    }
    guard.frames = next.frames;

    guard.slowWindows = next.avgFrameMs > SLOW_FRAME_MS ? guard.slowWindows + 1 : 0;
    if (guard.slowWindows < SLOW_WINDOWS || guard.drops >= MAX_TIER_DROPS) return;

    const now = performance.now();
    if (now - guard.lastDropAt < TIER_DROP_COOLDOWN_MS) return;

    // 档位顺序就是 `TIER_ORDER`，取比当前低一档；已经在 low 就不再降。
    const lower = TIER_ORDER[TIER_ORDER.indexOf(tierRef.current) - 1] ?? null;
    if (lower === null) return;

    guard.drops += 1;
    guard.lastDropAt = now;
    guard.slowWindows = 0;
    setTierCeiling(lower);
    setAnnouncement("已自动降低画质以保持流畅");
  }, []);

  const handleSceneError = useCallback((reason: "context-lost" | "chunk-failed" | "webgl-unavailable") => {
    setSceneError(
      reason === "context-lost"
        ? "3D 渲染上下文丢失，已准备回退到 2D。"
        : reason === "chunk-failed"
          ? "3D 资源加载失败，可以先继续用 2D 阅读。"
          : "这台设备无法使用 WebGL，已准备回退到 2D。",
    );
  }, []);

  const handleIntent = useCallback(
    (intent: string, id?: string) => {
      if (intent === "select" && id) setSelectedId(id);
      else if (intent === "hover") setHoverId(id ?? null);
      else if (intent === "focus" && id) handleFocus(id);
      else if (intent === "toggle-mode") setView({ mode: mode === "3d" ? "2d" : "3d" });
      else if (intent === "change-depth") {
        const next = (depth % 3) + 1;
        setView({ depth: next as GraphHop });
      }
    },
    [handleFocus, mode, depth, setView],
  );

  const selectEntity = (id: string) => handleSelect(id);
  const focusEntity = (id: string) => {
    setSelectedId(id);
    handleFocus(id);
  };

  async function handleSync() {
    setSyncing(true);
    setSyncNote(null);
    try {
      const result = await readJson<GraphSyncResultView>(
        await fetch("/api/graph/sync", { method: "POST" }),
      );

      const parts = [`检查了 ${result.candidates} 个对象`];
      if (result.submitted > 0) parts.push(`新送 ${result.submitted} 个`);
      if (result.unchanged > 0) parts.push(`未变化 ${result.unchanged} 个`);
      if (result.removed > 0) parts.push(`更新 ${result.removed} 个旧版本`);
      if (result.skipped.length > 0) parts.push(`跳过 ${result.skipped.length} 个（无正文）`);
      if (result.errors.length > 0) parts.push(`${result.errors.length} 个失败`);

      setSyncNote(
        result.submitted > 0
          ? `${parts.join("，")}。抽取在本机后台进行，稍等后点「刷新进度」。`
          : `${parts.join("，")}。`,
      );

      await refreshStatus();
      await refreshLabels();
      if (result.submitted > 0) {
        setSelectedId(null);
        setPathTo(null);
        setSubgraph(null);
        setLoadedKey("");
      }
    } catch (error) {
      setSyncNote(error instanceof Error ? error.message : "同步失败");
    } finally {
      setSyncing(false);
    }
  }

  async function refreshAll() {
    const next = await refreshStatus();
    if (next) await refreshLabels();
  }

  async function ask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || asking) return;

    setAsking(true);
    setAnswerError(null);
    try {
      const data = await readJson<GraphAnswerView>(
        await fetch("/api/graph/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q: trimmed }),
        }),
      );
      setAnswer(data);
    } catch (error) {
      setAnswer(null);
      setAnswerError(error instanceof Error ? error.message : "问答暂时不可用");
    } finally {
      setAsking(false);
    }
  }

  const selectedNode: GraphNode | null = useMemo(() => {
    if (!activeSelectedId) return null;
    const index = view.nodeIndex.get(activeSelectedId);
    return index === undefined ? null : view.nodes[index];
  }, [activeSelectedId, view]);

  const relations = useMemo(() => {
    if (!selectedNode) return [];
    const rows = view.edges
      .filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id)
      .map((edge) => {
        const otherId = edge.source === selectedNode.id ? edge.target : edge.source;
        const index = view.nodeIndex.get(otherId);
        return { edge, other: index === undefined ? null : view.nodes[index] };
      })
      .filter((row): row is { edge: (typeof view.edges)[number]; other: GraphNode } => row.other !== null);
    rows.sort((a, b) => b.other.degree - a.other.degree || (a.other.id < b.other.id ? -1 : 1));
    return rows;
  }, [selectedNode, view]);

  const selectedReferences =
    answer && selectedNode && answer.response.includes(selectedNode.label) ? answer.references : [];

  const working = isWorking(status);
  const workingCount = (status?.byStatus.pending ?? 0) + (status?.byStatus.processing ?? 0);
  // 状态接口挂掉（status === null）不等于「图谱确实为空」，两条文案必须分开。
  const statusUnknown = status === null && labels.length === 0;
  const zeroContent = labels.length === 0 && status !== null && status.total === 0;
  const noEntities = labels.length === 0 && (status?.total ?? 0) > 0;
  const noNeighborhood = !graphLoading && !graphError && view.nodes.length === 0;
  const orphanFocused =
    view.nodes.length === 1 && view.nodes[0].hop === 0 && view.nodes[0].degree === 0;
  const otherLabel = labels.find((label) => label !== focus) ?? null;
  const pathVisible = Boolean(activeSelectedId && activePathTo);
  const pathHops = highlight.path ? highlight.path.length - 1 : null;

  const focusOptions = useMemo(() => {
    const options = [...labels];
    if (focus && !options.includes(focus)) options.unshift(focus);
    return options;
  }, [labels, focus]);

  const modeHint =
    decision.reason === "url-3d" || decision.reason === "auto-3d"
      ? "星系视图：拖动旋转、滚轮缩放；单击选中，双击设为中心。"
      : decision.reason === "mobile"
        ? "移动端默认 2D 聚焦，点选与缩放在触屏上同样可用。"
        : decision.reason === "reduced-motion"
          ? "检测到「减少动态效果」，已停在 2D。"
          : mode === "list"
            ? "列表适合逐条核对；Enter 选中，再点「设为中心」展开邻域。"
            : "单击选中，双击设为中心；Shift + 单击另一个实体可直接看路径。";

  return (
    <div className="graph-workspace" data-surface="graph" data-mode={mode}>
      <section className="panel graph-toolbar" aria-label="图谱状态与视图">
        <div className="graph-status">
          <span className={`graph-dot${working ? " is-working" : ""}`} aria-hidden="true" />
          <div>
            <strong>
              {status
                ? `${status.total} 个内容已进图谱${
                    status.byStatus.processed ? ` · ${status.byStatus.processed} 个完成抽取` : ""
                  }`
                : "图谱服务未连接"}
            </strong>
            <p>
              {working
                ? `还有 ${workingCount} 个在排队或抽取，本机模型较慢，几分钟属正常。`
                : modeHint}
            </p>
          </div>
        </div>

        <div className="graph-toolbar-actions">
          <label className="graph-toolbar-field">
            <span>中心</span>
            <select
              value={focus ?? ""}
              onChange={(event) => {
                const next = event.target.value;
                if (next) {
                  setSelectedId(null);
                  setView({ focus: next });
                }
              }}
              aria-label="选择中心实体"
              disabled={labels.length === 0}
            >
              {focusOptions.length === 0 ? <option value="">暂无实体</option> : null}
              {focusOptions.map((label) => (
                <option key={label} value={label}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label className="graph-toolbar-field">
            <span>邻域</span>
            <select
              value={depth}
              onChange={(event) => setView({ depth: parseDepth(event.target.value) })}
              aria-label="选择展开深度"
            >
              <option value="1">1 层</option>
              <option value="2">2 层</option>
              <option value="3">3 层</option>
            </select>
          </label>

          <div className="graph-mode-switch" role="group" aria-label="视图模式">
            {MODE_OPTIONS.map((option) =>
              option.value === "3d" && !canUse3d && mode !== "3d" ? null : (
                <button
                  key={option.value}
                  type="button"
                  className={`graph-mode-button${mode === option.value ? " is-active" : ""}`}
                  aria-pressed={mode === option.value}
                  onClick={() => setView({ mode: option.value })}
                  title={option.label}
                >
                  <Icon name={option.icon} size={15} />
                  {option.label}
                </button>
              ),
            )}
          </div>

          {canUse3d && !reducedMotion ? (
            <button
              className="btn btn-ghost graph-autorotate"
              type="button"
              aria-pressed={autoRotate}
              onClick={() => setAutoRotate((current) => !current)}
              title={autoRotate ? "停止自动旋转" : "让星系缓慢自转"}
            >
              <Icon name="refresh" size={15} />
              自动旋转
            </button>
          ) : null}

          <button
            className="btn btn-ghost graph-refresh"
            type="button"
            onClick={() => void refreshAll()}
            aria-label="刷新进度"
          >
            <Icon name="refresh" size={16} />
            刷新
          </button>
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => void handleSync()}
            disabled={syncing}
          >
            <Icon name="sparkles" size={16} />
            {syncing ? "正在同步…" : "同步内容"}
          </button>
        </div>
      </section>

      {syncNote ? (
        <p className="graph-note" role="status">
          {syncNote}
        </p>
      ) : null}
      {serviceError ? (
        <p className="graph-note graph-note-error" role="alert">
          {serviceError}
        </p>
      ) : null}
      {graphError && subgraph ? (
        <p className="graph-note graph-note-error" role="alert">
          新的邻域没有加载成功：{graphError}
          <button className="text-link graph-inline-action" type="button" onClick={retryGraph}>
            重试
          </button>
        </p>
      ) : null}
      {sceneError ? (
        <p className="graph-note graph-note-error" role="alert">
          {sceneError}
          <button className="text-link graph-inline-action" type="button" onClick={() => setView({ mode: "2d" })}>
            切到 2D
          </button>
        </p>
      ) : null}

      {status && status.failed.length > 0 ? (
        <details className="graph-failures">
          <summary>
            <span className="graph-chip graph-chip-warn">
              <Icon name="alert" size={13} />
              {status.failed.length} 个对象抽取失败
            </span>
          </summary>
          <ul>
            {status.failed.map((failure) => (
              <li key={failure.objectId}>
                <Link className="text-link" href={`/workspace/${failure.objectId}`}>
                  {failure.objectId.slice(0, 8)}
                </Link>
                <span>{failure.error || "没有返回错误信息"}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="graph-layout">
        <section className="panel graph-main" aria-label="图谱视图">
          <div className="graph-stage-head">
            <div>
              <h2>
                {displayCenter ? `${labelOf(displayCenter) || displayCenter} 的邻域` : "图谱视图"}
              </h2>
              <p>
                {view.meta.total} 个实体 · {view.edges.length} 条关系
                {hiddenNodes > 0 ? ` · 另有 ${hiddenNodes} 个实体未显示` : ""}
                {view.meta.truncated ? ` · 可能只显示了最近 ${maxNodes} 个` : ""}
              </p>
            </div>
            <span className="meta-chip">
              {modeLabel(mode)} · {tier}
            </span>
          </div>

          {pathPick ? (
            <div className="graph-path-bar" role="status">
              <span>选择路径的另一端…</span>
              <button className="text-link" type="button" onClick={() => setPathPick(false)}>
                取消
              </button>
            </div>
          ) : pathVisible ? (
            <div className={`graph-path-bar${pathHops === null ? " is-missing" : ""}`} role="status">
              <span>
                {labelOf(activeSelectedId)} → {labelOf(activePathTo)}
                {pathHops === null ? " · 没有通路" : ` · ${pathHops} 跳`}
              </span>
              <button
                className="text-link"
                type="button"
                onClick={() => {
                  setPathTo(null);
                  setAnnouncement("已清除路径");
                }}
              >
                清除
              </button>
            </div>
          ) : null}

          {graphLoading && !subgraph ? (
            <div className="graph-state-card" role="status">
              <p className="graph-state-title">正在读取图谱…</p>
              <p>第一次展开邻域需要一点时间，稍等。</p>
            </div>
          ) : graphError && !subgraph ? (
            <div className="graph-state-card is-error" role="alert">
              <p className="graph-state-title">图谱没有加载出来</p>
              <p>{graphError}</p>
              <div className="graph-state-actions">
                <button className="btn btn-secondary" type="button" onClick={retryGraph}>
                  重试
                </button>
                <button className="btn btn-ghost" type="button" onClick={() => void refreshAll()}>
                  刷新进度
                </button>
              </div>
            </div>
          ) : statusUnknown ? (
            <div className="graph-state-card is-error">
              <p className="graph-state-title">图谱状态暂时读不到</p>
              <p>暂时无法确认图谱里有没有内容：状态接口没有响应。可以重试，或先同步一次内容。</p>
              <div className="graph-state-actions">
                <button className="btn btn-secondary" type="button" onClick={() => void refreshAll()}>
                  重试
                </button>
                <button
                  className="btn btn-ghost"
                  type="button"
                  onClick={() => void handleSync()}
                  disabled={syncing}
                >
                  {syncing ? "正在同步…" : "同步内容"}
                </button>
              </div>
            </div>
          ) : zeroContent ? (
            <div className="graph-state-card">
              <p className="graph-state-title">图谱还是空的</p>
              <p>同步一次内容，系统会从对象正文里抽出实体和关系；只对本账号可见。</p>
              <ol className="graph-state-steps">
                <li>点「同步内容」，把资产与作品送进图谱</li>
                <li>抽取在本机后台进行，进度会自动刷新</li>
                <li>完成后这里出现可以点选、聚焦的实体图</li>
              </ol>
              <div className="graph-state-actions">
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => void handleSync()}
                  disabled={syncing}
                >
                  <Icon name="sparkles" size={16} />
                  {syncing ? "正在同步…" : "同步内容到图谱"}
                </button>
                <button className="btn btn-ghost" type="button" onClick={() => void refreshAll()}>
                  刷新进度
                </button>
              </div>
            </div>
          ) : noEntities ? (
            <div className="graph-state-card">
              <p className="graph-state-title">还没有抽取到实体</p>
              <p>
                已同步 {status?.total ?? 0} 个内容
                {working ? `，还有 ${workingCount} 个在排队或抽取。` : "，抽取完成后这里会出现实体。"}
              </p>
              <div className="graph-state-actions">
                <button className="btn btn-secondary" type="button" onClick={() => void refreshAll()}>
                  刷新进度
                </button>
                <button
                  className="btn btn-ghost"
                  type="button"
                  onClick={() => void handleSync()}
                  disabled={syncing}
                >
                  再同步一次
                </button>
              </div>
            </div>
          ) : noNeighborhood ? (
            <div className="graph-state-card">
              <p className="graph-state-title">「{focus}」还没有可展开的邻居</p>
              <p>这个实体可能刚被抽取、关系还没生成；也可以扩大邻域或换一个中心。</p>
              <div className="graph-state-actions">
                {depth < 3 ? (
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={() => setView({ depth: (depth + 1) as GraphHop })}
                  >
                    展开到 {depth + 1} 层
                  </button>
                ) : null}
                {otherLabel ? (
                  <button className="btn btn-ghost" type="button" onClick={() => setView({ focus: otherLabel })}>
                    换一个实体
                  </button>
                ) : null}
                <button className="btn btn-ghost" type="button" onClick={() => void refreshAll()}>
                  刷新进度
                </button>
              </div>
            </div>
          ) : mode === "list" ? (
            <GraphListView
              view={view}
              selectedId={activeSelectedId}
              focusId={focus}
              onSelect={selectEntity}
              onFocus={focusEntity}
            />
          ) : mode === "3d" ? (
            // 3D 只读抽稀后的视图；2D / 列表 / 详情栏仍用完整 view。
            <GraphScene3D
              view={renderView}
              highlight={highlight}
              tier={tier}
              autoRotate={autoRotate && !reducedMotion}
              onIntent={handleIntent}
              onReady={handleReady}
              onStats={handleStats}
              onError={handleSceneError}
            />
          ) : (
            <>
              <div className={`graph-stage-wrap${graphError ? " is-stale" : ""}`}>
                <GraphStage2D
                  view={view}
                  highlight={highlight}
                  selectedId={activeSelectedId}
                  focusId={displayCenter}
                  onSelect={handleSelect}
                  onFocus={handleFocus}
                  onHover={handleHover}
                />
                {graphLoading ? (
                  <div className="graph-stage-loading" role="status">
                    正在载入 {labelOf(focus) || focus} 的邻域…
                  </div>
                ) : null}
              </div>
              {orphanFocused ? (
                <p className="graph-orphan-note">
                  这个实体还没有已抽取的关系，先把相关内容同步完整再来看看。
                  {otherLabel ? (
                    <button className="text-link" type="button" onClick={() => setView({ focus: otherLabel })}>
                      换一个实体
                    </button>
                  ) : null}
                </p>
              ) : null}
            </>
          )}

          <p className="sr-only" role="status" aria-live="polite">
            {announcement}
          </p>
        </section>

        <aside className="panel graph-inspector" aria-label="实体详情">
          {selectedNode ? (
            <div className="graph-inspector-body">
              <div className="graph-inspector-head">
                <span
                  className="graph-type-badge"
                  style={{ borderLeftColor: `var(${ENTITY_STYLE[selectedNode.type].colorToken})` }}
                >
                  {ENTITY_STYLE[selectedNode.type].labelZh}
                </span>
                <h2>{selectedNode.label}</h2>
                <p className="graph-inspector-meta">
                  {selectedNode.rawType || "未标注类型"} · 度数 {selectedNode.degree} ·{" "}
                  {selectedNode.hop === 0
                    ? "当前中心"
                    : selectedNode.hop === 3
                      ? "未连到中心"
                      : `${selectedNode.hop} 跳`}
                </p>
              </div>

              <div className="graph-inspector-actions">
                {selectedNode.flags.isCenter ? (
                  <span className="meta-chip">已以它为中心</span>
                ) : (
                  <button className="btn btn-secondary" type="button" onClick={() => focusEntity(selectedNode.id)}>
                    以它为中心
                  </button>
                )}
                <button
                  className="btn btn-ghost"
                  type="button"
                  onClick={() => {
                    setPathPick(true);
                    setAnnouncement("请选择路径的另一端");
                  }}
                  disabled={relations.length === 0}
                >
                  查看路径
                </button>
                <button
                  className="btn btn-ghost"
                  type="button"
                  onClick={() => handleSelect(null)}
                >
                  取消选中
                </button>
              </div>

              <section className="graph-inspector-section">
                <h3>
                  关系 <span className="graph-count">{relations.length}</span>
                </h3>
                {relations.length === 0 ? (
                  <p className="graph-inspector-empty-text">还没有已抽取的关系。</p>
                ) : (
                  <ul className="graph-relations">
                    {relations.slice(0, RELATION_LIMIT).map(({ edge, other }) => (
                      <li key={edge.id}>
                        <div className="graph-relation-head">
                          <button
                            className="graph-relation-other"
                            type="button"
                            onClick={() => handleSelect(other.id)}
                            title={other.label}
                          >
                            <span
                              className="graph-list-glyph"
                              data-shape={other.shape}
                              style={{ color: `var(${other.colorToken})` }}
                              aria-hidden="true"
                            />
                            {other.label}
                          </button>
                          <span className="graph-relation-type">
                            {edge.type}
                            {edge.weight > 1 ? ` ×${edge.weight}` : ""}
                          </span>
                          <button
                            className="text-link graph-relation-path"
                            type="button"
                            onClick={() => {
                              setSelectedId(selectedNode.id);
                              setPathTo(other.id);
                              setPathPick(false);
                              setAnnouncement(`正在显示到 ${other.label} 的路径`);
                            }}
                          >
                            路径
                          </button>
                        </div>
                        <p className="graph-relation-text">{edge.description || "（没有关系原文）"}</p>
                      </li>
                    ))}
                  </ul>
                )}
                {relations.length > RELATION_LIMIT ? (
                  <p className="graph-inspector-empty-text">
                    还有 {relations.length - RELATION_LIMIT} 条关系未列出，可在图中继续点选。
                  </p>
                ) : null}
              </section>

              <section className="graph-inspector-section">
                <h3>来源</h3>
                <p className="graph-source-line">图谱抽取结果（LightRAG）</p>
                {selectedReferences.length > 0 ? (
                  <>
                    <p className="graph-source-line">最近一次提问引用：</p>
                    <ul className="graph-source-list">
                      {selectedReferences.map((reference) => (
                        <li key={reference.objectId}>
                          <Link className="text-link" href={`/workspace/${reference.objectId}`}>
                            {reference.title}
                            <Icon name="arrow-right" size={13} />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {!selectedNode.flags.hasDescription ? (
                  <p className="graph-inspector-empty-text">这个实体还没有生成描述。</p>
                ) : null}
              </section>

              <p className="graph-inspector-tip">Shift + 单击另一个实体，可以直接连线看路径。</p>
            </div>
          ) : (
            <div className="graph-inspector-empty">
              <h2>实体详情</h2>
              <p>在图中点一个实体，这里显示它的类型、关系原文与来源。</p>
              <ul className="graph-legend">
                <li>
                  <span className="graph-dot" aria-hidden="true" /> 单击选中
                </li>
                <li>
                  <span className="graph-dot" aria-hidden="true" /> 双击设为中心
                </li>
                <li>
                  <span className="graph-dot" aria-hidden="true" /> Shift + 单击看路径
                </li>
              </ul>
            </div>
          )}
        </aside>
      </div>

      <section className="panel graph-qa" id="graph-qa" aria-label="图谱问答">
        <div className="panel-heading">
          <div>
            <h2>问图谱</h2>
            <p>回答会同时参考图谱关系与内容片段，并标出来源对象；点实体胶囊可以直接定位。</p>
          </div>
        </div>
        <form className="graph-qa-form" onSubmit={(event) => void ask(event)}>
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="例如：设计系统里品牌色是怎么定义的？"
            rows={2}
            maxLength={200}
            aria-label="图谱问题"
            disabled={asking}
          />
          <button className="btn btn-primary" type="submit" disabled={asking || !question.trim()}>
            {asking ? "思考中…" : "提问"}
          </button>
        </form>

        {asking ? (
          <p className="graph-qa-hint">本机模型逐字生成答案，通常需要十几秒到一分多钟。</p>
        ) : null}

        {answerError ? (
          <p className="graph-note graph-note-error" role="alert">
            {answerError}
          </p>
        ) : null}

        {answer ? (
          <div className="graph-answer">
            <p className="graph-answer-question">{answer.question}</p>
            <div className="graph-answer-text">
              {answer.response ? (
                <AnswerText
                  text={answer.response}
                  view={view}
                  onPick={(id) => {
                    setSelectedId(id);
                    handleFocus(id);
                  }}
                />
              ) : (
                "图谱没有给出回答。"
              )}
            </div>
            {answer.references.length > 0 ? (
              <div className="graph-answer-refs">
                <p className="graph-answer-refs-title">来源对象</p>
                <ul>
                  {answer.references.map((ref) => (
                    <li key={ref.objectId}>
                      <Link className="text-link" href={`/workspace/${ref.objectId}`}>
                        {ref.title}
                        <Icon name="arrow-right" size={13} />
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function GraphListView({
  view,
  selectedId,
  focusId,
  onSelect,
  onFocus,
}: {
  view: GraphViewModel;
  selectedId: string | null;
  focusId: string | null;
  onSelect: (id: string) => void;
  onFocus: (id: string) => void;
}) {
  const [filter, setFilter] = useState("");

  const rows = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    if (!keyword) return view.nodes;
    return view.nodes.filter(
      (node) =>
        node.label.toLowerCase().includes(keyword) ||
        ENTITY_STYLE[node.type].labelZh.includes(keyword) ||
        node.rawType.toLowerCase().includes(keyword),
    );
  }, [filter, view]);

  return (
    <div className="graph-list">
      <label className="graph-list-filter">
        <Icon name="search" size={15} />
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="筛选实体或类型"
          aria-label="筛选实体"
        />
      </label>
      <p className="graph-list-count" aria-live="polite">
        {rows.length} / {view.nodes.length} 个实体
      </p>
      {rows.length === 0 ? (
        <p className="graph-inspector-empty-text">没有匹配「{filter.trim()}」的实体。</p>
      ) : (
        <ul className="graph-list-rows">
          {rows.map((node) => (
            <li key={node.id}>
              <button
                className={`graph-list-row${selectedId === node.id ? " is-selected" : ""}`}
                type="button"
                aria-pressed={selectedId === node.id}
                onClick={() => onSelect(node.id)}
              >
                <span
                  className="graph-list-glyph"
                  data-shape={node.shape}
                  style={{ color: `var(${node.colorToken})` }}
                  aria-hidden="true"
                />
                <span className="graph-list-label">{node.label}</span>
                <span className="graph-list-type">{ENTITY_STYLE[node.type].labelZh}</span>
                <span className="graph-list-degree">{node.degree} 条关系</span>
                <span className="graph-list-hop">
                  {node.hop === 0 ? "中心" : node.hop === 3 ? "未连通" : `${node.hop} 跳`}
                </span>
              </button>
              {focusId === node.id ? (
                <span className="meta-chip graph-list-center">中心</span>
              ) : (
                <button className="text-link graph-list-focus" type="button" onClick={() => onFocus(node.id)}>
                  设为中心
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AnswerText({
  text,
  view,
  onPick,
}: {
  text: string;
  view: GraphViewModel;
  onPick: (id: string) => void;
}) {
  const segments = useMemo(() => {
    const candidates = view.nodes
      .filter((node) => node.label.length >= 2)
      .sort((a, b) => b.label.length - a.label.length);
    const output: Array<{ type: "text"; text: string } | { type: "node"; id: string; label: string }> = [];
    let buffer = "";
    let index = 0;
    while (index < text.length) {
      const hit = candidates.find((node) => text.startsWith(node.label, index));
      if (hit) {
        if (buffer) {
          output.push({ type: "text", text: buffer });
          buffer = "";
        }
        output.push({ type: "node", id: hit.id, label: hit.label });
        index += hit.label.length;
      } else {
        buffer += text[index];
        index += 1;
      }
    }
    if (buffer) output.push({ type: "text", text: buffer });
    return output;
  }, [text, view]);

  return (
    <>
      {segments.map((segment, index) =>
        segment.type === "text" ? (
          <span key={index}>{segment.text}</span>
        ) : (
          <button
            key={index}
            className="graph-entity-chip"
            type="button"
            onClick={() => onPick(segment.id)}
            title={`定位到 ${segment.label}`}
          >
            {segment.label}
          </button>
        ),
      )}
    </>
  );
}

export { EMPTY_HIGHLIGHT };
