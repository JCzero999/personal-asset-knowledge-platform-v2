import { GALAXY_CONFIG, GALAXY_PALETTE, type GalaxyPalette } from "./galaxy-config";
import { MAX_SEARCH_QUESTION } from "./search-params";

/**
 * 银河首页的纯函数层（ADR-020，替代 ADR-018 的 2D 版本）。
 *
 * 这里只放可单测的数学与决策：螺旋几何、配色采样、旋转、视差阻尼、
 * 构图换算、画质分档与降级判定、搜索提交。WebGL 与 DOM 生命周期留在
 * `galaxy-three.ts` / `galaxy-scene.tsx`。
 */

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/* ============================================================
   画质与降级
   ============================================================ */

export interface GalaxyQuality {
  /** 命中哪一档粒子预算。 */
  tier: "high" | "balanced";
  /** 是否按窄屏参数渲染。 */
  mobile: boolean;
  /** 各类粒子数。 */
  arms: number;
  core: number;
  haze: number;
  dust: number;
  stars: number;
  /** 四类合计，写进运行时统计。 */
  particleCount: number;
  /** `devicePixelRatio` 上限：桌面 2、移动/低性能 1.5。 */
  pixelRatioCap: number;
  /** 绘制帧率上限：桌面 60、受约束档 30。 */
  fpsCap: number;
  /** 点精灵尺寸系数。 */
  pointScale: number;
  /** 是否自转 / 呼吸 / 闪烁；`prefers-reduced-motion` 时为 false。 */
  animate: boolean;
}

/**
 * 画质分档。窄屏（< 720px）或低性能设备一律走 balanced 档，
 * `prefers-reduced-motion` 只关动画，不降粒子（静态图走 poster，根本不建场景）。
 */
export function resolveGalaxyQuality(input: {
  viewportWidth: number;
  reducedMotion: boolean;
  lowPerformance: boolean;
}): GalaxyQuality {
  const mobile = input.viewportWidth < GALAXY_CONFIG.mobileBreakpoint;
  const constrained = mobile || input.lowPerformance;
  const tier = constrained ? GALAXY_CONFIG.tiers.balanced : GALAXY_CONFIG.tiers.high;
  const { arms, core, haze, dust, stars } = tier.budget;

  return {
    tier: tier.id,
    mobile,
    arms,
    core,
    haze,
    dust,
    stars,
    particleCount: arms + core + haze + dust + stars,
    pixelRatioCap: tier.pixelRatioCap,
    fpsCap: tier.fpsCap,
    pointScale: tier.pointScale,
    animate: !input.reducedMotion,
  };
}

/** 设备是否属于「低性能」档（≤2 核或 ≤2GB 内存）。 */
export function isLowPerformanceDevice(input: {
  hardwareConcurrency?: number;
  deviceMemory?: number;
}): boolean {
  const cores = input.hardwareConcurrency;
  const memory = input.deviceMemory;

  return (typeof cores === "number" && cores > 0 && cores <= 2)
    || (typeof memory === "number" && memory > 0 && memory <= 2);
}

/** 实际使用的像素比：至少 1，且不超过质量档上限。 */
export function effectivePixelRatio(quality: GalaxyQuality, devicePixelRatio: number): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;

  return Math.min(Math.max(1, dpr), quality.pixelRatioCap);
}

export type GalaxyRenderMode = "webgl" | "poster" | "fallback";

/**
 * 降级链：reduced-motion / 强制静态 → poster；WebGL 不可用 → fallback
 * （同一张 poster + CSS 星点）；否则 WebGL。
 */
export function resolveGalaxyMode(input: {
  reducedMotion: boolean;
  webglAvailable: boolean;
  forceStatic?: boolean;
}): GalaxyRenderMode {
  if (input.forceStatic || input.reducedMotion) return "poster";
  if (!input.webglAvailable) return "fallback";

  return "webgl";
}

/** 静态图按视口宽度选移动版或桌面版。 */
export function resolvePosterSrc(viewportWidth: number): string {
  return viewportWidth < GALAXY_CONFIG.mobileBreakpoint
    ? GALAXY_CONFIG.poster.mobile
    : GALAXY_CONFIG.poster.desktop;
}

/* ============================================================
   构图与相机
   ============================================================ */

