"use client";

/**
 * 3D 场景的 WebGL 运行时根（B 线；单独成模块是为了让 `graph-scene-3d.tsx` 保持
 * three-free，从而能捕获动态 import 失败并回调 `onError("chunk-failed")`）。
 *
 * 这一层负责：Canvas / 相机 / OrbitControls / 星场 / 旋转组 / 指针拾取 / 帧读数。
 * 场景分层与 draw call 预算（合计 ≤8）：
 *   星场 1 + 光晕 1 + 节点 1 + 边 3 + 标签 1 + 选中环 1。
 *
 * 帧循环是 `frameloop="demand"`：只有 invalidate（相机、选中、布局、自转）才出帧，
 * 空闲时零帧；`autoRotate` 由 props 驱动，关闭后立刻 invalidate 一次再停。
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  Color,
  NoToneMapping,
  SRGBColorSpace,
  Vector3,
  type Group,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { GraphViewModel } from "@/lib/graph-model";
import type { GalaxyLayoutResult } from "@/lib/graph-layout-3d";
import {
  GALAXY_CAMERA_DIRECTION,
  GALAXY_CAMERA_FALLBACK_DISTANCE,
  GALAXY_CAMERA_HARD_MAX_DISTANCE,
  GALAXY_CAMERA_MAX_DISTANCE,
  GALAXY_CAMERA_MIN_DISTANCE,
  GALAXY_FOV_DEGREES,
  fitGalaxyCamera,
  rescaleForViewport,
  type GalaxyFraming,
} from "@/lib/graph-camera";
import type { QualityTier } from "@/lib/graph-quality";
import type { GraphHighlight } from "@/lib/graph-selectors";
import {
  createStarfieldPositions,
  inferAnchorNode,
  readGraphPalette,
  rgbaToLinear,
  visualRadius,
  type GraphPalette,
} from "@/lib/graph-render";

import { EdgeField } from "./edge-field";
import { LabelLayer, pickFontFamily } from "./label-layer";
import { HaloLayer, NodeField, SelectionRing } from "./node-field";

export type SceneIntent = "select" | "focus" | "hover" | "toggle-mode" | "change-depth";

export interface GalaxyCanvas3DProps {
  readonly view: GraphViewModel;
  readonly highlight: GraphHighlight;
  readonly layout: GalaxyLayoutResult;
  readonly tier: QualityTier;
  readonly autoRotate: boolean;
  readonly dpr: number;
  readonly onIntent: (intent: SceneIntent, id?: string) => void;
  readonly onReady: (stats: {
    layoutMs: number;
    layoutTicks: number;
    truncated: boolean;
    drawCalls: number;
  }) => void;
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

// ADR-022 的初始机位是 [0,160,620]；验收要求「星系主体占舞台 75–85%」，
// 620 的机位实测亮部包围盒只有 ~66%×70%，按同一视线方向推近 1.13 倍（620 → 550）。
// fov / near / far、OrbitControls 的 120–1100 距离范围均未改动。
//
// 2026-11-13：画布从固定卡片改为铺满内容区后，宽高比随容器变化，写死的距离不再成立
// （宽屏显得小、窄屏两翼被裁）。视线方向（俯角 14.48°）和上面这次 1.13 倍的观感保留为
// **兜底机位** 568；真正的距离在布局算完后由 `CameraFraming` 按容器宽高比求值。
const FOV = GALAXY_FOV_DEGREES;
const CAMERA_POSITION: readonly [number, number, number] = [
  GALAXY_CAMERA_DIRECTION[0] * GALAXY_CAMERA_FALLBACK_DISTANCE,
  GALAXY_CAMERA_DIRECTION[1] * GALAXY_CAMERA_FALLBACK_DISTANCE,
  GALAXY_CAMERA_DIRECTION[2] * GALAXY_CAMERA_FALLBACK_DISTANCE,
];
/** 0.55°/s ≈ 0.0096 rad/s；按 delta 积分，和帧率无关。 */
const AUTO_ROTATE_RADS_PER_SECOND = 0.0096;

