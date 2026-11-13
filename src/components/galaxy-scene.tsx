"use client";

import { useEffect, useRef } from "react";

import { GALAXY_CONFIG } from "@/lib/galaxy-config";
import {
  effectivePixelRatio,
  isLowPerformanceDevice,
  resolveGalaxyMode,
  resolveGalaxyQuality,
  type GalaxyQuality,
} from "@/lib/galaxy";
import type { GalaxyRenderer } from "@/lib/galaxy-three";

/** 画在 `window.__galaxyStats` 上的运行时统计，供验收读数（不渲染成 UI）。 */
export interface GalaxyRuntimeStats {
  mode: "pending" | "webgl" | "poster" | "fallback";
  tier: "high" | "balanced";
  /** 各类粒子合计。 */
  particles: number;
  arms: number;
  core: number;
  haze: number;
  dust: number;
  stars: number;
  dpr: number;
  fpsCap: number;
  /** 已绘制帧数。 */
  frames: number;
  /** 前 N 帧的平均「更新 + 绘制」耗时（ms）。 */
  avgFrameMs: number;
  /** 建场景后第一帧的绘制耗时（ms）。 */
  firstFrameMs: number;
  /** 从组件挂载到第一帧出现（ms），含动态加载 three 的时间。 */
  firstFrameWallMs: number;
  /** 当前是否挂着 rAF。 */
  rafActive: boolean;
  /** 页面隐藏后 rAF 是否已停。 */
  paused: boolean;
  /** 自转周期（秒），便于验收核对 60–120 区间。 */
  rotationPeriodSeconds: number;
}

type SceneMode = GalaxyRuntimeStats["mode"];

interface StatsState extends GalaxyRuntimeStats {
  peakFrameMs: number;
}

function detectWebGL(): boolean {
  try {
    const probe = document.createElement("canvas");
    return Boolean(
      probe.getContext("webgl2")
      || probe.getContext("webgl")
      || probe.getContext("experimental-webgl"),
    );
  } catch {
    return false;
  }
}

function readQuality(reducedMotion: boolean): GalaxyQuality {
  return resolveGalaxyQuality({
    viewportWidth: window.innerWidth,
    reducedMotion,
    lowPerformance: isLowPerformanceDevice({
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    }),
  });
}

function publishToWindow(stats: GalaxyRuntimeStats) {
  (window as Window & { __galaxyStats?: GalaxyRuntimeStats }).__galaxyStats = stats;
}

/**
 * 首页星系背景（ADR-020）。
 *
 * 降级链：
 * 1. `prefers-reduced-motion` / `?still=1` → 只显示自渲染的静态图，零 rAF；
 * 2. WebGL 不可用 → 同一张静态图 + CSS 星点；
 * 3. 正常 → 先显示静态图，Three.js 场景就绪后淡入接管。
 *
 * `posterMode` 只给 `/galaxy/poster` 截图路由用：不渲染静态图、不响应交互，
 * 定格渲染一帧后把 `window.__galaxyPosterReady` 置真。
 */
