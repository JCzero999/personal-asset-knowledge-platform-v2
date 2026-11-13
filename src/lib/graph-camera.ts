/**
 * 3D 星系取景（B 线，2026-11-13；ADR-022 附录 A8 的「机位」从常量改为按容器求值）。
 *
 * 为什么要有这一层：
 * - 原机位是写死的世界坐标 `[0, 142, 550]`，只对「1180px 宽 × 56vh 高」那张卡片调过
 *   （实测亮部占舞台 75–85%）。画布铺满内容区后宽高比变大，垂直 FOV 不变 ⇒ 星系在
 *   屏幕上按高度缩放，左右留白更多，看起来「星图变小了」。
 * - 窄屏（390×844，宽高比 <1）反过来：水平 FOV 被裁，外环会被切掉。
 *
 * 做法：不改视线方向（俯角 14.48°，仍指向原点），只按布局的实际投影求距离：
 * 对每个节点解出「它刚好落在 fill 位置」所需的最小距离，取最大值。
 * 两头都约束（水平用 tan(vfov/2)·aspect，垂直用 tan(vfov/2)），所以宽屏不会被拉远、
 * 窄屏会自动退到能装下外环的距离。
 *
 * 纯几何：不 import three / React，坐标与世界单位同 `graph-layout-3d.ts`。
 */

const DEG = Math.PI / 180;

/** 相机垂直 FOV，与 ADR-022 附录 A8 一致。 */
export const GALAXY_FOV_DEGREES = 45;

/**
 * 视线方向由旧的固定机位推出：`atan2(142, 550) ≈ 14.47°`。
 * 改距离不改方向，用户熟悉的俯视角度不变。
 */
export const GALAXY_CAMERA_ELEVATION_DEGREES = (Math.atan2(142, 550) * 180) / Math.PI;

/** OrbitControls 的距离范围（ADR-022 A3.1 / A8）。宽屏取景落在区间内，控制器不改。 */
export const GALAXY_CAMERA_MIN_DISTANCE = 260;
export const GALAXY_CAMERA_MAX_DISTANCE = 1100;

/**
 * 窄屏取景的硬上限：画布变成「竖长条」（390×844 下实测 314×844，宽高比 0.37）时，
 * 要整幅装下外环需要 1500+ 的机位。取景可以突破 ADR 的 1100（1100 是宽屏卡片时代的
 * 手感上限），但不能无界——2400 是 far=4000 之内、星场（±700/±450/±300）仍在身前的量级。
 */
export const GALAXY_CAMERA_HARD_MAX_DISTANCE = 2400;

/** 旧机位 `[0, 142, 550]` 的距离，作为首帧（布局未定时）的兜底。 */
export const GALAXY_CAMERA_FALLBACK_DISTANCE = Math.hypot(142, 550);

/**
 * 目标占位：最外侧节点约占半视口的 94%（全高的 94% / 全宽的 94%）。
 * 这个值是从旧机位反推的：`[0,142,550]` 在 1180×504 的舞台上实测垂直占位 0.92，
 * 也就是旧构图本来就贴着上下边（剩余约 6% 留给光晕）。取 0.94 让宽屏维持同一观感，
 * 同时由「转角扫描」保证自转一圈都不裁切。
 */
export const GALAXY_FRAME_FILL = 0.94;

/**
 * 取景时扫描的转角数：绕 Y 转一圈采样 24 个角度（15° 一档），取最大投影。
 * 自转会把某个方位的「高 y + 远 z」节点转到最近处，只按初始角度取景会在转到那里时裁切。
 * 24 × ≤2000 个点是纯数字运算，一次取景不到 1ms，只在挂载 / 改尺寸 / 换布局时算。
 */
export const GALAXY_FRAME_ROTATION_STEPS = 24;

/** 相机方向（原点 → 相机），单位向量：`[0, sin e, cos e]`。 */
export const GALAXY_CAMERA_DIRECTION: readonly [number, number, number] = [
  0,
  Math.sin(GALAXY_CAMERA_ELEVATION_DEGREES * DEG),
  Math.cos(GALAXY_CAMERA_ELEVATION_DEGREES * DEG),
];