export interface GalaxyComposition {
  visibleHeight: number;
  visibleWidth: number;
  /** 盘面半径 1 对应的世界尺寸，直接作为 group.scale。 */
  scale: number;
  /** 星系中心的横向世界偏移（右为正）。 */
  offsetX: number;
  /** 星系中心的纵向世界偏移（上为正）。 */
  offsetY: number;
  tiltRad: number;
  rollRad: number;
  /** 整体观察面的翻转角（0 正面 / π 背面）。 */
  facingRad: number;
  /** 自转方向系数：翻面时取 -1，保证屏幕上仍是同一个转向。 */
  spinSign: 1 | -1;
}

/** 把「视口里的构图」换算成相机空间的世界坐标。纯函数，便于断言。 */
export function resolveGalaxyComposition(input: {
  aspect: number;
  mobile: boolean;
}): GalaxyComposition {
  const aspect = Number.isFinite(input.aspect) ? Math.min(3.6, Math.max(0.3, input.aspect)) : 1.6;
  const camera = GALAXY_CONFIG.camera;
  const preset = input.mobile ? GALAXY_CONFIG.composition.mobile : GALAXY_CONFIG.composition.desktop;

  const visibleHeight = 2 * camera.distance * Math.tan((camera.fovDeg * DEG) / 2);
  const visibleWidth = visibleHeight * aspect;

  const facingRad = GALAXY_CONFIG.facingDeg * DEG;

  return {
    visibleHeight,
    visibleWidth,
    scale: preset.fill * visibleWidth,
    offsetX: (preset.centerX - 0.5) * visibleWidth,
    offsetY: (0.5 - preset.centerY) * visibleHeight,
    tiltRad: camera.tiltDeg * DEG,
    rollRad: preset.rollDeg * DEG,
    facingRad,
    // 绕 Y 轴转 180° 会把局部 +Z 映射到世界 -Z，自转看起来会反；
    // 这里同步取反，翻面后仍是同一转向。
    spinSign: Math.abs(facingRad % TAU) > Math.PI / 2 ? -1 : 1,
  };
}

/* ============================================================
   运动：旋转、视差、阻尼
   ============================================================ */

/** 当前时刻的自转角（弧度），默认 90 秒一圈。 */
export function galaxyRotation(
  elapsedMs: number,
  periodMs: number = GALAXY_CONFIG.rotation.periodSeconds * 1000,
): number {
  if (!Number.isFinite(periodMs) || periodMs <= 0) return 0;

  return ((elapsedMs % periodMs) / periodMs) * TAU;
}

/**
 * 指数阻尼，与帧率无关：每经过一个 halfLife，差距减半。
 * 用于视差跟随，避免鼠标一动画面就「跳」。
 */
export function dampValue(
  current: number,
  target: number,
  deltaMs: number,
  halfLifeMs: number,
): number {
  if (halfLifeMs <= 0) return target;
  const factor = Math.pow(2, -Math.max(0, deltaMs) / halfLifeMs);

  return target + (current - target) * factor;
}

/** 指针归一化坐标（-1..1）→ 最大偏移角内的目标角度。 */
export function computeParallaxTarget(
  pointerX: number,
  pointerY: number,
  maxRad: number,
): { x: number; y: number } {
  const clamp = (value: number) => Math.min(1, Math.max(-1, Number.isFinite(value) ? value : 0));

  return {
    x: clamp(pointerY) * maxRad,
    y: clamp(pointerX) * maxRad,
  };
}

/** 轻微呼吸：0..1 的平滑往复（sin），返回值用于叠加相机俯仰。 */
export function breathingOffset(elapsedMs: number, periodSeconds: number): number {
  if (periodSeconds <= 0) return 0;

  return Math.sin(((elapsedMs / 1000) % periodSeconds) / periodSeconds * TAU);
}

/** GLSL 风格 smoothstep。 */
export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));

  return t * t * (3 - 2 * t);
}

/* ============================================================
   几何与配色
   ============================================================ */

export interface GalaxyGeometry {
  count: number;
  /** 顶点坐标，3 个 float 一组。 */
  positions: Float32Array;
  /** 颜色，3 个 float 一组，0..1。 */
  colors: Float32Array;
  /** 点尺寸（CSS 像素基准）。 */
  sizes: Float32Array;
  /** 每点随机种子（0..1），供着色器做闪烁与亮度扰动。 */
  seeds: Float32Array;
}

export type Rgb = readonly [number, number, number];

/** `#RRGGBB` / `#RGB` → 0..1 的线性三元组（按 sRGB 原值，不做色彩管理）。 */
export function hexToRgb(hex: string): Rgb {
  const raw = hex.trim().replace("#", "");
  const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;

  if (!/^[0-9a-fA-F]{6}$/.test(full)) return [0, 0, 0];

  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  ];
}