export function GalaxyScene({ posterMode = false }: { posterMode?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const canvasElement: HTMLCanvasElement = canvas;

    // 层级切换只改 `data-mode`，不走 React state：这是纯装饰层，
    // 在 effect 里同步 setState 会白白触发一轮级联渲染（react-hooks
    // 的 set-state-in-effect 规则也正是拦这个）。SSR 与首帧都渲染
    // `data-mode="pending"`，之后由这里直接改 DOM 属性。
    const sceneElement = sceneRef.current;
    function setMode(next: SceneMode) {
      if (sceneElement) sceneElement.dataset.mode = next;
    }

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const forceStatic = new URLSearchParams(window.location.search).get("still") === "1";

    let disposed = false;
    let renderer: GalaxyRenderer | null = null;
    let rafId = 0;
    let idleHandle = 0;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let quality = readQuality(motionQuery.matches);
    let startedAt = 0;
    let lastDrawAt = 0;
    let frames = 0;
    let frameTotal = 0;
    let peakFrameMs = 0;
    let pointerX = 0;
    let pointerY = 0;

    const stats: StatsState = {
      mode: "pending",
      tier: quality.tier,
      particles: quality.particleCount,
      arms: quality.arms,
      core: quality.core,
      haze: quality.haze,
      dust: quality.dust,
      stars: quality.stars,
      dpr: effectivePixelRatio(quality, window.devicePixelRatio || 1),
      fpsCap: quality.fpsCap,
      frames: 0,
      avgFrameMs: 0,
      firstFrameMs: 0,
      firstFrameWallMs: 0,
      rafActive: false,
      paused: false,
      rotationPeriodSeconds: GALAXY_CONFIG.rotation.periodSeconds,
      peakFrameMs: 0,
    };

    function publish(partial: Partial<StatsState> = {}) {
      Object.assign(stats, partial, {
        frames,
        avgFrameMs: frames > 0 ? frameTotal / Math.min(frames, GALAXY_CONFIG.frameSampleFrames) : 0,
        peakFrameMs,
        tier: quality.tier,
        particles: quality.particleCount,
        arms: quality.arms,
        core: quality.core,
        dust: quality.dust,
        stars: quality.stars,
        fpsCap: quality.fpsCap,
        rotationPeriodSeconds: GALAXY_CONFIG.rotation.periodSeconds,
      });
      publishToWindow(stats);
    }

    function stopLoop() {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
      stats.rafActive = false;
    }

    function frame(timestamp: number) {
      if (disposed || !renderer) return;
      rafId = window.requestAnimationFrame(frame);
      stats.rafActive = true;

      if (document.hidden) return;
      const minInterval = 1000 / quality.fpsCap;
      if (lastDrawAt && timestamp - lastDrawAt < minInterval - 1.5) return;

      const delta = lastDrawAt ? timestamp - lastDrawAt : 16;
      lastDrawAt = timestamp;

      const drawStart = performance.now();
      renderer.render(timestamp - startedAt, delta);
      const cost = performance.now() - drawStart;

      frames += 1;
      if (frames <= GALAXY_CONFIG.frameSampleFrames) frameTotal += cost;
      peakFrameMs = Math.max(peakFrameMs, cost);
      if (frames % 30 === 0) publish();
    }

    function startLoop() {
      if (disposed || rafId || !renderer || !quality.animate || document.hidden) return;
      startedAt = performance.now() - frames * 16;
      lastDrawAt = 0;
      rafId = window.requestAnimationFrame(frame);
      stats.rafActive = true;
      stats.paused = false;
    }

    function mount(withPoster: boolean) {
      // 截图路由按设备像素比出图（上限 3），保证 1170×2532 的移动版不发虚。
      const dpr = withPoster
        ? Math.min(3, Math.max(1, window.devicePixelRatio || 1))
        : effectivePixelRatio(quality, window.devicePixelRatio || 1);
      const wallStart = performance.now();

      void import("@/lib/galaxy-three")
        .then((module) => {
          if (disposed) return null;
          const created = module.createGalaxyRenderer({
            canvas: canvasElement,
            quality,
            width: window.innerWidth,
            height: window.innerHeight,
            dpr,
          });
          if (!created) return null;

          renderer = created;
          renderer.setPointer(pointerX, pointerY);

          const drawStart = performance.now();
          created.render(0, 16, withPoster);
          const firstCost = performance.now() - drawStart;

          frames = 1;
          frameTotal = firstCost;
          peakFrameMs = firstCost;
          stats.dpr = dpr;
          publish({
            mode: "webgl",
            firstFrameMs: firstCost,
            firstFrameWallMs: performance.now() - wallStart,
          });
          setMode("webgl");

          if (withPoster) {
            // 截图路由：两帧后置就绪，保证读到的缓冲是最终画面。
            window.requestAnimationFrame(() => {
              window.requestAnimationFrame(() => {
                (window as Window & { __galaxyPosterReady?: boolean }).__galaxyPosterReady = true;
              });
            });
          } else if (quality.animate) {
            startLoop();
          }

          return created;
        })
        .catch(() => {
          if (disposed) return;
          renderer?.dispose();
          renderer = null;
          setMode("fallback");
          publish({ mode: "fallback" });
        });
    }

    /* ---------- 截图路由 ---------- */
    if (posterMode) {
      mount(true);
      return () => {
        disposed = true;
        stopLoop();
        renderer?.dispose();
        renderer = null;
      };
    }

    /* ---------- 降级：静态图 / CSS 星点，零 rAF ---------- */
    const initialMode = resolveGalaxyMode({
      reducedMotion: motionQuery.matches,
      webglAvailable: detectWebGL(),
      forceStatic,
    });

    if (initialMode !== "webgl") {
      quality = readQuality(true);
      publish({ mode: initialMode, dpr: effectivePixelRatio(quality, window.devicePixelRatio || 1) });
      setMode(initialMode);

      // 系统「减弱动态效果」被关掉后无需刷新也能切回动画。
      const onMotionChange = () => {
        if (!motionQuery.matches && !forceStatic) window.location.reload();
      };
      motionQuery.addEventListener("change", onMotionChange);

      return () => {
        disposed = true;
        motionQuery.removeEventListener("change", onMotionChange);
      };
    }

    /* ---------- 正常：WebGL 接管 ---------- */
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      pointerX = (event.clientX / window.innerWidth) * 2 - 1;
      pointerY = (event.clientY / window.innerHeight) * 2 - 1;
      renderer?.setPointer(pointerX, pointerY);
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });

    const onVisibility = () => {
      if (document.hidden) {
        stopLoop();
        stats.paused = true;
        publish({ paused: true });
      } else {
        stats.paused = false;
        publish({ paused: false });
        startLoop();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    const onResize = () => {
      const next = readQuality(motionQuery.matches);
      if (next.mobile !== quality.mobile) {
        // 跨过窄屏阈值要换整套粒子预算，重建比原地改更干净。
        window.location.reload();
        return;
      }
      quality = next;
      const dpr = effectivePixelRatio(next, window.devicePixelRatio || 1);
      stats.dpr = dpr;
      renderer?.setViewport(window.innerWidth, window.innerHeight, dpr);
      if (!quality.animate && renderer) renderer.render(0, 16, true);
    };
    window.addEventListener("resize", onResize);

    publish({ mode: "pending" });

    // 首帧之后再建场景：搜索框先可用，着色器编译不抢主线程。
    if (typeof window.requestIdleCallback === "function") {
      idleHandle = window.requestIdleCallback(() => mount(false), { timeout: 900 });
    } else {
      timeoutHandle = setTimeout(() => mount(false), 120);
    }

    return () => {
      disposed = true;
      stopLoop();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      if (idleHandle && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleHandle);
      }
      if (timeoutHandle) clearTimeout(timeoutHandle);
      renderer?.dispose();
      renderer = null;
    };
  }, [posterMode]);

  return (
    <div className="galaxy-scene" data-mode="pending" ref={sceneRef} aria-hidden="true">
      {posterMode ? null : (
        <picture className="galaxy-poster">
          <source
            media={`(max-width: ${GALAXY_CONFIG.mobileBreakpoint - 1}px)`}
            srcSet={GALAXY_CONFIG.poster.mobile}
          />
          <img
            alt=""
            decoding="async"
            fetchPriority="high"
            height={GALAXY_CONFIG.poster.desktopSize[1]}
            src={GALAXY_CONFIG.poster.desktop}
            width={GALAXY_CONFIG.poster.desktopSize[0]}
          />
        </picture>
      )}
      <canvas className="galaxy-canvas" ref={canvasRef} />
      <div className="galaxy-fallback-stars" />
    </div>
  );
}
