"use client";

/**
 * 边层（ADR-022 A8 / 设计稿 §4.5）。
 *
 * 三组 `LineSegments2` + `LineMaterial`（three/examples/jsm/lines，不是新依赖）：
 * 默认 / 结构（strong）/ 选中与路径。每组一次 draw call，合计 3。
 *
 * 颜色只读 `GraphViewModel` 的 `colorToken` / `strong` 与从 CSS 变量解析出的
 * `palette`；不画箭头、不加流动光点。`highlight.dimmedEdges` 压暗但保留可见：
 * LineMaterial 只有整组 opacity，逐段压暗改成把顶点色乘一个系数。
 */

import { useEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import { Vector2 } from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";

import type { GraphViewModel } from "@/lib/graph-model";
import type { GalaxyLayoutResult } from "@/lib/graph-layout-3d";
import type { GraphHighlight } from "@/lib/graph-selectors";
import {
  EDGE_DIM_FACTOR,
  dimLinear,
  rgbaToLinear,
  splitEdges,
  type GraphPalette,
} from "@/lib/graph-render";

export interface EdgeFieldProps {
  readonly view: GraphViewModel;
  readonly layout: GalaxyLayoutResult;
  readonly highlight: GraphHighlight;
  readonly palette: GraphPalette;
}

type EdgeKind = "base" | "strong" | "accent";

interface EdgeGroupProps extends EdgeFieldProps {
  readonly indexes: readonly number[];
  readonly kind: EdgeKind;
  readonly resolution: Vector2;
}

function groupStyle(kind: EdgeKind, palette: GraphPalette): { opacity: number; linewidth: number } {
  // 选中/路径要能从「压暗的底图」里一眼挑出来：accent 加粗到 2.2px、接近不透明；
  // strong 略强于普通边；普通边保持 CSS token 的透明度（压暗仍走顶点色乘法）。
  if (kind === "accent") return { opacity: 0.92, linewidth: 2.2 };
  if (kind === "strong") return { opacity: palette.edgeStrong[3], linewidth: 1.25 };
  return { opacity: palette.edge[3], linewidth: 1 };
}

function EdgeGroup({ view, layout, highlight, palette, indexes, kind, resolution }: EdgeGroupProps) {
  const object = useMemo(() => {
    const positions: number[] = [];
    const colors: number[] = [];
    const style = groupStyle(kind, palette);
    const token = kind === "accent" ? palette.accent : kind === "strong" ? palette.edgeStrong : palette.edge;
    const linear = rgbaToLinear(token);

    for (const edgeIndex of indexes) {
      const edge = view.edges[edgeIndex];
      if (!edge) continue;
      const source = layout.indexById.get(edge.source);
      const target = layout.indexById.get(edge.target);
      if (source === undefined || target === undefined) continue;

      const dim = kind !== "accent" && highlight.dimmedEdges.has(edge.id);
      const rgb = dim ? dimLinear(linear, EDGE_DIM_FACTOR) : linear;

      positions.push(
        layout.positions[source * 3],
        layout.positions[source * 3 + 1],
        layout.positions[source * 3 + 2],
        layout.positions[target * 3],
        layout.positions[target * 3 + 1],
        layout.positions[target * 3 + 2],
      );
      // LineSegmentsGeometry.setColors 要每个顶点一份（两端各一份）。
      colors.push(rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2]);
    }

    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(new Float32Array(positions));
    geometry.setColors(new Float32Array(colors));

    const material = new LineMaterial({
      vertexColors: true,
      transparent: true,
      opacity: style.opacity,
      linewidth: style.linewidth,
      depthWrite: false,
      worldUnits: false,
    });
    material.resolution.copy(resolution);

    const lines = new LineSegments2(geometry, material);
    lines.frustumCulled = false;
    lines.renderOrder = 1;
    return lines;
  }, [view, layout, highlight, palette, indexes, kind, resolution]);

  useEffect(() => {
    return () => {
      object.geometry.dispose();
      (object.material as LineMaterial).dispose();
    };
  }, [object]);

  if (indexes.length === 0) return null;
  return <primitive object={object} />;
}

export function EdgeField({ view, layout, highlight, palette }: EdgeFieldProps) {
  const size = useThree((state) => state.size);
  const resolution = useMemo(() => new Vector2(size.width, size.height), [size.width, size.height]);
  const split = useMemo(() => splitEdges(view, highlight), [view, highlight]);

  return (
    <>
      <EdgeGroup
        view={view}
        layout={layout}
        highlight={highlight}
        palette={palette}
        indexes={split.base}
        kind="base"
        resolution={resolution}
      />
      <EdgeGroup
        view={view}
        layout={layout}
        highlight={highlight}
        palette={palette}
        indexes={split.strong}
        kind="strong"
        resolution={resolution}
      />
      <EdgeGroup
        view={view}
        layout={layout}
        highlight={highlight}
        palette={palette}
        indexes={split.accent}
        kind="accent"
        resolution={resolution}
      />
    </>
  );
}
