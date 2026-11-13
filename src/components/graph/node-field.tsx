"use client";

/**
 * 节点星点层（ADR-022 A8 / 设计稿 §4.4）。
 *
 * 一次 `InstancedMesh` 画完所有节点（draw call = 1），六种形状在片元着色器里用 SDF
 * 区分：圆 / 双环 / 圆角方 / 菱形 / 六边形 / 小圆。**不按类型拆 mesh**。
 *
 * 契约：半径只读 `GalaxyLayoutResult.radius`；这里只乘纯视觉系数（星核 5.4、
 * 选中 ×1.15），不再查 `node.size`。颜色只读 `node.colorToken` → 从 CSS 变量解析出的
 * `palette.nodes`，组件里没有类型名与色值字面量。
 *
 * 同文件还带两个同属「节点装饰」的单 draw call 层：
 * - `HaloLayer`：选中 / 星核 / 枢纽的 additive 光晕，最多 6 个；
 * - `SelectionRing`：选中节点外的一圈屏幕空间细环（不随距离变粗）。
 */

import { useEffect, useMemo, useRef } from "react";
import { useThree } from "@react-three/fiber";
import {
  AdditiveBlending,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  Mesh,
} from "three";

import type { GraphViewModel } from "@/lib/graph-model";
import type { GalaxyLayoutResult } from "@/lib/graph-layout-3d";
import type { GraphHighlight } from "@/lib/graph-selectors";
import {
  HALO_SCALE,
  NODE_DIM_ALPHA,
  rgbaToLinear,
  shapeIndex,
  visualRadius,
  type GraphPalette,
  type LinearRGB,
} from "@/lib/graph-render";

/* ------------------------------------------------------------------ *
 * 节点层
 * ------------------------------------------------------------------ */

export interface NodeFieldProps {
  readonly view: GraphViewModel;
  readonly layout: GalaxyLayoutResult;
  readonly highlight: GraphHighlight;
  readonly palette: GraphPalette;
  readonly anchorId: string | null;
}

interface NodeInstances {
  readonly count: number;
  readonly positions: Float32Array;
  readonly scales: Float32Array;
  readonly colors: Float32Array;
  readonly shapes: Float32Array;
  readonly alphas: Float32Array;
  readonly highlights: Float32Array;
}

function linearTuple(color: LinearRGB): [number, number, number] {
  return [color[0], color[1], color[2]];
}

/** 组装实例属性：遍历 `layout.ids`（布局自己的顺序），按 id 回查模型节点。 */
function buildNodeInstances(
  view: GraphViewModel,
  layout: GalaxyLayoutResult,
  highlight: GraphHighlight,
  palette: GraphPalette,
  anchorId: string | null,
): NodeInstances {
  const count = layout.ids.length;
  const positions = new Float32Array(count * 3);
  const scales = new Float32Array(count);
  const colors = new Float32Array(count * 3);
  const shapes = new Float32Array(count);
  const alphas = new Float32Array(count);
  const highlights = new Float32Array(count);
  let used = 0;

  for (let index = 0; index < count; index += 1) {
    const id = layout.ids[index];
    const nodeIndex = view.nodeIndex.get(id);
    if (nodeIndex === undefined) continue;
    const node = view.nodes[nodeIndex];
    const isSelected = id === anchorId;
    const isCenter = node.flags.isCenter;
    const radius = visualRadius(layout.radius[index], isCenter, isSelected);
    const color = rgbaToLinear(palette.nodes[node.colorToken]);

    positions[used * 3] = layout.positions[index * 3];
    positions[used * 3 + 1] = layout.positions[index * 3 + 1];
    positions[used * 3 + 2] = layout.positions[index * 3 + 2];
    scales[used] = radius;
    colors[used * 3] = color[0];
    colors[used * 3 + 1] = color[1];
    colors[used * 3 + 2] = color[2];
    shapes[used] = shapeIndex(node.shape);
    alphas[used] = highlight.dimmed.has(id) && !isSelected ? NODE_DIM_ALPHA : 1;
    highlights[used] = isCenter || isSelected ? 1 : 0;
    used += 1;
  }

  return {
    count: used,
    positions,
    scales,
    colors: colors.subarray(0, used * 3),
    shapes: shapes.subarray(0, used),
    alphas: alphas.subarray(0, used),
    highlights: highlights.subarray(0, used),
  };
}

