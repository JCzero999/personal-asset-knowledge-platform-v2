"use client";

/**
 * 3D 星系视图（ADR-022 附录 A7 / A8，2026-11-13；B 线真实渲染，替换原桩）。
 *
 * 本文件是**外壳**，刻意保持 three-free：
 * - 布局调度：≤300 节点主线程算，>300 节点走 Worker（`src/workers/graph-layout.worker.ts`，
 *   自带 400ms tick 预算）；切换视图时 `cancel` 丢弃未开始的请求，只采纳最后一条；
 * - 缓存：`layoutSeedKey` = 稳定 id 集合哈希 + focus + depth + `GALAXY_LAYOUT_VERSION`；
 *   重排时把上一版共有节点的坐标作为 `anchors` 传下去，换中心不整图跳变；
 * - WebGL 探测、动态 import 失败（`chunk-failed`）、运行期 context lost 的映射；
 * - 空图 / 单点 / 全不可达的深色空态（0 节点不创建 Canvas）。
 *
 * 真正的 WebGL 运行时在 `./starfield` 里，用 `next/dynamic({ ssr: false })` 懒加载——
 * 这样 three 打包失败会以 rejected import 的形式落到错误边界，而不是在模块顶层炸掉。
 */

import dynamic from "next/dynamic";
import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { GraphViewModel } from "@/lib/graph-model";
import {
  layoutGalaxy3d,
  type GalaxyLayoutOptions,
  type GalaxyLayoutResult,
} from "@/lib/graph-layout-3d";
import { resolveGraphDpr, type QualityTier } from "@/lib/graph-quality";
import type { GraphHighlight } from "@/lib/graph-selectors";
import {
  LAYOUT_CACHE_LIMIT,
  anchorsFromResult,
  layoutSeedKey,
  shouldUseWorker,
} from "@/lib/graph-render";
import type {
  LayoutInboundMessage,
  LayoutOutboundMessage,
} from "@/workers/graph-layout.worker";

/** ADR-022 A4：渲染器只往上抛意图，不改图状态。 */
export type GraphIntent = "select" | "focus" | "hover" | "toggle-mode" | "change-depth";

export interface GraphScene3DProps {
  readonly view: GraphViewModel;
  readonly highlight: GraphHighlight;
  readonly tier: QualityTier;
  /** 默认 false；reduced-motion 下入口不出现（由容器判定）。 */
  readonly autoRotate: boolean;
  readonly onIntent: (intent: GraphIntent, id?: string) => void;
  /** 布局完成并画出首帧时调用一次。 */
  readonly onReady: (stats: {
    layoutMs: number;
    layoutTicks: number;
    truncated: boolean;
    drawCalls: number;
  }) => void;
  /** 运行时读数，每 30 帧发布一次；桩只发一次全零读数。 */
  readonly onStats: (stats: {
    frames: number;
    avgFrameMs: number;
    labels: number;
    drawCalls: number;
    dpr: number;
    rafActive: boolean;
    layoutTicks: number;
    truncated: boolean;
  }) => void;
  readonly onError: (reason: "context-lost" | "chunk-failed" | "webgl-unavailable") => void;
}

const EMPTY_STATS = {
  frames: 0,
  avgFrameMs: 0,
  labels: 0,
  drawCalls: 0,
  dpr: 1,
  rafActive: false,
  layoutTicks: 0,
  truncated: false,
} as const;

type SceneErrorReason = "context-lost" | "chunk-failed" | "webgl-unavailable";

/**
 * 布局缓存放在模块级：切到 2D 再切回来、或在同一页里改选中，都不必重算。
 * 键已含 `GALAXY_LAYOUT_VERSION`，算法改动后旧条目自然不会再命中。
 */
const layoutCache = new Map<string, GalaxyLayoutResult>();

/** 渲染期只做纯读，不改 Map 顺序（React 可能重复渲染，读不能有副作用）。 */
function peekCachedLayout(key: string): GalaxyLayoutResult | null {
  return layoutCache.get(key) ?? null;
}

/** 命中后把它挪到队尾：淘汰从最旧开始，只保留 8 条。 */
function touchCachedLayout(key: string): void {
  const hit = layoutCache.get(key);
  if (!hit) return;
  layoutCache.delete(key);
  layoutCache.set(key, hit);
}

