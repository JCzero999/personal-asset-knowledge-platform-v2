"use client";

/**
 * 标签层（ADR-022 A8 / 设计稿 §4.4、§8.2）。
 *
 * 一个 canvas 纹理图集 + 一个 InstancedBufferGeometry 画完所有标签（draw call = 1）。
 * 预算由档位决定（low 12 / balanced 24 / high 40），候选顺序在 `labelCandidates` 里
 * 排好；本组件每帧把候选投影到屏幕，跑一次矩形避让，再写实例属性。
 *
 * - 选中 / 悬停 / 路径标签 `forced`：永远保留，必要时夹回视口；
 * - 其余标签与已接受的框相交就丢弃（简单屏幕空间避让）；
 * - 文字用 `node.shortLabel`，字号在屏幕空间固定，不随相机距离缩小。
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  BufferAttribute,
  CanvasTexture,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  ShaderMaterial,
  Vector3,
  type PerspectiveCamera,
} from "three";

import type { GraphViewModel } from "@/lib/graph-model";
import type { GalaxyLayoutResult } from "@/lib/graph-layout-3d";
import type { GraphHighlight } from "@/lib/graph-selectors";
import type { QualityTier } from "@/lib/graph-quality";
import {
  labelCandidates,
  layoutLabels,
  packLabelAtlas,
  rgbaToLinear,
  visualRadius,
  type GraphPalette,
  type ProjectedLabel,
} from "@/lib/graph-render";

const ATLAS_WIDTH = 2048;
const ATLAS_HEIGHT = 1024;
const ATLAS_FONT_PX = 36;
const CELL_PADDING_X = 18;
const CELL_HEIGHT = 52;
/** 屏幕上的标签框高度（CSS 像素）；图集里 36px 字缩到这里约 12–13px。 */
const LABEL_SCREEN_HEIGHT = 17;
const LABEL_GAP_PX = 7;

export interface LabelLayerProps {
  readonly view: GraphViewModel;
  readonly layout: GalaxyLayoutResult;
  readonly highlight: GraphHighlight;
  readonly palette: GraphPalette;
  readonly tier: QualityTier;
  readonly anchorId: string | null;
  readonly fontFamily: string;
  /** 场景根读取当前可见标签数用的可变引用。 */
  readonly labelCountRef: { current: number };
}

interface AtlasEntry {
  readonly id: string;
  readonly u0: number;
  readonly v0: number;
  readonly v1: number;
  readonly uWidth: number;
  readonly vHeight: number;
  readonly aspect: number;
}

interface LabelSystem {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  readonly geometry: InstancedBufferGeometry;
  readonly material: ShaderMaterial;
  readonly texture: CanvasTexture;
  readonly entries: ReadonlyMap<string, AtlasEntry>;
  readonly ids: readonly string[];
  dispose(): void;
}

const LABEL_VERTEX = /* glsl */ `
  attribute vec3 aAnchor;
  attribute vec2 aSize;
  attribute vec2 aOffset;
  attribute vec4 aUv;
  attribute float aAlpha;

  uniform float uPixelScale;

  varying vec2 vUv;
  varying float vAlpha;

  void main() {
    vec4 center = modelViewMatrix * vec4(aAnchor, 1.0);
    // uPixelScale = 2·tan(fov/2) / viewportHeight：把 CSS 像素换成该深度上的世界单位。
    float worldPerPixel = -center.z * uPixelScale;
    // aOffset 是避让算出来的屏幕像素位移（相对星点中心）、Y 轴向下；视图空间 Y 轴向上，所以取反。
    center.xy += (position.xy * aSize + vec2(aOffset.x, -aOffset.y)) * worldPerPixel;
    gl_Position = projectionMatrix * center;
    vUv = aUv.xy + uv * aUv.zw;
    vAlpha = aAlpha;
  }
`;