const NODE_VERTEX = /* glsl */ `
  attribute vec3 aColor;
  attribute float aShape;
  attribute float aAlpha;
  attribute float aHighlight;

  varying vec3 vColor;
  varying float vShape;
  varying float vAlpha;
  varying float vHighlight;
  varying float vFade;
  varying vec2 vUv;

  void main() {
    vColor = aColor;
    vShape = aShape;
    vAlpha = aAlpha;
    vHighlight = aHighlight;
    vUv = uv;

    float scale = length(instanceMatrix[0].xyz);
    vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float dist = -center.z;
    // 越远越暗（设计稿 §4.4 深度暗示），下限 0.55，别让外环消失。
    vFade = clamp(1.0 - (dist - 260.0) / 1400.0, 0.55, 1.0);

    // 屏幕对齐 billboard：偏移在视空间做，随相机转动但不受星系组倾斜影响。
    center.xy += position.xy * scale;
    gl_Position = projectionMatrix * center;
  }
`;

const NODE_FRAGMENT = /* glsl */ `
  uniform vec3 uDisk;
  uniform vec3 uCore;

  varying vec3 vColor;
  varying float vShape;
  varying float vAlpha;
  varying float vHighlight;
  varying float vFade;
  varying vec2 vUv;

  float sdCircle(vec2 p, float r) { return length(p) - r; }
  float sdRing(vec2 p) { return abs(length(p) - 0.66) - 0.17; }
  float sdRoundBox(vec2 p) {
    vec2 q = abs(p) - vec2(0.62);
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.22;
  }
  float sdDiamond(vec2 p) { return (abs(p.x) + abs(p.y) - 0.95) * 0.70710678; }
  float sdHexagon(vec2 p) {
    const vec3 k = vec3(-0.8660254, 0.5, 0.57735027);
    vec2 q = abs(p);
    q -= 2.0 * min(dot(k.xy, q), 0.0) * k.xy;
    q -= vec2(clamp(q.x, -k.z * 0.9, k.z * 0.9), 0.9);
    return length(q) * sign(q.y);
  }
  float sdDot(vec2 p) { return length(p) - 0.5; }

  float shapeDistance(vec2 p, float shape) {
    if (shape < 0.5) return sdCircle(p, 0.9);
    if (shape < 1.5) return sdRing(p);
    if (shape < 2.5) return sdRoundBox(p);
    if (shape < 3.5) return sdDiamond(p);
    if (shape < 4.5) return sdHexagon(p);
    return sdDot(p);
  }

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float d = shapeDistance(p, vShape);
    float aa = max(fwidth(d), 0.002) * 0.85;
    float inside = 1.0 - smoothstep(-aa, aa, d);
    if (inside <= 0.002) discard;

    // 1px 左右描边（屏幕空间，靠 fwidth 归一）：深色盘 + 类型色描边 + 类型色内核。
    float stroke = 1.0 - smoothstep(0.0, aa * 2.4, abs(d));
    float coreRadius = vShape > 0.5 && vShape < 1.5 ? 0.30 : 0.34;
    float core = 1.0 - smoothstep(coreRadius - aa, coreRadius + aa, length(p));

    vec3 color = mix(vColor, uDisk, 0.55);
    color = mix(color, vColor, stroke * 0.9);
    color = mix(color, mix(vColor, uCore, vHighlight), core);

    gl_FragColor = vec4(color, inside * vAlpha * vFade);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function NodeField({ view, layout, highlight, palette, anchorId }: NodeFieldProps) {
  const meshRef = useRef<InstancedMesh>(null);
  const invalidate = useThree((state) => state.invalidate);

  const instances = useMemo(
    () => buildNodeInstances(view, layout, highlight, palette, anchorId),
    [view, layout, highlight, palette, anchorId],
  );

  const uniforms = useMemo(
    () => ({
      uDisk: { value: linearTuple(rgbaToLinear(palette.nodeDisk)) },
      uCore: { value: linearTuple(rgbaToLinear(palette.core)) },
    }),
    [palette],
  );

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const matrix = new Matrix4();
    for (let index = 0; index < instances.count; index += 1) {
      const scale = instances.scales[index];
      matrix.makeScale(scale, scale, 1);
      matrix.setPosition(
        instances.positions[index * 3],
        instances.positions[index * 3 + 1],
        instances.positions[index * 3 + 2],
      );
      mesh.setMatrixAt(index, matrix);
    }
    mesh.count = instances.count;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.instanceMatrix.needsUpdate = true;
    invalidate();
  }, [instances, invalidate]);

  const capacity = Math.max(1, view.nodes.length);

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, capacity]}
      frustumCulled={false}
      renderOrder={2}
    >
      {/*
        实例属性必须**声明式**地由 `instances` 驱动：早先在 effect 里 setAttribute，
        而 JSX 又挂了零值占位属性，任何一次重渲染都会把占位属性重新 attach 回去，
        vColor / vAlpha 全变成 0（节点整层不可见，draw call 却照旧计数）。
      */}
      <planeGeometry args={[2, 2]}>
        <instancedBufferAttribute attach="attributes-aColor" args={[instances.colors, 3]} />
        <instancedBufferAttribute attach="attributes-aShape" args={[instances.shapes, 1]} />
        <instancedBufferAttribute attach="attributes-aAlpha" args={[instances.alphas, 1]} />
        <instancedBufferAttribute attach="attributes-aHighlight" args={[instances.highlights, 1]} />
      </planeGeometry>
      <shaderMaterial
        vertexShader={NODE_VERTEX}
        fragmentShader={NODE_FRAGMENT}
        uniforms={uniforms}
        transparent
        depthWrite={false}
      />
    </instancedMesh>
  );
}

/* ------------------------------------------------------------------ *
 * 光晕层
 * ------------------------------------------------------------------ */

export interface HaloLayerProps {
  readonly view: GraphViewModel;
  readonly layout: GalaxyLayoutResult;
  readonly palette: GraphPalette;
  readonly anchorId: string | null;
}

interface HaloEntry {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly scale: number;
  readonly color: LinearRGB;
  readonly alpha: number;
}

const HALO_MAX = 6;
const HUB_DEGREE = 8;
const HALO_ALPHA_SELECTED = 0.22;
const HALO_ALPHA_HUB = 0.08;

const HALO_VERTEX = /* glsl */ `
  attribute vec3 aColor;
  attribute float aAlpha;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vUv = uv;
    vColor = aColor;
    vAlpha = aAlpha;
    float scale = length(instanceMatrix[0].xyz);
    vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    center.xy += position.xy * scale;
    gl_Position = projectionMatrix * center;
  }