function writeCachedLayout(key: string, result: GalaxyLayoutResult): void {
  layoutCache.delete(key);
  layoutCache.set(key, result);
  while (layoutCache.size > LAYOUT_CACHE_LIMIT) {
    const oldest = layoutCache.keys().next();
    if (oldest.done) break;
    layoutCache.delete(oldest.value);
  }
}

/** 探测一次 WebGL（不保留上下文）；失败时整个 3D 分支不挂 Canvas。 */
function probeWebgl(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const context =
      canvas.getContext("webgl2") ??
      canvas.getContext("webgl") ??
      canvas.getContext("experimental-webgl");
    if (!context) return false;
    const lose = (context as WebGLRenderingContext).getExtension("WEBGL_lose_context");
    lose?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** 动态 import 失败与 WebGL 初始化失败用不同的运行时异常文本，这里保守区分。 */
function classifySceneError(message: string): SceneErrorReason {
  if (/webgl|context/i.test(message)) return "webgl-unavailable";
  return "chunk-failed";
}

const GalaxyCanvas3D = dynamic(
  () => import("./starfield").then((module) => module.GalaxyCanvas3D),
  {
    ssr: false,
    loading: () => (
      <div className="g3-stub" data-surface="graph" data-mode="3d">
        <p className="g3-stub-title">正在准备星系视图…</p>
        <p className="g3-stub-note">首次进入要加载 WebGL 运行时，随后由浏览器缓存。</p>
      </div>
    ),
  },
);

interface SceneBoundaryProps {
  readonly children: ReactNode;
  readonly onError: (reason: SceneErrorReason) => void;
  readonly fallback: ReactNode;
}

interface SceneBoundaryState {
  readonly failed: boolean;
}

class SceneErrorBoundary extends Component<SceneBoundaryProps, SceneBoundaryState> {
  state: SceneBoundaryState = { failed: false };

  static getDerivedStateFromError(): SceneBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    this.props.onError(classifySceneError(error?.message ?? ""));
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export default function GraphScene3D({
  view,
  highlight,
  tier,
  autoRotate,
  onIntent,
  onReady,
  onStats,
  onError,
}: GraphScene3DProps) {
  const [produced, setProduced] = useState<{
    readonly key: string;
    readonly result: GalaxyLayoutResult;
  } | null>(null);
  const [previousLayout, setPreviousLayout] = useState<GalaxyLayoutResult | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [fatal, setFatal] = useState<SceneErrorReason | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [webglAvailable] = useState(() => probeWebgl());
  // 设备像素比不是 React 状态：档位决定上限，读一次即可（窗口跨屏拖动时浏览器会重排）。
  const dpr = resolveGraphDpr(
    tier,
    typeof window === "undefined" ? 1 : window.devicePixelRatio,
  );

  const seedKey = useMemo(() => layoutSeedKey(view), [view]);
  const requestCounterRef = useRef(0);
  const workerRef = useRef<Worker | null>(null);
  const pendingWorkerRef = useRef<{
    readonly id: number;
    readonly adopt: (result: GalaxyLayoutResult) => void;
    readonly fallback: () => void;
  } | null>(null);
  const workerFailedRef = useRef(false);
  const onErrorRef = useRef(onError);

  /**
   * 命中缓存就在渲染期直接取（纯读，不动 LRU）；没命中时先沿用上一版布局
   * （换中心期间旧图继续可见），新结果算完再替换。空图不渲染任何布局。
   */
  const cachedLayout = useMemo(() => peekCachedLayout(seedKey), [seedKey]);
  const layout =
    view.nodes.length === 0
      ? null
      : (cachedLayout ??
        (produced && produced.key === seedKey ? produced.result : null) ??
        previousLayout);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const reportError = useCallback((reason: SceneErrorReason) => {
    setFatal(reason);
    onErrorRef.current(reason);
  }, []);

  // 只在挂载时探测一次；探测失败要让容器知道，但不必进 state（渲染分支直接看 webglAvailable）。
  const webglReportedRef = useRef(false);
  useEffect(() => {
    if (webglAvailable || webglReportedRef.current) return;
    webglReportedRef.current = true;
    onErrorRef.current("webgl-unavailable");
  }, [webglAvailable]);

  /* ---- Worker：懒创建，一个场景一个；卸载时终止 ---- */
  const ensureWorker = useCallback((): Worker | null => {
    if (workerRef.current) return workerRef.current;
    if (workerFailedRef.current) return null;
    if (typeof Worker === "undefined") {
      workerFailedRef.current = true;
      return null;
    }
    try {
      const worker = new Worker(
        // 本文件在 `src/components/graph/`，Worker 在 `src/workers/`：要退两层。
        // 少一层会解析成 `src/components/workers`，dev 下 `Module not found`，
        // >300 节点的场景会建 Worker 失败并回落主线程。
        new URL("../../workers/graph-layout.worker.ts", import.meta.url),
        { type: "module", name: "graph-layout" },
      );

      worker.addEventListener("message", (event: MessageEvent<LayoutOutboundMessage>) => {
        const pending = pendingWorkerRef.current;
        if (!pending) return;
        const data = event.data;
        if (data?.type === "done") {
          pendingWorkerRef.current = null;
          pending.adopt(data.result);
        } else if (data?.type === "error") {
          pendingWorkerRef.current = null;
          setLayoutError(data.message);
        }
        // `cancelled` 是旧请求被新请求顶掉时的回执，等新请求的 done 即可。
      });

      worker.addEventListener("error", () => {
        // Worker 脚本本身加载失败（chunk 404 / 语法错误）：终止并把当前请求降级到主线程。
        workerFailedRef.current = true;
        worker.terminate();
        if (workerRef.current === worker) workerRef.current = null;
        const pending = pendingWorkerRef.current;
        pendingWorkerRef.current = null;
        onErrorRef.current("chunk-failed");
        pending?.fallback();
      });

      workerRef.current = worker;
      return worker;
    } catch {
      workerFailedRef.current = true;
      onErrorRef.current("chunk-failed");
      return null;
    }
  }, []);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
      pendingWorkerRef.current = null;
    };
  }, []);

  /* ---- 布局调度 ---- */
  useEffect(() => {
    if (view.nodes.length === 0) return;

    const cached = peekCachedLayout(seedKey);
    if (cached) {
      touchCachedLayout(seedKey);
      return;
    }
    if (produced && produced.key === seedKey) return;

    const anchors = layout && layout.ids.length > 0 ? anchorsFromResult(layout, view) : undefined;
    const options: GalaxyLayoutOptions = { seedKey, anchors };
    const requestId = requestCounterRef.current + 1;
    requestCounterRef.current = requestId;
    let disposed = false;

    const adopt = (result: GalaxyLayoutResult): void => {
      if (disposed || requestCounterRef.current !== requestId) return;
      writeCachedLayout(seedKey, result);
      setPreviousLayout(result);
      setProduced({ key: seedKey, result });
      setLayoutError(null);
    };

    const runSync = (): void => {
      try {
        adopt(layoutGalaxy3d(view, options));
      } catch (error) {
        if (disposed || requestCounterRef.current !== requestId) return;
        setLayoutError(error instanceof Error ? error.message : String(error));
      }
    };

    if (shouldUseWorker(view.nodes.length)) {
      const worker = ensureWorker();
      if (worker) {
        pendingWorkerRef.current = { id: requestId, adopt, fallback: runSync };
        const message: LayoutInboundMessage = { type: "layout", view, options };
        worker.postMessage(message);
        return () => {
          disposed = true;
          // 只丢弃还没开始的请求；已经在跑的由 Worker 的 400ms 预算兜底。
          if (requestCounterRef.current === requestId) {
            const cancel: LayoutInboundMessage = { type: "cancel" };
            worker.postMessage(cancel);
          }
        };
      }
    }

    // ≤300 节点（或 Worker 不可用时的降级）：主线程同步算。300 节点以内是毫秒级。
    runSync();
    return () => {
      disposed = true;
    };
  }, [view, seedKey, ensureWorker, attempt, produced, layout]);

  /* ---- 空图也要给容器一个终态，避免「永远等 onReady」 ---- */
  const reportedEmptyRef = useRef<string | null>(null);
  useEffect(() => {
    if (view.nodes.length > 0) {
      reportedEmptyRef.current = null;
      return;
    }
    if (reportedEmptyRef.current === seedKey) return;
    reportedEmptyRef.current = seedKey;
    onReady({ layoutMs: 0, layoutTicks: 0, truncated: false, drawCalls: 0 });
    onStats(EMPTY_STATS);
  }, [view, seedKey, onReady, onStats]);

  const handleSceneReady = useCallback(
    (stats: {
      layoutMs: number;
      layoutTicks: number;
      truncated: boolean;
      drawCalls: number;
    }) => {
      reportedEmptyRef.current = null;
      onReady(stats);
    },
    [onReady],
  );

  const handleSceneError = useCallback(
    (reason: SceneErrorReason) => {
      reportError(reason);
    },
    [reportError],
  );

  const retry = useCallback(() => {
    setFatal(null);
    setLayoutError(null);
    setAttempt((value) => value + 1);
    workerFailedRef.current = false;
    workerRef.current?.terminate();
    workerRef.current = null;
    pendingWorkerRef.current = null;
  }, []);

  /* ---- 空态 / 不可用态（都不挂 Canvas，保持深色底） ---- */
  if (!webglAvailable || fatal) {
    return (
      <div className="g3-stub" data-surface="graph" data-mode="3d">
        <p className="g3-stub-title">这个环境暂时画不了 3D 星系</p>
        <p className="g3-stub-note">
          {fatal === "chunk-failed"
            ? "WebGL 运行时没有加载成功，可能是网络中断或浏览器拦截了脚本。"
            : fatal === "context-lost"
              ? "显卡上下文被系统回收了，刷新页面可以恢复。"
              : "浏览器没有可用的 WebGL 上下文（可能关闭了硬件加速）。"}
          2D 聚焦阅读与列表不受影响。
        </p>
        <button className="btn btn-secondary" type="button" onClick={() => onIntent("toggle-mode")}>
          切到 2D 聚焦阅读
        </button>
      </div>
    );
  }

  if (view.nodes.length === 0) {
    return (
      <div className="g3-stub" data-surface="graph" data-mode="3d">
        <p className="g3-stub-title">这张图暂时没有可显示的实体</p>
        <p className="g3-stub-note">换个中心、扩大邻域，或者等抽取完成后再回来。</p>
        <button className="btn btn-secondary" type="button" onClick={() => onIntent("toggle-mode")}>
          切到 2D 聚焦阅读
        </button>
      </div>
    );
  }

  if (!layout) {
    return (
      <div className="g3-stub" data-surface="graph" data-mode="3d">
        <p className="g3-stub-title">{layoutError ? "布局没有算出来" : "正在铺开星系…"}</p>
        <p className="g3-stub-note">
          {layoutError ?? `${view.nodes.length} 个实体、${view.edges.length} 条关系正在定位。`}
        </p>
        {layoutError ? (
          <button className="btn btn-secondary" type="button" onClick={retry}>
            重试
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="graph-stage-wrap"
      data-surface="graph"
      data-mode="3d"
      aria-label={`3D 星系视图，${view.nodes.length} 个实体、${view.edges.length} 条关系`}
    >
      <div className="g2-stage">
        <SceneErrorBoundary
          key={attempt}
          onError={handleSceneError}
          fallback={
            <div className="g3-stub" data-surface="graph" data-mode="3d">
              <p className="g3-stub-title">星系视图加载失败</p>
              <p className="g3-stub-note">渲染模块没有起来，2D 聚焦阅读仍可用。</p>
              <button className="btn btn-secondary" type="button" onClick={retry}>
                重试
              </button>
            </div>
          }
        >
          <GalaxyCanvas3D
            view={view}
            highlight={highlight}
            layout={layout}
            tier={tier}
            autoRotate={autoRotate}
            dpr={dpr}
            onIntent={onIntent}
            onReady={handleSceneReady}
            onStats={onStats}
            onError={handleSceneError}
          />
        </SceneErrorBoundary>
      </div>
      <p className="sr-only">
        拖拽旋转，滚轮缩放；单击选中，双击设为中心。键盘用户可在 2D 聚焦阅读里完成同样的操作。
      </p>
    </div>
  );
}