const LABEL_FRAGMENT = /* glsl */ `
  uniform sampler2D uAtlas;
  uniform vec3 uColor;

  varying vec2 vUv;
  varying float vAlpha;

  void main() {
    float alpha = texture2D(uAtlas, vUv).a * vAlpha;
    if (alpha < 0.02) discard;
    gl_FragColor = vec4(uColor, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function buildQuadGeometry(): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry();
  const positions = new Float32Array([
    -0.5, -0.5, 0,
    0.5, -0.5, 0,
    0.5, 0.5, 0,
    -0.5, 0.5, 0,
  ]);
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  // 逐顶点属性必须是普通 BufferAttribute：InstancedBufferAttribute 的 divisor=1，
  // 用它会让第 5 个实例读到不存在的顶点。
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new BufferAttribute(uvs, 2));
  geometry.setIndex(new BufferAttribute(indices, 1));
  return geometry;
}

function pickFontFamily(host: HTMLElement | null): string {
  if (typeof document === "undefined") return "sans-serif";
  const element = host ?? document.body;
  const value = getComputedStyle(element).fontFamily.trim();
  return value || "sans-serif";
}

/**
 * 量文字 → 打包 → 画进 2048×1024 图集。放不下时缩小字号重试一次，仍放不下就只画前一半，
 * 保证「有标签」而不是整层消失。
 */
function createLabelSystem(
  view: GraphViewModel,
  candidates: readonly string[],
  palette: GraphPalette,
  fontFamily: string,
): LabelSystem | null {
  if (candidates.length === 0 || typeof document === "undefined") return null;

  const measureCanvas = document.createElement("canvas");
  const measure = measureCanvas.getContext("2d");
  if (!measure) return null;

  const labels: Array<{ id: string; text: string; width: number }> = [];
  const tryLayout = (fontPx: number, ids: readonly string[]): ReturnType<typeof packLabelAtlas> => {
    measure.font = `500 ${fontPx}px ${fontFamily}`;
    labels.length = 0;
    for (const id of ids) {
      const nodeIndex = view.nodeIndex.get(id);
      if (nodeIndex === undefined) continue;
      const text = view.nodes[nodeIndex].shortLabel;
      if (!text) continue;
      const width = Math.ceil(measure.measureText(text).width) + CELL_PADDING_X * 2;
      labels.push({ id, text, width });
    }
    return packLabelAtlas(
      labels.map((label) => ({ id: label.id, width: label.width, height: CELL_HEIGHT })),
      { width: ATLAS_WIDTH, height: ATLAS_HEIGHT, padding: 2 },
    );
  };

  let rects = tryLayout(ATLAS_FONT_PX, candidates);
  let fontPx = ATLAS_FONT_PX;
  if (!rects) {
    fontPx = 28;
    rects = tryLayout(fontPx, candidates);
  }
  if (!rects) {
    rects = tryLayout(28, candidates.slice(0, Math.max(1, Math.ceil(candidates.length / 2))));
  }
  if (!rects) return null;

  const canvas = document.createElement("canvas");
  canvas.width = ATLAS_WIDTH;
  canvas.height = ATLAS_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) return null;

  context.clearRect(0, 0, ATLAS_WIDTH, ATLAS_HEIGHT);
  context.font = `500 ${fontPx}px ${fontFamily}`;
  context.textBaseline = "middle";
  context.textAlign = "left";
  context.fillStyle = "#ffffff";

  const entryMap = new Map<string, AtlasEntry>();
  const orderedIds: string[] = [];
  for (const rect of rects) {
    const label = labels.find((candidate) => candidate.id === rect.id);
    if (!label) continue;
    context.fillText(label.text, rect.x + CELL_PADDING_X, rect.y + rect.height / 2);
    const u0 = rect.x / ATLAS_WIDTH;
    const v1 = 1 - rect.y / ATLAS_HEIGHT;
    const v0 = 1 - (rect.y + rect.height) / ATLAS_HEIGHT;
    entryMap.set(rect.id, {
      id: rect.id,
      u0,
      v0,
      v1,
      uWidth: rect.width / ATLAS_WIDTH,
      vHeight: v1 - v0,
      aspect: rect.width / rect.height,
    });
    orderedIds.push(rect.id);
  }
  if (orderedIds.length === 0) return null;

  const texture = new CanvasTexture(canvas);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;

  const geometry = buildQuadGeometry();
  const capacity = orderedIds.length;
  geometry.setAttribute("aAnchor", new InstancedBufferAttribute(new Float32Array(capacity * 3), 3));
  geometry.setAttribute("aSize", new InstancedBufferAttribute(new Float32Array(capacity * 2), 2));
  // aOffset：避让后的屏幕位移（CSS 像素）。渲染位置必须等于 layoutLabels 算出的框，
  // 否则避让算的是「星点上方的框」，画出来却是「以星点为中心」，两者错位仍会重叠。
  geometry.setAttribute("aOffset", new InstancedBufferAttribute(new Float32Array(capacity * 2), 2));
  geometry.setAttribute("aUv", new InstancedBufferAttribute(new Float32Array(capacity * 4), 4));
  geometry.setAttribute("aAlpha", new InstancedBufferAttribute(new Float32Array(capacity), 1));
  geometry.instanceCount = 0;

  const material = new ShaderMaterial({
    vertexShader: LABEL_VERTEX,
    fragmentShader: LABEL_FRAGMENT,
    uniforms: {
      uAtlas: { value: texture },
      uColor: { value: rgbaToLinear(palette.core) as unknown as number[] },
      uPixelScale: { value: 0.001 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });

  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;

  return {
    mesh,
    geometry,
    material,
    texture,
    entries: entryMap,
    ids: orderedIds,
    dispose() {
      geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}

export function LabelLayer({
  view,
  layout,
  highlight,
  palette,
  tier,
  anchorId,
  fontFamily,
  labelCountRef,
}: LabelLayerProps) {
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const invalidate = useThree((state) => state.invalidate);

  const candidates = useMemo(
    () => labelCandidates(view, highlight, tier, anchorId),
    [view, highlight, tier, anchorId],
  );
  const candidateKey = candidates.join("\u0001");

  const system = useMemo(
    () => createLabelSystem(view, candidates, palette, fontFamily),
    // candidateKey 代表候选集合；view/palette/fontFamily 变化时标签文字或颜色也可能变。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [candidateKey, view, palette, fontFamily],
  );

  useEffect(() => {
    return () => {
      system?.dispose();
    };
  }, [system]);

  // useFrame 里只读 ref：图集对象在 render 之外被每帧改写属性，闭包直接抓 useMemo 的值
  // 会触碰 react-hooks 的「渲染后不可修改」规则，也让旧图集的清理时机变得含糊。
  const systemRef = useRef<LabelSystem | null>(null);
  useEffect(() => {
    systemRef.current = system;
    return () => {
      if (systemRef.current === system) systemRef.current = null;
    };
  }, [system]);

  // 相机/尺寸变化后需要重排一次；空闲时不烧帧。
  useEffect(() => {
    labelCountRef.current = 0;
    invalidate();
  }, [system, invalidate, labelCountRef]);

  const scratchWorld = useRef(new Vector3());
  const scratchProjected = useRef(new Vector3());

  useFrame(() => {
    const active = systemRef.current;
    if (!active) {
      labelCountRef.current = 0;
      return;
    }
    const mesh = active.mesh;

    const perspective = camera as PerspectiveCamera;
    const fovRadians = (perspective.fov * Math.PI) / 180;
    active.material.uniforms.uPixelScale.value =
      (2 * Math.tan(fovRadians / 2)) / Math.max(1, size.height);

    const pathIds = highlight.path ?? [];
    const forced = new Set<string>(pathIds);
    if (anchorId) forced.add(anchorId);

    const projected: ProjectedLabel[] = [];
    const centers = new Map<string, { x: number; y: number }>();
    for (const id of active.ids) {
      const entry = active.entries.get(id);
      const layoutIndex = layout.indexById.get(id);
      if (!entry || layoutIndex === undefined) continue;

      scratchWorld.current.set(
        layout.positions[layoutIndex * 3],
        layout.positions[layoutIndex * 3 + 1],
        layout.positions[layoutIndex * 3 + 2],
      );
      // 星体在旋转组里；投影前先应用组的 world 矩阵。
      const parent = mesh.parent;
      if (parent) {
        parent.updateWorldMatrix(true, false);
        scratchWorld.current.applyMatrix4(parent.matrixWorld);
      }
      const distance = camera.position.distanceTo(scratchWorld.current);
      scratchProjected.current.copy(scratchWorld.current).project(camera);
      if (scratchProjected.current.z < -1 || scratchProjected.current.z > 1) continue;

      const screenX = (scratchProjected.current.x * 0.5 + 0.5) * size.width;
      const screenY = (-scratchProjected.current.y * 0.5 + 0.5) * size.height;
      const height = LABEL_SCREEN_HEIGHT;
      const width = height * entry.aspect;
      const nodeIndex = view.nodeIndex.get(id);
      const isCenter = nodeIndex !== undefined && view.nodes[nodeIndex].flags.isCenter;
      const radiusWorld = visualRadius(layout.radius[layoutIndex], isCenter, id === anchorId);
      const radiusPx =
        (radiusWorld / Math.max(1, distance * Math.tan(fovRadians / 2))) * (size.height / 2);

      projected.push({
        id,
        x: screenX - width / 2,
        y: screenY - radiusPx - LABEL_GAP_PX - height,
        width,
        height,
        forced: forced.has(id),
      });
      centers.set(id, { x: screenX, y: screenY });
    }

    const placed = layoutLabels(projected, { width: size.width, height: size.height }, {
      maxCount: active.ids.length,
    });

    const anchorAttr = active.geometry.getAttribute("aAnchor") as InstancedBufferAttribute;
    const sizeAttr = active.geometry.getAttribute("aSize") as InstancedBufferAttribute;
    const offsetAttr = active.geometry.getAttribute("aOffset") as InstancedBufferAttribute;
    const uvAttr = active.geometry.getAttribute("aUv") as InstancedBufferAttribute;
    const alphaAttr = active.geometry.getAttribute("aAlpha") as InstancedBufferAttribute;

    const anchorArray = anchorAttr.array as Float32Array;
    const sizeArray = sizeAttr.array as Float32Array;
    const offsetArray = offsetAttr.array as Float32Array;
    const uvArray = uvAttr.array as Float32Array;
    const alphaArray = alphaAttr.array as Float32Array;

    placed.forEach((label, index) => {
      const entry = active.entries.get(label.id);
      const layoutIndex = layout.indexById.get(label.id);
      if (!entry || layoutIndex === undefined) return;
      anchorArray[index * 3] = layout.positions[layoutIndex * 3];
      anchorArray[index * 3 + 1] = layout.positions[layoutIndex * 3 + 1];
      anchorArray[index * 3 + 2] = layout.positions[layoutIndex * 3 + 2];
      sizeArray[index * 2] = label.width;
      sizeArray[index * 2 + 1] = label.height;
      // 屏幕位移 = 避让后的框中心 − 星点屏幕位置；这样画出来的矩形和 layoutLabels 的框一致。
      const center = centers.get(label.id);
      offsetArray[index * 2] = center ? label.x + label.width / 2 - center.x : 0;
      offsetArray[index * 2 + 1] = center ? label.y + label.height / 2 - center.y : 0;
      uvArray[index * 4] = entry.u0;
      uvArray[index * 4 + 1] = entry.v0;
      uvArray[index * 4 + 2] = entry.uWidth;
      uvArray[index * 4 + 3] = entry.vHeight;
      alphaArray[index] =
        highlight.dimmed.has(label.id) && !label.forced ? 0.45 : 1;
    });

    active.geometry.instanceCount = placed.length;
    anchorAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;
    offsetAttr.needsUpdate = true;
    uvAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
    labelCountRef.current = placed.length;
    if (process.env.NODE_ENV !== "production") {
      // 验收用：屏幕上真实绘制的标签框（与 layoutLabels 的输出一致），只在开发态暴露。
      (window as Window & { __graphLabelBoxes?: unknown }).__graphLabelBoxes = placed.map((item) => ({
        id: item.id,
        x: Math.round(item.x * 10) / 10,
        y: Math.round(item.y * 10) / 10,
        w: Math.round(item.width * 10) / 10,
        h: Math.round(item.height * 10) / 10,
      }));
    }
  });

  if (!system) return null;
  return <primitive object={system.mesh} />;
}

export { pickFontFamily };