`;

const HALO_FRAGMENT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float r = length(vUv * 2.0 - 1.0);
    if (r > 1.0) discard;
    float falloff = 1.0 - r;
    float alpha = falloff * falloff * vAlpha;
    gl_FragColor = vec4(vColor, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function buildHaloEntries(
  view: GraphViewModel,
  layout: GalaxyLayoutResult,
  palette: GraphPalette,
  anchorId: string | null,
): HaloEntry[] {
  const entries: HaloEntry[] = [];
  const seen = new Set<string>();

  const add = (id: string, color: RGBA_OR_LINEAR, alpha: number): void => {
    if (seen.has(id) || entries.length >= HALO_MAX) return;
    const layoutIndex = layout.indexById.get(id);
    const nodeIndex = view.nodeIndex.get(id);
    if (layoutIndex === undefined || nodeIndex === undefined) return;
    const node = view.nodes[nodeIndex];
    const isSelected = id === anchorId;
    const radius = visualRadius(layout.radius[layoutIndex], node.flags.isCenter, isSelected);
    seen.add(id);
    entries.push({
      x: layout.positions[layoutIndex * 3],
      y: layout.positions[layoutIndex * 3 + 1],
      z: layout.positions[layoutIndex * 3 + 2],
      scale: radius * HALO_SCALE,
      color,
      alpha,
    });
  };

  if (anchorId) add(anchorId, rgbaToLinear(palette.accent), HALO_ALPHA_SELECTED);
  const center = view.nodes.find((node) => node.flags.isCenter);
  if (center) add(center.id, rgbaToLinear(palette.core), HALO_ALPHA_SELECTED);
  const hubs = view.nodes
    .filter((node) => node.degree >= HUB_DEGREE && !node.flags.isCenter)
    .slice()
    .sort((a, b) => b.degree - a.degree || (a.id < b.id ? -1 : 1));
  for (const hub of hubs) add(hub.id, rgbaToLinear(palette.nodes[hub.colorToken]), HALO_ALPHA_HUB);

  return entries;
}

type RGBA_OR_LINEAR = LinearRGB;

export function HaloLayer({ view, layout, palette, anchorId }: HaloLayerProps) {
  const meshRef = useRef<InstancedMesh>(null);
  const invalidate = useThree((state) => state.invalidate);
  const entries = useMemo(
    () => buildHaloEntries(view, layout, palette, anchorId),
    [view, layout, palette, anchorId],
  );
  const uniforms = useMemo(() => ({}), []);

  // 颜色/透明度同样声明式：以前在 effect 里 setAttribute，JSX 的零值占位属性会在
  // 下一次重渲染时覆盖回去，光晕会静默变黑。
  const attributes = useMemo(() => {
    const colors = new Float32Array(HALO_MAX * 3);
    const alphas = new Float32Array(HALO_MAX);
    entries.forEach((entry, index) => {
      colors[index * 3] = entry.color[0];
      colors[index * 3 + 1] = entry.color[1];
      colors[index * 3 + 2] = entry.color[2];
      alphas[index] = entry.alpha;
    });
    return { colors, alphas };
  }, [entries]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const matrix = new Matrix4();
    entries.forEach((entry, index) => {
      matrix.makeScale(entry.scale, entry.scale, 1);
      matrix.setPosition(entry.x, entry.y, entry.z);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.count = entries.length;
    mesh.visible = entries.length > 0;
    mesh.instanceMatrix.needsUpdate = true;
    invalidate();
  }, [entries, invalidate]);

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, HALO_MAX]} frustumCulled={false} renderOrder={0}>
      <planeGeometry args={[2, 2]}>
        <instancedBufferAttribute attach="attributes-aColor" args={[attributes.colors, 3]} />
        <instancedBufferAttribute attach="attributes-aAlpha" args={[attributes.alphas, 1]} />
      </planeGeometry>
      <shaderMaterial
        vertexShader={HALO_VERTEX}
        fragmentShader={HALO_FRAGMENT}
        uniforms={uniforms}
        transparent
        depthWrite={false}
        blending={AdditiveBlending}
      />
    </instancedMesh>
  );
}

/* ------------------------------------------------------------------ *
 * 选中环
 * ------------------------------------------------------------------ */

export interface SelectionRingProps {
  readonly view: GraphViewModel;
  readonly layout: GalaxyLayoutResult;
  readonly palette: GraphPalette;
  readonly anchorId: string | null;
}

const RING_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    // 普通 Mesh（不是 InstancedMesh）：modelMatrix 的缩放列长度就是世界缩放。
    float scale = length(modelMatrix[0].xyz);
    vec4 center = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    center.xy += position.xy * scale;
    gl_Position = projectionMatrix * center;
  }
`;

