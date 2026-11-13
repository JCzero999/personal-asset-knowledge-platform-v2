import * as THREE from "three";

import { GALAXY_CONFIG, GALAXY_PALETTE } from "./galaxy-config";
import {
  buildCoreBulge,
  buildDiskHaze,
  buildDustLanes,
  buildSpiralArms,
  buildStarField,
  computeParallaxTarget,
  dampValue,
  galaxyRotation,
  resolveGalaxyComposition,
  type GalaxyGeometry,
  type GalaxyQuality,
} from "./galaxy";

/**
 * Three.js 星系场景（ADR-020）。
 *
 * 只在客户端、且 `resolveGalaxyMode` 判定为 webgl 时由 `galaxy-scene.tsx`
 * 动态 import。所有可调参数来自 `GALAXY_CONFIG`；这里只负责把几何装进
 * 场景、每帧更新 uniform。纯数学都在 `galaxy.ts`，便于单测。
 */

const TAU = Math.PI * 2;

export interface GalaxyRenderer {
  /** 四类粒子合计，写进运行时统计。 */
  readonly particleCount: number;
  /** 推进一帧的运动并绘制。poster 模式传 still=true 只定格渲染。 */
  render(elapsedMs: number, deltaMs: number, still?: boolean): void;
  setViewport(width: number, height: number, dpr: number): void;
  setPointer(normalizedX: number, normalizedY: number): void;
  dispose(): void;
}

const POINT_VERTEX = `
  attribute float aSize;
  attribute float aSeed;
  attribute vec3 aColor;

  uniform float uPixelRatio;
  uniform float uPointScale;
  uniform float uTime;
  uniform float uTwinkle;
  uniform float uSizeReference;

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    float twinkle = 1.0 + uTwinkle * 0.35 * sin(uTime * ${GALAXY_CONFIG.twinkle.speed.toFixed(2)} + aSeed * 6.2831853);
    float size = aSize * uPointScale * uPixelRatio * (uSizeReference / max(0.001, -mvPosition.z)) * twinkle;
    gl_PointSize = clamp(size, 0.6, 64.0);

    vColor = aColor;
    vAlpha = 0.82 + 0.18 * fract(aSeed * 7.31);
  }
`;

const POINT_FRAGMENT = `
  uniform float uOpacity;
  uniform float uBrightness;
  uniform float uSoftness;

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    float dist = length(gl_PointCoord - vec2(0.5));
    if (dist > 0.5) discard;

    float falloff = smoothstep(0.5, 0.0, dist);
    float alpha = pow(falloff, uSoftness);
    gl_FragColor = vec4(vColor * uBrightness, alpha * vAlpha * uOpacity);
  }
`;