export function GalaxyCanvas3D({
  view,
  highlight,
  layout,
  tier,
  autoRotate,
  dpr,
  onIntent,
  onReady,
  onStats,
  onError,
}: GalaxyCanvas3DProps) {
  const host = useMemo(
    () => (typeof document === "undefined" ? null : (document.querySelector('[data-surface="graph"]') as HTMLElement | null)),
    [],
  );
  const palette = useMemo(() => readGraphPalette(host), [host]);
  const fontFamily = useMemo(() => pickFontFamily(host), [host]);
  const anchorId = useMemo(() => inferAnchorNode(view, highlight), [view, highlight]);

  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const contextLost = useRef(false);

  const handleCreated = useCallback(
    ({ gl }: { gl: import("three").WebGLRenderer }) => {
      const canvasColor = new Color().setRGB(
        palette.canvas[0],
        palette.canvas[1],
        palette.canvas[2],
        SRGBColorSpace,
      );
      gl.setClearColor(canvasColor, 1);
      gl.outputColorSpace = SRGBColorSpace;
      gl.toneMapping = NoToneMapping;

      const onLost = (event: Event): void => {
        event.preventDefault();
        // R3F 卸载 Canvas 时会主动 forceContextLoss()，同样会派发 webglcontextlost。
        // 那不是故障：等一个宏任务后确认 canvas 还挂在文档里，再把错误上报给容器。
        const canvas = gl.domElement;
        window.setTimeout(() => {
          if (!canvas.isConnected) return;
          if (contextLost.current) return;
          contextLost.current = true;
          onErrorRef.current("context-lost");
        }, 0);
      };
      gl.domElement.addEventListener("webglcontextlost", onLost, false);
    },
    [palette],
  );

  return (
    <Canvas
      frameloop="demand"
      dpr={dpr}
      camera={{ fov: FOV, near: 1, far: 4000, position: CAMERA_POSITION as [number, number, number] }}
      gl={{
        antialias: tier !== "low",
        alpha: false,
        stencil: false,
        powerPreference: "high-performance",
      }}
      onCreated={handleCreated}
      style={{ width: "100%", height: "100%", display: "block" }}
    >
      <SceneRoot
        view={view}
        highlight={highlight}
        layout={layout}
        tier={tier}
        autoRotate={autoRotate}
        palette={palette}
        fontFamily={fontFamily}
        anchorId={anchorId}
        onIntent={onIntent}
        onReady={onReady}
        onStats={onStats}
      />
    </Canvas>
  );
}