export interface GalaxyFramingInput {
  /** xyz 交错的位置数组（`GalaxyLayoutResult.positions`）。 */
  readonly positions: ArrayLike<number>;
  /** 节点数（`ids.length`）；只读前 `count` 个点。 */
  readonly count: number;
  /** 画布宽高比 = width / height；非法值按 16:9 处理。 */
  readonly aspect: number;
  /**
   * 指定单个转角（弧度）时只按这一个姿态取景；省略时按 `rotationSteps` 扫一整圈，
   * 取最大投影——自转过程中任何角度都不裁切。
   */
  readonly rotationRadians?: number;
  /** 扫描档数，默认 24（15° 一档）；仅在 `rotationRadians` 省略时生效。 */
  readonly rotationSteps?: number;
  readonly fovDegrees?: number;
  readonly elevationDegrees?: number;
  /** 目标占位，默认 0.94；夹到 0.3–0.98，避免 0 或 >1 算出无意义距离。 */
  readonly fill?: number;
  readonly minDistance?: number;
  readonly maxDistance?: number;
}

export interface GalaxyFraming {
  /** 相机到原点的距离（世界单位），已夹到 [minDistance, maxDistance]。 */
  readonly distance: number;
  /** 夹取前的需求距离：用来判断「这段机位是不是被上限截断了」。 */
  readonly requestedDistance: number;
  /** 相机位置 = direction × distance。 */
  readonly direction: readonly [number, number, number];
  /** 该距离下，最外侧节点在半视口里的占比（0–1，1 = 贴边）。 */
  readonly fractionX: number;
  readonly fractionY: number;
  /** 哪个方向把相机推远了。空图 / 只有原点节点时为 `none`。 */
  readonly boundBy: "horizontal" | "vertical" | "none";
  /** 距离被 min/max 夹过（视野装不下或近到会穿进中心）。 */
  readonly clamped: boolean;
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 求取景距离。纯函数：同输入同输出，不读时钟、不读 devicePixelRatio。
 *
 * 解算：相机在 `u·d`（u 为单位方向），节点 p 的深度为 `d - p·u`，半视口上限为
 * `fill·tanH`（水平）/ `fill·tanV`（垂直）。要求 `|x| / ((d - p·u)·tanH) ≤ fill`，
 * 等价于 `d ≥ p·u + |x| / (fill·tanH)`。对全部节点取最大即可。
 */
export function fitGalaxyCamera(input: GalaxyFramingInput): GalaxyFraming {
  const aspect = finite(input.aspect, 16 / 9) > 0 ? finite(input.aspect, 16 / 9) : 16 / 9;
  const fovDegrees = clamp(finite(input.fovDegrees ?? GALAXY_FOV_DEGREES, GALAXY_FOV_DEGREES), 10, 120);
  const elevationDegrees = finite(
    input.elevationDegrees ?? GALAXY_CAMERA_ELEVATION_DEGREES,
    GALAXY_CAMERA_ELEVATION_DEGREES,
  );
  const fill = clamp(finite(input.fill ?? GALAXY_FRAME_FILL, GALAXY_FRAME_FILL), 0.3, 0.98);
  const minDistance = Math.max(1, finite(input.minDistance ?? GALAXY_CAMERA_MIN_DISTANCE, GALAXY_CAMERA_MIN_DISTANCE));
  const maxDistance = Math.max(minDistance, finite(input.maxDistance ?? GALAXY_CAMERA_MAX_DISTANCE, GALAXY_CAMERA_MAX_DISTANCE));

  const fovRad = fovDegrees * DEG;
  const tanV = Math.tan(fovRad / 2);
  const tanH = tanV * aspect;

  const elevation = elevationDegrees * DEG;
  const uy = Math.sin(elevation);
  const uz = Math.cos(elevation);
  const upY = Math.cos(elevation);
  const upZ = -Math.sin(elevation);

  const positions = input.positions;
  const count = Math.max(0, Math.min(input.count, Math.floor(positions.length / 3)));
  // 自转是绕 Y 的匀速旋转：取景按一整圈扫描，任何角度都不裁切。
  const steps =
    input.rotationRadians !== undefined
      ? 1
      : Math.max(
          1,
          Math.min(
            64,
            Math.round(finite(input.rotationSteps ?? GALAXY_FRAME_ROTATION_STEPS, GALAXY_FRAME_ROTATION_STEPS)),
          ),
        );
  const rotationOf = (step: number): number =>
    input.rotationRadians !== undefined ? finite(input.rotationRadians, 0) : (step / steps) * Math.PI * 2;

  let needX = 0;
  let needY = 0;
  let nodes = 0;

  for (let step = 0; step < steps; step += 1) {
    const rotation = rotationOf(step);
    const cosR = Math.cos(rotation);
    const sinR = Math.sin(rotation);

    for (let index = 0; index < count; index += 1) {
      // three 绕 Y 的旋转：x' = x·cos + z·sin，z' = -x·sin + z·cos。
      const x0 = positions[index * 3];
      const y = positions[index * 3 + 1];
      const z0 = positions[index * 3 + 2];
      if (!Number.isFinite(x0) || !Number.isFinite(y) || !Number.isFinite(z0)) continue;

      const x = x0 * cosR + z0 * sinR;
      const z = -x0 * sinR + z0 * cosR;

      const depth = y * uy + z * uz;
      const up = y * upY + z * upZ;

      // 深度可能让节点跑到相机后面（病态输入）：退化处理，不让距离变成负数。
      const nearDepth = Math.max(-1000, depth);

      needX = Math.max(needX, nearDepth + Math.abs(x) / (fill * tanH));
      needY = Math.max(needY, nearDepth + Math.abs(up) / (fill * tanV));
      if (step === 0) nodes += 1;
    }
  }

  if (nodes === 0) {
    return {
      distance: minDistance,
      requestedDistance: minDistance,
      direction: GALAXY_CAMERA_DIRECTION,
      fractionX: 0,
      fractionY: 0,
      boundBy: "none",
      clamped: false,
    };
  }

  const wanted = Math.max(needX, needY, minDistance);
  const distance = clamp(wanted, minDistance, maxDistance);

  // 夹取后复算实际占比：给测试与调试用，不参与取景。
  let fractionX = 0;
  let fractionY = 0;
  for (let step = 0; step < steps; step += 1) {
    const rotation = rotationOf(step);
    const cosR = Math.cos(rotation);
    const sinR = Math.sin(rotation);
    for (let index = 0; index < count; index += 1) {
      const x0 = positions[index * 3];
      const y = positions[index * 3 + 1];
      const z0 = positions[index * 3 + 2];
      if (!Number.isFinite(x0) || !Number.isFinite(y) || !Number.isFinite(z0)) continue;
      const x = x0 * cosR + z0 * sinR;
      const z = -x0 * sinR + z0 * cosR;
      const depth = y * uy + z * uz;
      const up = y * upY + z * upZ;
      const viewDepth = Math.max(1e-3, distance - depth);
      fractionX = Math.max(fractionX, Math.abs(x) / (viewDepth * tanH));
      fractionY = Math.max(fractionY, Math.abs(up) / (viewDepth * tanV));
    }
  }

  return {
    distance,
    requestedDistance: wanted,
    direction: GALAXY_CAMERA_DIRECTION,
    fractionX,
    fractionY,
    boundBy: needX >= needY ? "horizontal" : "vertical",
    clamped: distance !== wanted,
  };
}

/**
 * 换画布尺寸时的距离：保留用户此前的缩放倍数。
 * `previousFit` 是上次取景算出的距离，`currentDistance` 是相机此刻到原点的距离。
 * 用户没缩放过时两者相等 ⇒ 结果就是新取景距离。
 */
export function rescaleForViewport(input: {
  nextFitDistance: number;
  previousFitDistance: number;
  currentDistance: number;
  minDistance?: number;
  maxDistance?: number;
}): number {
  const minDistance = input.minDistance ?? GALAXY_CAMERA_MIN_DISTANCE;
  const maxDistance = input.maxDistance ?? GALAXY_CAMERA_MAX_DISTANCE;
  const previous = finite(input.previousFitDistance, 0);
  const current = finite(input.currentDistance, 0);
  if (previous <= 0 || current <= 0) {
    return clamp(finite(input.nextFitDistance, minDistance), minDistance, maxDistance);
  }
  return clamp(input.nextFitDistance * (current / previous), minDistance, maxDistance);
}
