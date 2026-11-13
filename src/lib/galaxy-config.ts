/**
 * 首页星系场景的配置中心（Phase 5 / ADR-020）。
 *
 * 取色与构图以 `docs/reference/galaxy-reference.png` 为基准：深空纯黑、
 * 明亮黄白核心、暖金过渡、尘埃棕与灰紫旋臂。组件、着色器与 CSS 不写
 * 裸数值／裸色值，统一从这里读，调一处即可整体生效。
 */

export interface GalaxyPalette {
  /** 最外层深空底，接近纯黑。 */
  readonly voidDeep: string;
  /** 页面底色（略暖于纯黑，避免死黑发青）。 */
  readonly voidBase: string;
  /** 核球最亮处。 */
  readonly coreWhite: string;
  /** 核球边缘的暖黄。 */
  readonly coreWarm: string;
  /** 品牌强调金。 */
  readonly gold: string;
  /** 金色暗部（旋臂内侧）。 */
  readonly goldDeep: string;
  /** 尘埃棕（中段旋臂）。 */
  readonly dust: string;
  /** 尘埃棕暗部（暗尘带）。 */
  readonly dustDeep: string;
  /** 灰紫（外圈旋臂）。 */
  readonly violetGrey: string;
  /** 暗紫（最外围）。 */
  readonly violetDeep: string;
  /** 正文主色（与全局 --text-1 一致）。 */
  readonly ink: string;
  /** 次级文字。 */
  readonly inkMuted: string;
  /** 三级文字。 */
  readonly inkFaint: string;
}

/** 视觉基准取样色。改这里等于改整套首页配色。 */
export const GALAXY_PALETTE: GalaxyPalette = {
  voidDeep: "#050408",
  voidBase: "#07060B",
  coreWhite: "#FFF7E6",
  coreWarm: "#FFE3B8",
  gold: "#E9C08A",
  goldDeep: "#C99B62",
  dust: "#8A6E5A",
  dustDeep: "#5A4638",
  violetGrey: "#7E718C",
  violetDeep: "#4A3F57",
  ink: "#F3EFE7",
  inkMuted: "#C2B8AC",
  inkFaint: "#93897E",
};

/** 单档画质下的粒子预算。四类点分别独立计数，便于验收时逐项读数。 */
export interface GalaxyParticleBudget {
  /** 旋臂星点。 */
  readonly arms: number;
  /** 核球星点。 */
  readonly core: number;
  /** 盘面薄雾（大而暗的软点，把旋臂连成连续的尘埃带）。 */
  readonly haze: number;
  /** 暗尘带粒子（正常混合，压在旋臂上刻出尘带）。 */
  readonly dust: number;
  /** 背景星场。 */
  readonly stars: number;
}

export interface GalaxyQualityTier {
  readonly id: "high" | "balanced";
  readonly budget: GalaxyParticleBudget;
  /** `devicePixelRatio` 上限。 */
  readonly pixelRatioCap: number;
  /** 绘制帧率上限。 */
  readonly fpsCap: number;
  /** 点精灵尺寸系数（相对基准，1 为桌面基准，0.9 为移动端）。 */
  readonly pointScale: number;
}

export interface GalaxyCompositionPreset {
  /** 星系中心在视口中的横向位置（0..1）。 */
  readonly centerX: number;
  /** 星系中心在视口中的纵向位置（0..1）。 */
  readonly centerY: number;
  /** 星系半径占可视宽度的比例（0.42 → 直径占 84% 宽）。 */
  readonly fill: number;
  /** 盘面长轴的屏幕倾角（度，负数向右上抬）。 */
  readonly rollDeg: number;
}

