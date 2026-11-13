import { describe, expect, it } from "vitest";

import {
  GALAXY_CAMERA_DIRECTION,
  GALAXY_CAMERA_FALLBACK_DISTANCE,
  GALAXY_CAMERA_HARD_MAX_DISTANCE,
  GALAXY_CAMERA_MAX_DISTANCE,
  GALAXY_CAMERA_MIN_DISTANCE,
  GALAXY_FRAME_FILL,
  fitGalaxyCamera,
  rescaleForViewport,
} from "@/lib/graph-camera";

/**
 * 3D 取景的纯几何（ADR-022 A8「机位」）：不测 WebGL，只断言投影与距离。
 * 画布从固定卡片改为全幅后，宽高比是唯一变化的输入——这里把它当参数逐个验证。
 */

/** 一个半径 `radius` 的圆环 + 少量高度，模拟三层盘的外轮廓。 */
function ring(count: number, radius: number, lift = 0): Float32Array {
  const positions = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2;
    positions[index * 3] = Math.cos(angle) * radius;
    positions[index * 3 + 1] = lift === 0 ? 0 : Math.sin(angle * 3) * lift;
    positions[index * 3 + 2] = Math.sin(angle) * radius;
  }
  return positions;
}

/** 视角方向必须是「正上方俯视、无左右偏移」：x=0 且落在单位圆上。 */
describe("GALAXY_CAMERA_DIRECTION", () => {
  it("方向由旧机位的俯角推出，长度 1、x=0（中心不偏左右）", () => {
    const [x, y, z] = GALAXY_CAMERA_DIRECTION;
    expect(x).toBe(0);
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 10);
    expect(y / z).toBeCloseTo(142 / 550, 6);
  });

  it("兜底机位与旧的写死机位 [0,142,550] 等价（误差 <0.01）", () => {
    expect(GALAXY_CAMERA_DIRECTION[1] * GALAXY_CAMERA_FALLBACK_DISTANCE).toBeCloseTo(142, 2);
    expect(GALAXY_CAMERA_DIRECTION[2] * GALAXY_CAMERA_FALLBACK_DISTANCE).toBeCloseTo(550, 2);
  });
});

describe("fitGalaxyCamera：宽高比", () => {
  const positions = ring(120, 220, 40);

  it("宽屏（16:9 与 21:9）都能装下：两个方向都不超过目标占位", () => {
    for (const aspect of [16 / 9, 21 / 9, 2.34]) {
      const framing = fitGalaxyCamera({ positions, count: 120, aspect });
      expect(framing.fractionX).toBeLessThanOrEqual(GALAXY_FRAME_FILL + 1e-6);
      expect(framing.fractionY).toBeLessThanOrEqual(GALAXY_FRAME_FILL + 1e-6);
      expect(framing.distance).toBeGreaterThan(GALAXY_CAMERA_MIN_DISTANCE);
      expect(framing.clamped).toBe(false);
    }
  });

  it("画布越窄，相机退得越远（水平方向先撑不住）", () => {
    const small = ring(120, 90, 30);
    const wide = fitGalaxyCamera({ positions: small, count: 120, aspect: 21 / 9 });
    const square = fitGalaxyCamera({ positions: small, count: 120, aspect: 1 });
    const phone = fitGalaxyCamera({ positions: small, count: 120, aspect: 390 / 844 });
    expect(square.distance).toBeGreaterThanOrEqual(wide.distance - 1e-9);
    expect(phone.distance).toBeGreaterThan(square.distance);
    expect(phone.fractionX).toBeLessThanOrEqual(GALAXY_FRAME_FILL + 1e-6);
    expect(phone.fractionY).toBeLessThanOrEqual(GALAXY_FRAME_FILL + 1e-6);
  });

  it("窄屏是水平方向约束、宽屏是垂直方向约束", () => {
    expect(fitGalaxyCamera({ positions, count: 120, aspect: 0.5 }).boundBy).toBe("horizontal");
    expect(fitGalaxyCamera({ positions, count: 120, aspect: 2.4 }).boundBy).toBe("vertical");
  });

  it("宽屏不会为了高度把星系缩得比目标更小（垂直贴到目标占位）", () => {
    const framing = fitGalaxyCamera({ positions, count: 120, aspect: 2.4 });
    expect(framing.fractionY).toBeGreaterThan(GALAXY_FRAME_FILL * 0.95);
  });
});

describe("fitGalaxyCamera：自转与稳定性", () => {
  const positions = ring(96, 210, 90);

  it("自转任意角度都不裁切（扫描取景 + 更细的自转检查）", () => {
    const framing = fitGalaxyCamera({ positions, count: 96, aspect: 16 / 9 });
    for (let step = 0; step < 48; step += 1) {
      const pose = fitGalaxyCamera({
        positions,
        count: 96,
        aspect: 16 / 9,
        rotationRadians: (step / 48) * Math.PI * 2,
        minDistance: framing.distance,
        maxDistance: framing.distance,
      });
      expect(pose.fractionX).toBeLessThanOrEqual(GALAXY_FRAME_FILL + 1e-3);
      expect(pose.fractionY).toBeLessThanOrEqual(GALAXY_FRAME_FILL + 1e-3);
    }
  });

  it("同输入同输出（确定性）", () => {
    const a = fitGalaxyCamera({ positions, count: 96, aspect: 1.7 });
    const b = fitGalaxyCamera({ positions, count: 96, aspect: 1.7 });
    expect(a).toEqual(b);
  });

  it("中心固定在原点：方向 x=0，距离只看外轮廓", () => {
    const framed = fitGalaxyCamera({ positions, count: 96, aspect: 1.7 });
    expect(framed.direction[0]).toBe(0);
    const closer = fitGalaxyCamera({ positions: ring(96, 110, 45), count: 96, aspect: 1.7 });
    expect(closer.distance).toBeLessThan(framed.distance);
  });
});