/** 两色线性插值。 */
export function mixColor(from: Rgb, to: Rgb, t: number): Rgb {
  const k = Math.min(1, Math.max(0, t));

  return [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k, from[2] + (to[2] - from[2]) * k];
}

/** 按半径取色：核心亮白 → 暖黄 → 金 → 尘埃棕 → 灰紫 → 暗紫。 */
export function sampleGalaxyColor(radius: number, palette: GalaxyPalette = GALAXY_PALETTE): Rgb {
  const stops: ReadonlyArray<{ at: number; color: Rgb }> = [
    { at: 0.0, color: hexToRgb(palette.coreWhite) },
    { at: 0.16, color: hexToRgb(palette.coreWarm) },
    { at: 0.42, color: hexToRgb(palette.gold) },
    { at: 0.64, color: hexToRgb(palette.dust) },
    { at: 0.84, color: hexToRgb(palette.violetGrey) },
    { at: 1.0, color: hexToRgb(palette.violetDeep) },
  ];
  const r = Math.min(1, Math.max(0, radius));

  for (let index = 1; index < stops.length; index += 1) {
    const prev = stops[index - 1];
    const next = stops[index];
    if (r <= next.at) {
      const span = next.at - prev.at;
      return mixColor(prev.color, next.color, span === 0 ? 0 : (r - prev.at) / span);
    }
  }

  return stops[stops.length - 1].color;
}

function createGeometry(count: number): GalaxyGeometry {
  const safe = Math.max(0, Math.floor(count));

  return {
    count: safe,
    positions: new Float32Array(safe * 3),
    colors: new Float32Array(safe * 3),
    sizes: new Float32Array(safe),
    seeds: new Float32Array(safe),
  };
}

/** Box–Muller 正态分布，截断到 ±3σ，避免极值把点甩出盘面。 */
function gaussian(random: () => number): number {
  const u = Math.max(1e-6, random());
  const v = random();
  const value = Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);

  return Math.max(-3, Math.min(3, value));
}

/**
 * 六条旋臂的起始角：沿 60° 均匀错开，0 与 π 为两条主臂，
 * 其余四条是更散、更暗的次臂。前两条索引固定为主臂。
 */
const ARM_BASES = [
  0,
  Math.PI,
  Math.PI / 3,
  (Math.PI * 2) / 3,
  (Math.PI * 4) / 3,
  (Math.PI * 5) / 3,
] as const;

/** 主臂合计 57%，四条次臂平分剩下的 43%。 */
function pickArm(random: () => number): number {
  const roll = random();
  if (roll < 0.285) return 0;
  if (roll < 0.57) return 1;
  if (roll < 0.6775) return 2;
  if (roll < 0.785) return 3;
  if (roll < 0.8925) return 4;

  return 5;
}

/** 对数螺线的旋臂圈数：圈数越大旋臂越「卷」。参考图约为 1 圈出头。 */
const SPIRAL_TURNS = 0.58;

/**
 * 旋臂星点。返回盘面局部坐标（半径 ≤ ~1.05，z 很薄），
 * 投影与倾斜交给 3D 场景，不在几何层压扁。
 *
 * 半径先取「团块中心」再叠加很小的高斯抖动：粒子会沿旋臂结成
 * 一段段团簇，而不是均匀铺成一条细环——这是写实星系的观感来源。
 */