export interface GalaxyConfig {
  readonly rotation: {
    /** 自转一周的秒数（需求区间 60–120）。 */
    readonly periodSeconds: number;
    /** 静态截图（poster）定格的自转角（弧度）。 */
    readonly posterAngleRad: number;
  };
  readonly camera: {
    readonly fovDeg: number;
    readonly distance: number;
    readonly near: number;
    readonly far: number;
    /** 盘面绕 X 轴的倾斜角：越接近 90° 越「侧视」。 */
    readonly tiltDeg: number;
  };
  readonly composition: {
    readonly desktop: GalaxyCompositionPreset;
    readonly mobile: GalaxyCompositionPreset;
  };
  /**
   * 观察面：0 为正面（原朝向），180 为翻到背面观看。
   *
   * 作用在 tilt / spin 之上的整体层，对 arms、core、haze、dust 一起生效：
   * 屏幕上左右镜像、旋臂缠绕方向反转、盘面倾角方向同样镜像。自转角会
   * 同步取反，翻面后看起来仍是同一个转向，不会「倒着转」。
   */
  readonly facingDeg: number;
  /** 整体亮度（1 为基准，写实需求下略低于 1 更耐看）。 */
  readonly brightness: number;
  readonly parallax: {
    readonly enabled: boolean;
    /** 指针到画面边缘时的最大偏移角（度）。 */
    readonly maxDeg: number;
    /** 阻尼半衰期（ms），越大越「黏」。 */
    readonly halfLifeMs: number;
  };
  /** 相机极轻的呼吸浮动，避免画面完全静止。 */
  readonly breathing: {
    readonly enabled: boolean;
    readonly amplitudeDeg: number;
    readonly periodSeconds: number;
  };
  readonly twinkle: {
    /** 旋臂星点的闪烁幅度（0 为不闪）。 */
    readonly arms: number;
    /** 背景星点的闪烁幅度。 */
    readonly stars: number;
    readonly speed: number;
  };
  readonly dust: {
    readonly opacity: number;
  };
  /** 窄屏阈值：低于该宽度走移动构图与移动画质。 */
  readonly mobileBreakpoint: number;
  readonly tiers: {
    readonly high: GalaxyQualityTier;
    readonly balanced: GalaxyQualityTier;
  };
  /** 静态降级图：由本项目场景在无头 Chrome 里渲染，存于 public/galaxy。 */
  readonly poster: {
    readonly desktop: string;
    readonly mobile: string;
    readonly desktopSize: readonly [number, number];
    readonly mobileSize: readonly [number, number];
  };
  /** 帧耗时统计窗口（只统计前 N 帧，避免冷启动抖动被稀释）。 */
  readonly frameSampleFrames: number;
}

export const GALAXY_CONFIG = {
  rotation: {
    periodSeconds: 90,
    posterAngleRad: 0.62,
  },
  camera: {
    fovDeg: 34,
    distance: 10,
    near: 0.1,
    far: 200,
    tiltDeg: 64,
  },
  composition: {
    desktop: { centerX: 0.412, centerY: 0.55, fill: 0.5, rollDeg: -14 },
    mobile: { centerX: 0.436, centerY: 0.55, fill: 0.56, rollDeg: -22 },
  },
  facingDeg: 180,
  brightness: 1.78,
  parallax: {
    enabled: true,
    maxDeg: 1.4,
    halfLifeMs: 520,
  },
  breathing: {
    enabled: true,
    amplitudeDeg: 0.32,
    periodSeconds: 26,
  },
  twinkle: {
    arms: 0.18,
    stars: 0.45,
    speed: 0.9,
  },
  dust: {
    opacity: 0.24,
  },
  mobileBreakpoint: 720,
  tiers: {
    high: {
      id: "high",
      budget: { arms: 34000, core: 9000, haze: 6000, dust: 8500, stars: 1100 },
      pixelRatioCap: 2,
      fpsCap: 60,
      pointScale: 1,
    },
    balanced: {
      id: "balanced",
      budget: { arms: 14000, core: 3600, haze: 2400, dust: 3200, stars: 460 },
      pixelRatioCap: 1.5,
      fpsCap: 30,
      pointScale: 0.9,
    },
  },
  poster: {
    desktop: "/galaxy/galaxy-1920x1080.jpg",
    mobile: "/galaxy/galaxy-1170x2532.jpg",
    desktopSize: [1920, 1080],
    mobileSize: [1170, 2532],
  },
  frameSampleFrames: 180,
} satisfies GalaxyConfig;