describe("fitGalaxyCamera：边界", () => {
  it("空点集：给最小距离、不判方向", () => {
    const framing = fitGalaxyCamera({ positions: new Float32Array(0), count: 0, aspect: 16 / 9 });
    expect(framing.boundBy).toBe("none");
    expect(framing.distance).toBe(GALAXY_CAMERA_MIN_DISTANCE);
    expect(framing.fractionX).toBe(0);
    expect(framing.fractionY).toBe(0);
  });

  it("极小星系不会把相机推进 260 以内（不穿中心节点）", () => {
    const framing = fitGalaxyCamera({ positions: ring(8, 6, 2), count: 8, aspect: 16 / 9 });
    expect(framing.distance).toBe(GALAXY_CAMERA_MIN_DISTANCE);
  });

  it("极窄画布 / 超大星系被 maxDistance 夹住并标记 clamped", () => {
    const framing = fitGalaxyCamera({ positions: ring(64, 900, 0), count: 64, aspect: 1 / 4 });
    expect(framing.distance).toBe(GALAXY_CAMERA_MAX_DISTANCE);
    expect(framing.clamped).toBe(true);
    expect(framing.requestedDistance).toBeGreaterThan(GALAXY_CAMERA_MAX_DISTANCE);
  });

  it("放宽上限后（窄屏取景）能退到 1100 之外，外环不再被裁", () => {
    const positions = ring(120, 210, 40);
    const capped = fitGalaxyCamera({ positions, count: 120, aspect: 314 / 844 });
    expect(capped.distance).toBe(GALAXY_CAMERA_MAX_DISTANCE);
    expect(capped.fractionX).toBeGreaterThan(1);

    const relaxed = fitGalaxyCamera({
      positions,
      count: 120,
      aspect: 314 / 844,
      maxDistance: GALAXY_CAMERA_HARD_MAX_DISTANCE,
    });
    expect(relaxed.distance).toBeGreaterThan(GALAXY_CAMERA_MAX_DISTANCE);
    expect(relaxed.distance).toBeLessThan(GALAXY_CAMERA_HARD_MAX_DISTANCE);
    expect(relaxed.fractionX).toBeLessThanOrEqual(GALAXY_FRAME_FILL + 1e-6);
    expect(relaxed.fractionY).toBeLessThanOrEqual(GALAXY_FRAME_FILL + 1e-6);
  });

  it("非法 aspect / NaN 坐标不会算出 NaN", () => {
    const broken = new Float32Array([Number.NaN, 0, 0, 100, 0, 0, 0, 50, 0]);
    for (const aspect of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const framing = fitGalaxyCamera({ positions: broken, count: 3, aspect });
      expect(Number.isFinite(framing.distance)).toBe(true);
      expect(Number.isFinite(framing.fractionX)).toBe(true);
      expect(Number.isFinite(framing.fractionY)).toBe(true);
    }
  });
});

describe("rescaleForViewport", () => {
  it("用户没缩放过：直接用新的取景距离", () => {
    expect(
      rescaleForViewport({ nextFitDistance: 700, previousFitDistance: 560, currentDistance: 560 }),
    ).toBeCloseTo(700, 5);
  });

  it("用户放大过：换尺寸后保留同一放大倍数", () => {
    expect(
      rescaleForViewport({ nextFitDistance: 600, previousFitDistance: 600, currentDistance: 300 }),
    ).toBeCloseTo(300, 5);
  });

  it("结果仍夹在 260–1100", () => {
    expect(
      rescaleForViewport({ nextFitDistance: 300, previousFitDistance: 600, currentDistance: 260 }),
    ).toBe(GALAXY_CAMERA_MIN_DISTANCE);
    // 1000×(260/600)=433 还在范围内 ⇒ 保留倍数，不贴边。
    expect(
      rescaleForViewport({ nextFitDistance: 1000, previousFitDistance: 600, currentDistance: 260 }),
    ).toBeCloseTo(433.33, 1);
    expect(
      rescaleForViewport({ nextFitDistance: 900, previousFitDistance: 300, currentDistance: 900 }),
    ).toBe(GALAXY_CAMERA_MAX_DISTANCE);
  });

  it("缩放到 0 / 非有限值时退回新取景距离，不产生 0 或 NaN", () => {
    expect(
      rescaleForViewport({ nextFitDistance: 640, previousFitDistance: 0, currentDistance: 0 }),
    ).toBe(640);
    expect(
      rescaleForViewport({
        nextFitDistance: 640,
        previousFitDistance: Number.NaN,
        currentDistance: Number.NaN,
      }),
    ).toBe(640);
  });
});