const RING_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float d = length(p) - 0.84;
    float aa = max(fwidth(d), 0.002);
    float ring = 1.0 - smoothstep(aa * 0.6, aa * 2.2, abs(d));
    if (ring <= 0.01) discard;
    gl_FragColor = vec4(uColor, ring);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function SelectionRing({ view, layout, palette, anchorId }: SelectionRingProps) {
  const meshRef = useRef<Mesh>(null);
  const invalidate = useThree((state) => state.invalidate);
  const uniforms = useMemo(
    () => ({ uColor: { value: linearTuple(rgbaToLinear(palette.accent)) } }),
    [palette],
  );

  const target = useMemo(() => {
    if (!anchorId) return null;
    const layoutIndex = layout.indexById.get(anchorId);
    const nodeIndex = view.nodeIndex.get(anchorId);
    if (layoutIndex === undefined || nodeIndex === undefined) return null;
    const node = view.nodes[nodeIndex];
    const radius = visualRadius(layout.radius[layoutIndex], node.flags.isCenter, true);
    return {
      x: layout.positions[layoutIndex * 3],
      y: layout.positions[layoutIndex * 3 + 1],
      z: layout.positions[layoutIndex * 3 + 2],
      scale: radius * 1.7,
    };
  }, [view, layout, anchorId]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.visible = target !== null;
    if (target) {
      mesh.position.set(target.x, target.y, target.z);
      mesh.scale.setScalar(target.scale);
    }
    invalidate();
  }, [target, invalidate]);

  return (
    <mesh ref={meshRef} frustumCulled={false} renderOrder={3} visible={false}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        vertexShader={RING_VERTEX}
        fragmentShader={RING_FRAGMENT}
        uniforms={uniforms}
        transparent
        depthWrite={false}
        depthTest={false}
      />
    </mesh>
  );
}