/** 场景根：所有层共用一个旋转组；星场在组外（不随星系转）。 */
function SceneRoot({
  view,
  highlight,
  layout,
  tier,
  autoRotate,
  palette,
  fontFamily,
  anchorId,
  onIntent,
  onReady,
  onStats,
}: Omit<GalaxyCanvas3DProps, "dpr" | "onError"> & {
  readonly palette: GraphPalette;
  readonly fontFamily: string;
  readonly anchorId: string | null;
}) {
  const rotorRef = useRef<Group>(null);
  const labelCountRef = useRef(0);
  const size = useThree((state) => state.size);

  // 取景只依赖「布局 + 画布尺寸」：在根节点算一次，相机与控制器共用同一份。
  const framing = useMemo(
    () =>
      fitGalaxyCamera({
        positions: layout.positions,
        count: layout.ids.length,
        aspect: size.height > 0 ? size.width / size.height : 16 / 9,
        // 竖长条画布（移动端）允许退过 ADR 的 1100，否则外环会被左右裁掉。
        maxDistance: GALAXY_CAMERA_HARD_MAX_DISTANCE,
      }),
    [layout, size.width, size.height],
  );

  return (
    <>
      <Starfield palette={palette} />
      <Rotator rotorRef={rotorRef} autoRotate={autoRotate} />
      <group ref={rotorRef}>
        <HaloLayer view={view} layout={layout} palette={palette} anchorId={anchorId} />
        <EdgeField view={view} layout={layout} highlight={highlight} palette={palette} />
        <NodeField
          view={view}
          layout={layout}
          highlight={highlight}
          palette={palette}
          anchorId={anchorId}
        />
        <SelectionRing view={view} layout={layout} palette={palette} anchorId={anchorId} />
        <LabelLayer
          view={view}
          layout={layout}
          highlight={highlight}
          palette={palette}
          tier={tier}
          anchorId={anchorId}
          fontFamily={fontFamily}
          labelCountRef={labelCountRef}
        />
      </group>
      <Controls framing={framing} />
      <CameraFraming layout={layout} framing={framing} />
      <PointerBridge
        view={view}
        layout={layout}
        anchorId={anchorId}
        rotorRef={rotorRef}
        onIntent={onIntent}
      />
      <StatsBridge
        layout={layout}
        autoRotate={autoRotate}
        labelCountRef={labelCountRef}
        onReady={onReady}
        onStats={onStats}
      />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 背景
 * ------------------------------------------------------------------ */

function Starfield({ palette }: { palette: GraphPalette }) {
  const positions = useMemo(() => createStarfieldPositions(900), []);
  const color = useMemo(() => {
    const linear = rgbaToLinear(palette.core);
    return new Color(linear[0], linear[1], linear[2]);
  }, [palette]);

  return (
    <points frustumCulled={false} renderOrder={-1}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        color={color}
        size={1.2}
        sizeAttenuation
        transparent
        opacity={0.3}
        depthWrite={false}
      />
    </points>
  );
}

/* ------------------------------------------------------------------ *
 * 相机
 * ------------------------------------------------------------------ */

function Controls({ framing }: { framing: GalaxyFraming }) {
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);
  const controlsRef = useRef<OrbitControls | null>(null);

  /**
   * 最远距离：宽屏沿用 ADR 的 1100；画布窄到装不下时放到取景距离的 1.15 倍，
   * 让用户还能再退一点看全，同时不至于飘到星场外面。
   */
  const maxDistance = Math.max(
    GALAXY_CAMERA_MAX_DISTANCE,
    Math.min(GALAXY_CAMERA_HARD_MAX_DISTANCE, framing.distance * 1.15),
  );

  useEffect(() => {
    const controls = new OrbitControls(camera, gl.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    // ADR-022 A3.1 / A8：最近 260（再近会穿进中心节点）；最远由下面那个 effect 按取景设置。
    controls.minDistance = GALAXY_CAMERA_MIN_DISTANCE;
    controls.rotateSpeed = 0.55;
    controls.zoomSpeed = 0.8;
    controls.enablePan = false;
    controls.target.set(0, 0, 0);
    const onChange = (): void => invalidate();
    controls.addEventListener("change", onChange);
    controls.update();
    controlsRef.current = controls;
    return () => {
      controls.removeEventListener("change", onChange);
      controls.dispose();
      controlsRef.current = null;
    };
  }, [camera, gl, invalidate]);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    controls.maxDistance = maxDistance;
    // 之前的距离可能超出新上限（例如从竖屏切回宽屏），夹一次并排帧。
    controls.update();
    invalidate();
  }, [maxDistance, invalidate]);

  useFrame(() => {
    controlsRef.current?.update();
  });

  return null;
}

/**
 * 取景：按画布宽高比 + 当前布局的实际投影求相机距离，视线方向保持不变。
 * - 换布局（换中心 / 改深度 / 节点数变化）：重新取景，新星系重新铺满；
 * - 只换画布尺寸（窗口拉伸、侧栏折叠）：保留用户此前的手动缩放倍数，
 *   不把「用户放大看细节」这一步重置掉；
 * - 自转不改变取景：`fitGalaxyCamera` 扫一整圈，任何转角都不会裁切。
 */
function CameraFraming({
  layout,
  framing,
}: {
  layout: GalaxyLayoutResult;
  framing: GalaxyFraming;
}) {
  const camera = useThree((state) => state.camera);
  const invalidate = useThree((state) => state.invalidate);
  const applied = useRef<{ distance: number; layout: GalaxyLayoutResult } | null>(null);

  useEffect(() => {
    const previous = applied.current;
    const distance =
      previous && previous.layout === layout
        ? rescaleForViewport({
            nextFitDistance: framing.distance,
            previousFitDistance: previous.distance,
            currentDistance: camera.position.length(),
            maxDistance: Math.max(
              GALAXY_CAMERA_MAX_DISTANCE,
              Math.min(GALAXY_CAMERA_HARD_MAX_DISTANCE, framing.distance * 1.15),
            ),
          })
        : framing.distance;

    const [dx, dy, dz] = framing.direction;
    camera.position.set(dx * distance, dy * distance, dz * distance);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    applied.current = { distance: framing.distance, layout };
    invalidate(2);
  }, [camera, invalidate, layout, framing]);

  return null;
}