/** 径向光晕贴图：中心暖白，向外过渡到透明。用于核球辉光与盘面雾光。 */
function createGlowTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");

  if (context) {
    const half = size / 2;
    const gradient = context.createRadialGradient(half, half, 0, half, half, half);
    gradient.addColorStop(0, "rgba(255, 247, 230, 0.95)");
    gradient.addColorStop(0.08, "rgba(255, 238, 205, 0.72)");
    gradient.addColorStop(0.2, "rgba(255, 227, 184, 0.36)");
    gradient.addColorStop(0.4, "rgba(233, 192, 138, 0.14)");
    gradient.addColorStop(0.68, "rgba(160, 128, 106, 0.05)");
    gradient.addColorStop(1, "rgba(5, 4, 8, 0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.LinearSRGBColorSpace;

  return texture;
}

function toBufferGeometry(geometry: GalaxyGeometry): THREE.BufferGeometry {
  const buffer = new THREE.BufferGeometry();
  buffer.setAttribute("position", new THREE.BufferAttribute(geometry.positions, 3));
  buffer.setAttribute("aColor", new THREE.BufferAttribute(geometry.colors, 3));
  buffer.setAttribute("aSize", new THREE.BufferAttribute(geometry.sizes, 1));
  buffer.setAttribute("aSeed", new THREE.BufferAttribute(geometry.seeds, 1));

  return buffer;
}

interface PointsLayer {
  points: THREE.Points;
  material: THREE.ShaderMaterial;
}

function createPointsLayer(
  geometry: GalaxyGeometry,
  options: {
    twinkle: number;
    opacity: number;
    softness: number;
    blending: THREE.Blending;
  },
  pixelRatio: number,
  pointScale: number,
): PointsLayer {
  const material = new THREE.ShaderMaterial({
    vertexShader: POINT_VERTEX,
    fragmentShader: POINT_FRAGMENT,
    uniforms: {
      uPixelRatio: { value: pixelRatio },
      uPointScale: { value: pointScale },
      uSizeReference: { value: 14 },
      uTime: { value: 0 },
      uTwinkle: { value: options.twinkle },
      uOpacity: { value: options.opacity },
      uBrightness: { value: GALAXY_CONFIG.brightness },
      uSoftness: { value: options.softness },
    },
    blending: options.blending,
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });

  const points = new THREE.Points(toBufferGeometry(geometry), material);
  points.frustumCulled = false;

  return { points, material };
}

/**
 * 在给定 canvas 上建立场景。WebGL 不可用时返回 null（调用方走 fallback），
 * 其余失败照常抛出，由组件兜底成静态图。
 */
export function createGalaxyRenderer(options: {
  canvas: HTMLCanvasElement;
  quality: GalaxyQuality;
  width: number;
  height: number;
  dpr: number;
}): GalaxyRenderer | null {
  const { canvas, quality, width, height, dpr } = options;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: false,
    antialias: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(dpr);
  renderer.setSize(width, height, false);
  // 配色按取样值直接写进缓冲，避免 sRGB→线性再转回来造成的二次偏移。
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setClearColor(new THREE.Color(GALAXY_PALETTE.voidDeep), 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    GALAXY_CONFIG.camera.fovDeg,
    Math.max(0.2, width / Math.max(1, height)),
    GALAXY_CONFIG.camera.near,
    GALAXY_CONFIG.camera.far,
  );
  camera.position.set(0, 0, GALAXY_CONFIG.camera.distance);

  const composition = resolveGalaxyComposition({
    aspect: width / Math.max(1, height),
    mobile: quality.mobile,
  });

  // 层级：pivot（视差/呼吸）→ root（屏幕倾角 + 构图偏移）→ facing（观察面翻转）
  // → tilt（盘面倾角）→ spin（自转）。
  // facing 放在 tilt 之上，翻面时旋臂、核球、薄雾、尘带与盘面倾角一起镜像。
  const pivot = new THREE.Group();
  const root = new THREE.Group();
  const facing = new THREE.Group();
  const tilt = new THREE.Group();
  const spin = new THREE.Group();

  root.position.set(composition.offsetX, composition.offsetY, 0);
  root.rotation.z = composition.rollRad;
  root.scale.setScalar(composition.scale);
  facing.rotation.y = composition.facingRad;
  tilt.rotation.x = composition.tiltRad;

  pivot.add(root);
  root.add(facing);
  facing.add(tilt);
  tilt.add(spin);
  scene.add(pivot);

  const arms = buildSpiralArms(quality.arms);
  const core = buildCoreBulge(quality.core);
  const haze = buildDiskHaze(quality.haze);
  const dust = buildDustLanes(quality.dust);
  const stars = buildStarField(quality.stars);

  const hazeLayer = createPointsLayer(
    haze,
    { twinkle: 0, opacity: 0.9, softness: 1.1, blending: THREE.AdditiveBlending },
    dpr,
    quality.pointScale,
  );
  const armsLayer = createPointsLayer(
    arms,
    { twinkle: GALAXY_CONFIG.twinkle.arms, opacity: 1, softness: 1.7, blending: THREE.AdditiveBlending },
    dpr,
    quality.pointScale,
  );
  const coreLayer = createPointsLayer(
    core,
    { twinkle: GALAXY_CONFIG.twinkle.arms * 0.6, opacity: 1, softness: 2.4, blending: THREE.AdditiveBlending },
    dpr,
    quality.pointScale,
  );
  const starLayer = createPointsLayer(
    stars,
    { twinkle: GALAXY_CONFIG.twinkle.stars, opacity: 1, softness: 1.3, blending: THREE.AdditiveBlending },
    dpr,
    quality.pointScale,
  );
  const dustLayer = createPointsLayer(
    dust,
    {
      twinkle: 0,
      opacity: GALAXY_CONFIG.dust.opacity,
      softness: 1.2,
      blending: THREE.NormalBlending,
    },
    dpr,
    quality.pointScale,
  );

  starLayer.points.renderOrder = 0;
  hazeLayer.points.renderOrder = 1;
  coreLayer.points.renderOrder = 2;
  armsLayer.points.renderOrder = 3;
  dustLayer.points.renderOrder = 4;

  spin.add(hazeLayer.points, coreLayer.points, armsLayer.points);
  pivot.add(starLayer.points);
  spin.add(dustLayer.points);

  // 核球辉光：贴在星系中心的球状光晕（billboard），给出体积光的第一层。
  const glowTexture = createGlowTexture();
  const halo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture,
      color: new THREE.Color("#FFF2DE"),
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 1,
    }),
  );
  halo.scale.setScalar(composition.scale * 1.8);
  halo.position.set(composition.offsetX, composition.offsetY, 0);
  halo.renderOrder = 5;
  scene.add(halo);

  const outerHalo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture,
      color: new THREE.Color("#E9C08A"),
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.22,
    }),
  );
  outerHalo.scale.setScalar(composition.scale * 4.2);
  outerHalo.position.set(composition.offsetX, composition.offsetY, 0);
  outerHalo.renderOrder = 5;
  scene.add(outerHalo);

  // 盘面雾光：躺在盘内的一层椭圆柔光，让旋臂之间的暗区透出微光。
  const diskGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(3.2, 3.2),
    new THREE.MeshBasicMaterial({
      map: glowTexture,
      color: new THREE.Color("#B99364"),
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.2,
    }),
  );
  diskGlow.renderOrder = 0;
  spin.add(diskGlow);

  const pointer = { targetX: 0, targetY: 0, currentX: 0, currentY: 0 };
  const maxParallax = (GALAXY_CONFIG.parallax.maxDeg * Math.PI) / 180;

  function applyComposition(nextWidth: number, nextHeight: number) {
    const aspect = nextWidth / Math.max(1, nextHeight);
    const next = resolveGalaxyComposition({ aspect, mobile: quality.mobile });

    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    root.position.set(next.offsetX, next.offsetY, 0);
    root.rotation.z = next.rollRad;
    root.scale.setScalar(next.scale);
    facing.rotation.y = next.facingRad;
    tilt.rotation.x = next.tiltRad;

    halo.scale.setScalar(next.scale * 1.8);
    halo.position.set(next.offsetX, next.offsetY, 0);
    outerHalo.scale.setScalar(next.scale * 4.2);
    outerHalo.position.set(next.offsetX, next.offsetY, 0);
  }

  function setUniform(name: string, value: number) {
    armsLayer.material.uniforms[name].value = value;
    coreLayer.material.uniforms[name].value = value;
    hazeLayer.material.uniforms[name].value = value;
    starLayer.material.uniforms[name].value = value;
    dustLayer.material.uniforms[name].value = value;
  }

  function render(elapsedMs: number, deltaMs: number, still = false) {
    const animate = quality.animate && !still;
    const seconds = elapsedMs / 1000;

    if (animate) {
      const target = computeParallaxTarget(pointer.targetX, pointer.targetY, maxParallax);
      pointer.currentX = dampValue(pointer.currentX, target.x, deltaMs, GALAXY_CONFIG.parallax.halfLifeMs);
      pointer.currentY = dampValue(pointer.currentY, target.y, deltaMs, GALAXY_CONFIG.parallax.halfLifeMs);

      const breath = GALAXY_CONFIG.breathing.enabled
        ? Math.sin((seconds % GALAXY_CONFIG.breathing.periodSeconds) / GALAXY_CONFIG.breathing.periodSeconds * TAU)
        : 0;

      pivot.rotation.x = pointer.currentX + breath * (GALAXY_CONFIG.breathing.amplitudeDeg * Math.PI) / 180;
      pivot.rotation.y = pointer.currentY;
    }

    // 翻面后自转取反，屏幕上保持原来的转向。
    spin.rotation.z = (still
      ? GALAXY_CONFIG.rotation.posterAngleRad
      : galaxyRotation(elapsedMs)) * composition.spinSign;

    setUniform("uTime", still ? 0 : seconds);
    renderer.render(scene, camera);
  }

  return {
    particleCount: quality.particleCount,
    render,
    setViewport(nextWidth: number, nextHeight: number, nextDpr: number) {
      renderer.setPixelRatio(nextDpr);
      renderer.setSize(nextWidth, nextHeight, false);
      setUniform("uPixelRatio", nextDpr);
      applyComposition(nextWidth, nextHeight);
    },
    setPointer(normalizedX: number, normalizedY: number) {
      if (!GALAXY_CONFIG.parallax.enabled) return;
      pointer.targetX = normalizedX;
      pointer.targetY = normalizedY;
    },
    dispose() {
      armsLayer.points.geometry.dispose();
      armsLayer.material.dispose();
      coreLayer.points.geometry.dispose();
      coreLayer.material.dispose();
      hazeLayer.points.geometry.dispose();
      hazeLayer.material.dispose();
      starLayer.points.geometry.dispose();
      starLayer.material.dispose();
      dustLayer.points.geometry.dispose();
      dustLayer.material.dispose();
      diskGlow.geometry.dispose();
      (diskGlow.material as THREE.MeshBasicMaterial).dispose();
      halo.material.dispose();
      outerHalo.material.dispose();
      glowTexture.dispose();
      renderer.dispose();
    },
  };
}
