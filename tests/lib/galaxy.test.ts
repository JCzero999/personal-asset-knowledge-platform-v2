import { describe, expect, it } from "vitest";

import { GALAXY_CONFIG, GALAXY_PALETTE } from "@/lib/galaxy-config";
import {
  breathingOffset,
  buildCoreBulge,
  buildDustLanes,
  buildHomeSearchHref,
  buildSpiralArms,
  buildStarField,
  computeParallaxTarget,
  dampValue,
  effectivePixelRatio,
  galaxyRotation,
  hexToRgb,
  isLowPerformanceDevice,
  mixColor,
  resolveGalaxyComposition,
  resolveGalaxyMode,
  resolveGalaxyQuality,
  resolveHomeSearchSubmit,
  resolvePosterSrc,
  sampleGalaxyColor,
  smoothstep,
} from "@/lib/galaxy";

/** 可复现的伪随机数，避免粒子断言随运行抖动。 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

describe("buildHomeSearchHref", () => {
  it("空输入与纯空格不产生地址", () => {
    expect(buildHomeSearchHref("")).toBeNull();
    expect(buildHomeSearchHref("   ")).toBeNull();
    expect(buildHomeSearchHref("\t\n")).toBeNull();
  });

  it("去掉首尾空格并拼成检索页地址", () => {
    expect(buildHomeSearchHref("  内容复盘 ")).toBe("/search?q=%E5%86%85%E5%AE%B9%E5%A4%8D%E7%9B%98");
  });

  it("特殊字符按 encodeURIComponent 编码，不会把查询串截断", () => {
    expect(buildHomeSearchHref("a&b=c#d")).toBe("/search?q=a%26b%3Dc%23d");
    expect(buildHomeSearchHref("空格 与 / 斜杠")).toBe(
      `/search?q=${encodeURIComponent("空格 与 / 斜杠")}`,
    );
  });

  it("超长输入截断到 200 字，与检索框 maxLength 一致", () => {
    const href = buildHomeSearchHref("啊".repeat(260));
    expect(href).not.toBeNull();
    expect(decodeURIComponent(href!.slice("/search?q=".length))).toHaveLength(200);
  });
});

describe("resolveHomeSearchSubmit", () => {
  it("未登录一律忽略，不产生任何地址（也就不会发请求）", () => {
    const result = resolveHomeSearchSubmit({ signedIn: false, value: "内容复盘" });
    expect(result).toEqual({ action: "ignore", reason: "signed-out" });
    expect(result).not.toHaveProperty("href");
  });

  it("输入法组合中不提交", () => {
    expect(resolveHomeSearchSubmit({ signedIn: true, value: "nihao", composing: true }))
      .toEqual({ action: "ignore", reason: "composing" });
  });

  it("空白输入不跳转", () => {
    expect(resolveHomeSearchSubmit({ signedIn: true, value: "   " }))
      .toEqual({ action: "ignore", reason: "blank" });
  });

  it("已登录且有关键词时给出检索地址", () => {
    expect(resolveHomeSearchSubmit({ signedIn: true, value: "  写作方法论 " })).toEqual({
      action: "navigate",
      href: `/search?q=${encodeURIComponent("写作方法论")}`,
      query: "写作方法论",
    });
  });
});

describe("resolveGalaxyQuality", () => {
  it("桌面默认：high 档、DPR 上限 2、60fps、总粒子等于五层之和", () => {
    const quality = resolveGalaxyQuality({
      viewportWidth: 1440,
      reducedMotion: false,
      lowPerformance: false,
    });

    expect(quality).toMatchObject({
      tier: "high",
      mobile: false,
      pixelRatioCap: 2,
      fpsCap: 60,
      animate: true,
    });
    expect(quality.arms).toBe(GALAXY_CONFIG.tiers.high.budget.arms);
    expect(quality.particleCount).toBe(
      quality.arms + quality.core + quality.haze + quality.dust + quality.stars,
    );
  });

  it("窄屏：balanced 档、DPR 1.5、30fps", () => {
    const quality = resolveGalaxyQuality({
      viewportWidth: 390,
      reducedMotion: false,
      lowPerformance: false,
    });

    expect(quality).toMatchObject({ tier: "balanced", mobile: true, pixelRatioCap: 1.5, fpsCap: 30 });
    expect(quality.particleCount).toBe(
      GALAXY_CONFIG.tiers.balanced.budget.arms
      + GALAXY_CONFIG.tiers.balanced.budget.core
      + GALAXY_CONFIG.tiers.balanced.budget.haze
      + GALAXY_CONFIG.tiers.balanced.budget.dust
      + GALAXY_CONFIG.tiers.balanced.budget.stars,
    );
    expect(quality.particleCount).toBeLessThan(GALAXY_CONFIG.tiers.high.budget.arms);
  });

  it("低性能设备即使大屏也走 balanced 档", () => {
    const quality = resolveGalaxyQuality({
      viewportWidth: 1440,
      reducedMotion: false,
      lowPerformance: true,
    });

    expect(quality.tier).toBe("balanced");
    expect(quality.fpsCap).toBe(30);
    expect(quality.pixelRatioCap).toBe(1.5);
  });

  it("prefers-reduced-motion 只关动画，不降粒子（静态图根本不建场景）", () => {
    const quality = resolveGalaxyQuality({
      viewportWidth: 1440,
      reducedMotion: true,
      lowPerformance: false,
    });

    expect(quality.animate).toBe(false);
    expect(quality.tier).toBe("high");
  });

  it("硬件探测只在 ≤2 核或 ≤2GB 时算低性能", () => {
    expect(isLowPerformanceDevice({ hardwareConcurrency: 2 })).toBe(true);
    expect(isLowPerformanceDevice({ deviceMemory: 2 })).toBe(true);
    expect(isLowPerformanceDevice({ hardwareConcurrency: 8, deviceMemory: 8 })).toBe(false);
    expect(isLowPerformanceDevice({})).toBe(false);
  });

  it("像素比被夹在 [1, cap] 之间", () => {
    const desktop = resolveGalaxyQuality({
      viewportWidth: 1440,
      reducedMotion: false,
      lowPerformance: false,
    });
    expect(effectivePixelRatio(desktop, 4)).toBe(2);
    expect(effectivePixelRatio(desktop, 0.5)).toBe(1);
    expect(effectivePixelRatio(desktop, Number.NaN)).toBe(1);
  });
});

describe("降级链", () => {
  it("reduced-motion 与强制静态都走静态图", () => {
    expect(resolveGalaxyMode({ reducedMotion: true, webglAvailable: true })).toBe("poster");
    expect(resolveGalaxyMode({ reducedMotion: false, webglAvailable: true, forceStatic: true })).toBe("poster");
  });

  it("WebGL 不可用走 fallback（静态图 + CSS 星点）", () => {
    expect(resolveGalaxyMode({ reducedMotion: false, webglAvailable: false })).toBe("fallback");
  });

  it("默认走 WebGL", () => {
    expect(resolveGalaxyMode({ reducedMotion: false, webglAvailable: true })).toBe("webgl");
  });

  it("静态图按视口选移动版/桌面版", () => {
    expect(resolvePosterSrc(390)).toBe(GALAXY_CONFIG.poster.mobile);
    expect(resolvePosterSrc(1440)).toBe(GALAXY_CONFIG.poster.desktop);
  });
});

describe("构图换算", () => {
  it("16:9 桌面上星系直径正好铺满视口宽（fill 0.5）", () => {
    const composition = resolveGalaxyComposition({ aspect: 16 / 9, mobile: false });
    expect((composition.scale * 2) / composition.visibleWidth).toBeCloseTo(
      GALAXY_CONFIG.composition.desktop.fill * 2,
      5,
    );
  });

  it("中心偏左半屏、视口中线以下：centerX 0.412 / centerY 0.55", () => {
    const composition = resolveGalaxyComposition({ aspect: 16 / 9, mobile: false });
    // centerX 0.412 < 0.5 → 世界偏移为负（屏幕左侧）。
    expect(composition.offsetX).toBeLessThan(0);
    // centerY 0.55 > 0.5 → 世界 Y 为负（three.js 中向下）。
    expect(composition.offsetY).toBeLessThan(0);
    expect(GALAXY_CONFIG.composition.desktop.centerX).toBeCloseTo(0.412, 5);
    expect(GALAXY_CONFIG.composition.mobile.centerX).toBeCloseTo(0.436, 5);
  });

  it("观察面翻到背面，自转方向同步取反", () => {
    for (const mobile of [false, true]) {
      const composition = resolveGalaxyComposition({ aspect: 16 / 9, mobile });
      expect(composition.facingRad).toBeCloseTo(Math.PI, 6);
      expect(composition.spinSign).toBe(-1);
    }
    expect(GALAXY_CONFIG.facingDeg).toBe(180);
  });

  it("竖屏把星系撑到超出满宽，两档 centerY 一致（0.55）", () => {
    const portrait = resolveGalaxyComposition({ aspect: 1170 / 2532, mobile: true });
    const landscape = resolveGalaxyComposition({ aspect: 1170 / 2532, mobile: false });

    // 竖屏用移动构图：fill 0.56 → 直径 112% 视口宽，两侧各溢出一截。
    expect((portrait.scale * 2) / portrait.visibleWidth).toBeCloseTo(
      GALAXY_CONFIG.composition.mobile.fill * 2,
      5,
    );
    expect((portrait.scale * 2) / portrait.visibleWidth)
      .toBeGreaterThan((landscape.scale * 2) / landscape.visibleWidth);
    expect(portrait.scale).toBeGreaterThan(landscape.scale);
    // 两档 centerY 都是 0.55，纵向偏移只随可见高度变化。
    expect(portrait.offsetY).toBeCloseTo(landscape.offsetY, 6);
    expect(GALAXY_CONFIG.composition.desktop.centerY).toBeCloseTo(0.55, 5);
    expect(GALAXY_CONFIG.composition.mobile.centerY).toBeCloseTo(0.55, 5);
  });

  it("放大后星盘直径铺满视口宽、旋臂外缘必然越界，靠 CSS 边缘柔化淡出", () => {
    expect(GALAXY_CONFIG.composition.desktop.fill).toBeCloseTo(0.5, 5);
    expect(GALAXY_CONFIG.composition.mobile.fill).toBeCloseTo(0.56, 5);

    const desktop = resolveGalaxyComposition({ aspect: 16 / 9, mobile: false });
    // 直径 == 视口宽（0.5×2），而旋臂最外半径 1.06 会再溢出 6%，
    // 所以 globals.css 里 .galaxy-scene 的 36–88px 柔化带是必需的。
    expect(desktop.scale * 2 / desktop.visibleWidth).toBeCloseTo(1, 5);
    // 但也不能放大到失控（直径超过视口宽 1.25 倍就说明 fill 调错了）。
    expect(desktop.scale * 2).toBeLessThan(desktop.visibleWidth * 1.25);
  });

  it("亮核上沿留在搜索框下沿之下，放大后不会顶到搜索框", () => {
    // 实测来源（1440×900 / 390×844 截图）：搜索框底边 47.3% / 46.7% 视口高，
    // 亮核（92% 峰值阈值）纵向半高约 3%，这里按 5% 留余量取上界。
    const SEARCH_BOX_BOTTOM = 0.475;
    const CORE_HALF_HEIGHT = 0.05;
    for (const preset of [
      GALAXY_CONFIG.composition.desktop,
      GALAXY_CONFIG.composition.mobile,
    ]) {
      expect(preset.centerY - CORE_HALF_HEIGHT).toBeGreaterThan(SEARCH_BOX_BOTTOM);
    }
  });

  it("异常的 aspect 被夹到合理范围，不会算出 NaN", () => {
    for (const aspect of [0, -1, Number.NaN, 99]) {
      const composition = resolveGalaxyComposition({ aspect, mobile: false });
      expect(Number.isFinite(composition.scale)).toBe(true);
      expect(composition.scale).toBeGreaterThan(0);
    }
  });
});

describe("运动数学", () => {
  it("自转一周正好 90 秒（配置区间 60–120 内）", () => {
    const period = GALAXY_CONFIG.rotation.periodSeconds * 1000;
    expect(GALAXY_CONFIG.rotation.periodSeconds).toBeGreaterThanOrEqual(60);
    expect(GALAXY_CONFIG.rotation.periodSeconds).toBeLessThanOrEqual(120);
    expect(galaxyRotation(0)).toBe(0);
    expect(galaxyRotation(period / 2)).toBeCloseTo(Math.PI, 6);
    // 取模：整整一圈回到 0，渲染上不会跳回 2π。
    expect(galaxyRotation(period)).toBeCloseTo(0, 6);
    expect(galaxyRotation(period * 1.5)).toBeCloseTo(Math.PI, 6);
  });

  it("非法周期不产生 NaN", () => {
    expect(galaxyRotation(1000, 0)).toBe(0);
    expect(galaxyRotation(1000, Number.NaN)).toBe(0);
  });

  it("阻尼每过一个半衰期差距减半，且与帧率无关", () => {
    expect(dampValue(0, 1, 520, 520)).toBeCloseTo(0.5, 6);
    expect(dampValue(0, 1, 1040, 520)).toBeCloseTo(0.75, 6);
    // 两帧 8ms 与一帧 16ms 结果一致
    const stepwise = dampValue(dampValue(0, 1, 8, 520), 1, 8, 520);
    expect(stepwise).toBeCloseTo(dampValue(0, 1, 16, 520), 6);
    expect(dampValue(0.3, 1, 16, 0)).toBe(1);
  });

  it("视差目标被夹在最大角内，非法指针按 0 处理", () => {
    const max = (GALAXY_CONFIG.parallax.maxDeg * Math.PI) / 180;
    expect(computeParallaxTarget(0.5, -0.5, max)).toEqual({ x: -0.5 * max, y: 0.5 * max });
    expect(computeParallaxTarget(3, -3, max)).toEqual({ x: -max, y: max });
    expect(computeParallaxTarget(Number.NaN, Number.NaN, max)).toEqual({ x: 0, y: 0 });
  });

  it("呼吸曲线首尾相接、幅度对称", () => {
    expect(breathingOffset(0, 26)).toBeCloseTo(0, 6);
    expect(breathingOffset(13000, 26)).toBeCloseTo(0, 6);
    expect(breathingOffset(6500, 26)).toBeCloseTo(1, 6);
    expect(breathingOffset(19500, 26)).toBeCloseTo(-1, 6);
    expect(breathingOffset(1000, 0)).toBe(0);
  });

  it("smoothstep 在边界外饱和", () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 6);
  });
});

describe("配色采样", () => {
  it("hex 解析支持 3 位与 6 位，非法值回落为黑", () => {
    expect(hexToRgb("#fff")).toEqual([1, 1, 1]);
    expect(hexToRgb("#FFF7E6")).toEqual([1, 247 / 255, 230 / 255]);
    expect(hexToRgb("not-a-color")).toEqual([0, 0, 0]);
  });

  it("混色在两端点处精确落值", () => {
    expect(mixColor([0, 0, 0], [1, 1, 1], 0)).toEqual([0, 0, 0]);
    expect(mixColor([0, 0, 0], [1, 1, 1], 1)).toEqual([1, 1, 1]);
    expect(mixColor([0, 0, 0], [1, 1, 1], 2)).toEqual([1, 1, 1]);
  });

  it("半径 0 取核球亮白，半径 1 取最外暗紫", () => {
    expect(sampleGalaxyColor(0)).toEqual(hexToRgb(GALAXY_PALETTE.coreWhite));
    expect(sampleGalaxyColor(1)).toEqual(hexToRgb(GALAXY_PALETTE.violetDeep));
  });

  it("外圈整体比核心暗：亮度随半径单调不增（抽样点）", () => {
    const luminance = (c: readonly [number, number, number]) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
    const samples = [0, 0.2, 0.45, 0.7, 0.9, 1].map((r) => luminance(sampleGalaxyColor(r)));
    for (let index = 1; index < samples.length; index += 1) {
      expect(samples[index]).toBeLessThanOrEqual(samples[index - 1] + 1e-6);
    }
  });
});

describe("几何生成", () => {
  it("旋臂点落在盘面内，z 很薄，颜色与尺寸合法", () => {
    const geometry = buildSpiralArms(600, GALAXY_PALETTE, seededRandom(7));

    expect(geometry.count).toBe(600);
    expect(geometry.positions).toHaveLength(600 * 3);
    for (let index = 0; index < geometry.count; index += 1) {
      const x = geometry.positions[index * 3];
      const y = geometry.positions[index * 3 + 1];
      const z = geometry.positions[index * 3 + 2];
      const radius = Math.hypot(x, y);
      expect(radius).toBeLessThanOrEqual(1.1);
      expect(Math.abs(z)).toBeLessThan(0.1);
      for (let channel = 0; channel < 3; channel += 1) {
        const value = geometry.colors[index * 3 + channel];
        expect(value).toBeGreaterThanOrEqual(0);
        // 颜色已乘亮度系数，允许略超 1 作为加法混合的高光余量。
        expect(value).toBeLessThanOrEqual(1.4);
      }
      expect(geometry.sizes[index]).toBeGreaterThan(0.8);
      expect(geometry.sizes[index]).toBeLessThan(8.5);
      expect(geometry.seeds[index]).toBeGreaterThanOrEqual(0);
      expect(geometry.seeds[index]).toBeLessThan(1);
    }
  });

  it("核球比旋臂更集中：平均半径显著更小", () => {
    const core = buildCoreBulge(400, GALAXY_PALETTE, seededRandom(3));
    const arms = buildSpiralArms(400, GALAXY_PALETTE, seededRandom(3));
    const meanRadius = (positions: Float32Array) => {
      let total = 0;
      for (let i = 0; i < positions.length; i += 3) total += Math.hypot(positions[i], positions[i + 1]);
      return total / (positions.length / 3);
    };

    expect(meanRadius(core.positions)).toBeLessThan(0.2);
    expect(meanRadius(arms.positions)).toBeGreaterThan(0.2);
  });

  it("暗尘带颜色足够暗，只负责减光", () => {
    const dust = buildDustLanes(200, GALAXY_PALETTE, seededRandom(5));
    for (let index = 0; index < dust.count; index += 1) {
      const r = dust.colors[index * 3];
      const g = dust.colors[index * 3 + 1];
      const b = dust.colors[index * 3 + 2];
      expect(Math.max(r, g, b)).toBeLessThan(0.5);
    }
  });

  it("背景星场铺在相机前方，覆盖整个视口", () => {
    const stars = buildStarField(300, GALAXY_PALETTE, seededRandom(11));
    let minX = Infinity;
    let maxX = -Infinity;
    for (let index = 0; index < stars.count; index += 1) {
      const z = stars.positions[index * 3 + 2];
      expect(z).toBeLessThanOrEqual(-8);
      expect(z).toBeGreaterThanOrEqual(-26);
      minX = Math.min(minX, stars.positions[index * 3]);
      maxX = Math.max(maxX, stars.positions[index * 3]);
    }
    expect(minX).toBeLessThan(-8);
    expect(maxX).toBeGreaterThan(8);
  });

  it("同一种子得到同一批粒子，便于回归对比", () => {
    const first = buildSpiralArms(40, GALAXY_PALETTE, seededRandom(42));
    const second = buildSpiralArms(40, GALAXY_PALETTE, seededRandom(42));
    expect(Array.from(first.positions)).toEqual(Array.from(second.positions));
    expect(Array.from(first.colors)).toEqual(Array.from(second.colors));
  });

  it("粒子数为 0 时返回空几何而不是抛错", () => {
    const empty = buildSpiralArms(0);
    expect(empty.count).toBe(0);
    expect(empty.positions).toHaveLength(0);
  });
});