export function buildSpiralArms(
  count: number,
  palette: GalaxyPalette = GALAXY_PALETTE,
  random: () => number = Math.random,
): GalaxyGeometry {
  const geometry = createGeometry(count);

  for (let index = 0; index < geometry.count; index += 1) {
    const arm = pickArm(random);
    const base = ARM_BASES[arm];
    const major = arm < 2;
    const clumpRadius = 0.14 + 0.86 * Math.pow(random(), 0.62);
    const radius = Math.min(1.06, Math.max(0.05, clumpRadius + gaussian(random) * 0.018 * (1 + clumpRadius)));
    // 次臂更散、更暗，主臂更紧实；六条臂后整体收紧，避免互相缠绕。
    const spread = (major ? 0.08 : 0.12) + clumpRadius * (major ? 0.10 : 0.13);

    // 约 22% 的粒子脱离主臂，形成絮状分支（真实星系的「毛边」）。
    const feather = random() < 0.22 ? gaussian(random) * 0.3 : 0;
    const theta = base + clumpRadius * SPIRAL_TURNS * TAU + gaussian(random) * spread + feather;

    const x = Math.cos(theta) * radius;
    const y = Math.sin(theta) * radius;
    const z = gaussian(random) * 0.016 * (1.15 - radius * 0.6);

    let brightness = (major ? 1.05 : 0.6) * (0.78 + random() * 0.4);
    // 外缘是灰紫 / 暗紫，加法混合下最容易过曝成白点。压一档，
    // 让最外圈保持「尘埃」而不是「霓虹」。
    brightness *= 1 - 0.42 * smoothstep(0.68, 1.05, radius);
    // 约 7% 放大成低亮度的「薄雾点」，让旋臂有体积感、不显成离散噪点。
    const veil = random() < 0.07;
    if (veil) brightness *= 0.5;

    const color = sampleGalaxyColor(radius, palette);
    const offset = index * 3;

    geometry.positions[offset] = x;
    geometry.positions[offset + 1] = y;
    geometry.positions[offset + 2] = z;
    geometry.colors[offset] = color[0] * brightness;
    geometry.colors[offset + 1] = color[1] * brightness;
    geometry.colors[offset + 2] = color[2] * brightness;
    geometry.sizes[index] = veil ? 3.4 + random() * 4.6 : 0.85 + random() * 1.35;
    geometry.seeds[index] = random();
  }

  return geometry;
}

/**
 * 核球：沿长轴拉开的棒状亮核（参考图的核心就是一段斜向的亮棒），
 * 高斯聚簇、亮白到暖黄渐变。
 */
export function buildCoreBulge(
  count: number,
  palette: GalaxyPalette = GALAXY_PALETTE,
  random: () => number = Math.random,
): GalaxyGeometry {
  const geometry = createGeometry(count);

  for (let index = 0; index < geometry.count; index += 1) {
    const theta = random() * TAU;
    const spread = Math.abs(gaussian(random)) * 0.1 + 0.003;
    // 椭圆核：横向 0.2、纵向 0.1，和盘面长轴同向。
    const rx = spread * 1.55;
    const ry = spread * 0.78;
    const z = gaussian(random) * 0.028;
    const t = Math.min(1, spread / 0.28);
    const color = mixColor(hexToRgb(palette.coreWhite), hexToRgb(palette.coreWarm), t);
    const brightness = 0.95 + random() * 0.45;
    const offset = index * 3;

    geometry.positions[offset] = Math.cos(theta) * rx;
    geometry.positions[offset + 1] = Math.sin(theta) * ry;
    geometry.positions[offset + 2] = z;
    geometry.colors[offset] = color[0] * brightness;
    geometry.colors[offset + 1] = color[1] * brightness;
    geometry.colors[offset + 2] = color[2] * brightness;
    geometry.sizes[index] = 1.1 + random() * 1.7;
    geometry.seeds[index] = random();
  }

  return geometry;
}

/**
 * 盘面薄雾：沿旋臂铺开的大而暗的软点，把离散星点连成连续的尘埃带。
 * 这是「写实感」的关键层——单靠小点会显得像粒子特效。
 */
export function buildDiskHaze(
  count: number,
  palette: GalaxyPalette = GALAXY_PALETTE,
  random: () => number = Math.random,
): GalaxyGeometry {
  const geometry = createGeometry(count);

  for (let index = 0; index < geometry.count; index += 1) {
    const arm = pickArm(random);
    const base = ARM_BASES[arm];
    const alongArm = random() > 0.48;
    const radius = 0.08 + 0.92 * Math.pow(random(), 0.6);
    // 58% 贴着旋臂走，其余均匀铺满盘面：真实星系在旋臂之间也有
    // 一层很淡的指数盘光，缺了它整张图会像几条断开的带子。
    const theta = alongArm
      ? base + radius * SPIRAL_TURNS * TAU + gaussian(random) * (0.09 + radius * 0.16)
      : random() * TAU;
    // 薄雾略微抬高一点，避免和星点在同一深度上「打架」。
    const z = gaussian(random) * 0.01 + 0.012;
    const color = sampleGalaxyColor(radius, palette);
    const brightness = alongArm
      ? (arm < 2 ? 0.18 : 0.13) * (0.7 + random() * 0.6)
      : 0.075 * (0.7 + random() * 0.6);
    const offset = index * 3;

    geometry.positions[offset] = Math.cos(theta) * radius;
    geometry.positions[offset + 1] = Math.sin(theta) * radius;
    geometry.positions[offset + 2] = z;
    geometry.colors[offset] = color[0] * brightness;
    geometry.colors[offset + 1] = color[1] * brightness;
    geometry.colors[offset + 2] = color[2] * brightness;
    geometry.sizes[index] = 4 + random() * 10;
    geometry.seeds[index] = random();
  }

  return geometry;
}