function Rotator({
  rotorRef,
  autoRotate,
}: {
  rotorRef: { readonly current: Group | null };
  autoRotate: boolean;
}) {  const invalidate = useThree((state) => state.invalidate);

  useFrame((_state, delta) => {
    if (!autoRotate) return;
    const rotor = rotorRef.current;
    if (!rotor) return;
    rotor.rotation.y += Math.min(delta, 0.1) * AUTO_ROTATE_RADS_PER_SECOND;
    // 标签层在同一帧里要投影：先把组的世界矩阵刷新，避免标签比星点慢一帧（自转时抖动）。
    rotor.updateMatrixWorld(true);
    invalidate();
  });

  // 自转开关变化都要主动排一帧：frameloop="demand" 下，props 变化本身不会启动循环。
  // 打开后由 useFrame 里的 invalidate 自续；关闭后这一帧画完就停。
  useEffect(() => {
    invalidate();
  }, [autoRotate, invalidate]);

  return null;
}

/* ------------------------------------------------------------------ *
 * 指针拾取（单击 select / 双击 focus / 悬停 hover，节流 ~80ms）
 * ------------------------------------------------------------------ */

interface PointerBridgeProps {
  readonly view: GraphViewModel;
  readonly layout: GalaxyLayoutResult;
  readonly anchorId: string | null;
  readonly rotorRef: { readonly current: Group | null };
  readonly onIntent: (intent: SceneIntent, id?: string) => void;
}

function PointerBridge({ view, layout, anchorId, rotorRef, onIntent }: PointerBridgeProps) {
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);

  const pick = useCallback(
    (clientX: number, clientY: number): string | null => {
      const rotor = rotorRef.current;
      if (!rotor) return null;
      const rect = gl.domElement.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return null;
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const tanHalfFov = Math.tan((FOV * Math.PI) / 360);

      rotor.updateWorldMatrix(true, false);
      camera.updateMatrixWorld();

      const world = new Vector3();
      const projected = new Vector3();
      let bestId: string | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;

      for (let index = 0; index < layout.ids.length; index += 1) {
        const id = layout.ids[index];
        const nodeIndex = view.nodeIndex.get(id);
        if (nodeIndex === undefined) continue;
        const node = view.nodes[nodeIndex];
        const radius = visualRadius(layout.radius[index], node.flags.isCenter, id === anchorId);

        world.set(
          layout.positions[index * 3],
          layout.positions[index * 3 + 1],
          layout.positions[index * 3 + 2],
        );
        world.applyMatrix4(rotor.matrixWorld);
        projected.copy(world).project(camera);
        if (projected.z < -1 || projected.z > 1) continue;

        const sx = (projected.x * 0.5 + 0.5) * rect.width;
        const sy = (-projected.y * 0.5 + 0.5) * rect.height;
        const distance = camera.position.distanceTo(world);
        const radiusPx = (radius / Math.max(1, distance * tanHalfFov)) * (rect.height / 2);
        const hitRadius = Math.max(radiusPx * 1.8, 8);
        const offset = Math.hypot(sx - px, sy - py);
        if (offset <= hitRadius && offset < bestDistance) {
          bestDistance = offset;
          bestId = id;
        }
      }
      return bestId;
    },
    [camera, gl, view, layout, anchorId, rotorRef],
  );

  useEffect(() => {
    const element = gl.domElement;
    let lastHoverAt = 0;
    let hoverId: string | null = null;
    let downAt: { x: number; y: number } | null = null;

    const onPointerMove = (event: PointerEvent): void => {
      if (event.buttons !== 0) return;
      const now = performance.now();
      if (now - lastHoverAt < 80) return;
      lastHoverAt = now;
      const id = pick(event.clientX, event.clientY);
      if (id === hoverId) return;
      hoverId = id;
      onIntent("hover", id ?? undefined);
    };
    const onPointerLeave = (): void => {
      if (hoverId === null) return;
      hoverId = null;
      onIntent("hover", undefined);
    };
    const onPointerDown = (event: PointerEvent): void => {
      downAt = { x: event.clientX, y: event.clientY };
    };
    const onClick = (event: MouseEvent): void => {
      if (!downAt) return;
      const moved = Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y);
      downAt = null;
      if (moved > 5) return;
      const id = pick(event.clientX, event.clientY);
      if (id) onIntent("select", id);
    };
    const onDoubleClick = (event: MouseEvent): void => {
      const id = pick(event.clientX, event.clientY);
      if (id) onIntent("focus", id);
    };

    element.addEventListener("pointermove", onPointerMove);
    element.addEventListener("pointerleave", onPointerLeave);
    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("click", onClick);
    element.addEventListener("dblclick", onDoubleClick);
    return () => {
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerleave", onPointerLeave);
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("click", onClick);
      element.removeEventListener("dblclick", onDoubleClick);
    };
  }, [gl, pick, onIntent]);

  return null;
}