/**
 * 暗尘带：沿旋臂内侧偏移一点的暗棕点，正常混合画在星点之后，
 * 在亮臂上压出可见的尘埃纹理。颜色本身很暗，只负责「减光」。
 */
export function buildDustLanes(
  count: number,
  palette: GalaxyPalette = GALAXY_PALETTE,
  random: () => number = Math.random,
): GalaxyGeometry {
  const geometry = createGeometry(count);
  const dark = mixColor(hexToRgb(palette.dustDeep), hexToRgb(GALAXY_PALETTE.voidDeep), 0.55);

  for (let index = 0; index < geometry.count; index += 1) {
    const arm = pickArm(random);
    const base = ARM_BASES[arm];
    const radius = 0.16 + 0.82 * Math.pow(random(), 0.72);
    const spread = 0.035 + radius * 0.045;
    // +0.12 rad：落在旋臂的迎风侧，和旋臂形成明暗夹层。
    const theta = base + radius * SPIRAL_TURNS * TAU + 0.12 + gaussian(random) * spread;
    const z = 0.005 + gaussian(random) * 0.004;
    const offset = index * 3;
    const brightness = 0.7 + random() * 0.6;

    geometry.positions[offset] = Math.cos(theta) * radius;
    geometry.positions[offset + 1] = Math.sin(theta) * radius;
    geometry.positions[offset + 2] = z;
    geometry.colors[offset] = dark[0] * brightness;
    geometry.colors[offset + 1] = dark[1] * brightness;
    geometry.colors[offset + 2] = dark[2] * brightness;
    geometry.sizes[index] = 6 + random() * 12;
    geometry.seeds[index] = random();
  }

  return geometry;
}

/**
 * 背景星场：铺在相机前方的深空盒子里，独立于星系旋转。
 * 尺寸按相机 34° 视场、z ∈ [-26, -8] 估算，覆盖 21:9 到竖屏。
 */
export function buildStarField(
  count: number,
  palette: GalaxyPalette = GALAXY_PALETTE,
  random: () => number = Math.random,
): GalaxyGeometry {
  const geometry = createGeometry(count);
  const cool = hexToRgb(palette.coreWhite);
  const warm = hexToRgb(palette.gold);

  for (let index = 0; index < geometry.count; index += 1) {
    const z = -8 - random() * 18;
    const halfWidth = Math.abs(z) * 0.62;
    const color = mixColor(cool, warm, random() * 0.45);
    const brightness = 0.3 + random() * 0.7;
    const offset = index * 3;

    geometry.positions[offset] = (random() * 2 - 1) * halfWidth * 1.4;
    geometry.positions[offset + 1] = (random() * 2 - 1) * halfWidth;
    geometry.positions[offset + 2] = z;
    geometry.colors[offset] = color[0] * brightness;
    geometry.colors[offset + 1] = color[1] * brightness;
    geometry.colors[offset + 2] = color[2] * brightness;
    geometry.sizes[index] = 0.7 + Math.pow(random(), 3) * 2.2;
    geometry.seeds[index] = random();
  }

  return geometry;
}

/* ============================================================
   首页搜索（沿用 ADR-018，未改动）
   ============================================================ */

/** 首页搜索地址：空 / 纯空格返回 null，正常词条走 `encodeURIComponent`。 */
export function buildHomeSearchHref(raw: string): string | null {
  const q = raw.trim().slice(0, MAX_SEARCH_QUESTION);
  if (!q) return null;

  return `/search?q=${encodeURIComponent(q)}`;
}

export type HomeSearchAction =
  | { action: "ignore"; reason: "signed-out" | "composing" | "blank" }
  | { action: "navigate"; href: string; query: string };

/**
 * 首页一次提交的判定。未登录一律不产生地址，也就不会发出任何请求；
 * 输入法组合中（isComposing）不提交。
 */
export function resolveHomeSearchSubmit(input: {
  signedIn: boolean;
  value: string;
  composing?: boolean;
}): HomeSearchAction {
  if (!input.signedIn) {
    return { action: "ignore", reason: "signed-out" };
  }

  if (input.composing) {
    return { action: "ignore", reason: "composing" };
  }

  const href = buildHomeSearchHref(input.value);
  if (!href) {
    return { action: "ignore", reason: "blank" };
  }

  return { action: "navigate", href, query: input.value.trim() };
}