/* ------------------------------------------------------------------ *
 * 读数（onReady 一次 / onStats 每 30 帧）
 * ------------------------------------------------------------------ */

interface StatsBridgeProps {
  readonly layout: GalaxyLayoutResult;
  readonly autoRotate: boolean;
  readonly labelCountRef: { current: number };
  readonly onReady: GalaxyCanvas3DProps["onReady"];
  readonly onStats: GalaxyCanvas3DProps["onStats"];
}

function StatsBridge({ layout, autoRotate, labelCountRef, onReady, onStats }: StatsBridgeProps) {
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);
  // 切回 3D 时 Canvas 往往先以 0×0 挂载：R3F 拿到真实尺寸后不会自动补帧，
  // 标签也不会被放置、onReady 永远不会触发。尺寸落定后主动排两帧。
  const size = useThree((state) => state.size);

  const frames = useRef(0);
  const average = useRef(0);
  const lastAt = useRef(0);
  const sincePublish = useRef(0);
  const ready = useRef({ pending: true, frames: 0 });
  const autoRotateRef = useRef(autoRotate);

  useEffect(() => {
    autoRotateRef.current = autoRotate;
  }, [autoRotate]);

  const publish = useCallback(
    (rafActive: boolean) => {
      onStats({
        frames: frames.current,
        avgFrameMs: Math.round(average.current * 100) / 100,
        labels: labelCountRef.current,
        drawCalls: gl.info.render.calls,
        dpr: gl.getPixelRatio(),
        rafActive,
        layoutTicks: layout.ticks,
        truncated: layout.truncated,
      });
    },
    [gl, layout, labelCountRef, onStats],
  );

  // 新布局：等两帧再报，确保 gl.info.render.calls 已经是这一版场景的读数。
  useEffect(() => {
    ready.current = { pending: true, frames: 0 };
    frames.current = 0;
    average.current = 0;
    lastAt.current = 0;
    sincePublish.current = 0;
    invalidate(4);
  }, [layout, invalidate]);

  useEffect(() => {
    if (size.width < 1 || size.height < 1) return;
    invalidate(3);
    // demand 模式下静止时往往只渲染 1–3 帧，永远到不了 30 帧的发布节拍，
    // 容器里的 labels / frames 会停在挂载时的 0。等一帧落定后主动补一次真实读数。
    const timer = window.setTimeout(() => {
      publish(autoRotateRef.current);
      invalidate();
    }, 260);
    return () => window.clearTimeout(timer);
  }, [size.width, size.height, invalidate, publish]);

  useEffect(() => {
    if (!autoRotate) {
      publish(false);
      invalidate();
    }
  }, [autoRotate, publish, invalidate]);

  useEffect(() => {
    const onVisible = (): void => {
      if (document.hidden) return;
      publish(autoRotateRef.current);
      invalidate();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [publish, invalidate]);

  useFrame(() => {
    if (document.hidden) return;
    const now = performance.now();
    const delta = lastAt.current === 0 ? 0 : now - lastAt.current;
    lastAt.current = now;
    frames.current += 1;
    if (delta > 0 && delta < 120) {
      average.current = average.current === 0 ? delta : average.current * 0.85 + delta * 0.15;
    }

    if (ready.current.pending) {
      ready.current.frames += 1;
      if (ready.current.frames >= 2 && gl.info.render.calls > 0) {
        ready.current.pending = false;
        onReady({
          layoutMs: layout.layoutMs,
          layoutTicks: layout.ticks,
          truncated: layout.truncated,
          drawCalls: gl.info.render.calls,
        });
        publish(autoRotate);
      }
    }

    sincePublish.current += 1;
    if (sincePublish.current >= 30) {
      sincePublish.current = 0;
      publish(autoRotate);
    }
  });

  return null;
}
