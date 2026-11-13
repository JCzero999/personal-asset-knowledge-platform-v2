import { afterEach, describe, expect, it, vi } from "vitest";

import { buildGraphViewModel, type GraphViewModel } from "@/lib/graph-model";
import {
  defaultMaxTicks,
  layoutGalaxy3d,
  SIZE_WORLD_RADIUS,
  type GalaxyLayoutResult,
} from "@/lib/graph-layout-3d";
import type { LightragEdge, LightragNode } from "@/server/adapters/lightrag/client";
import {
  createLayoutMessageHandler,
  installLayoutWorker,
  withWorkerBudget,
  WORKER_TICK_BUDGET_MS,
  type InstallLayoutWorkerOptions,
  type LayoutInboundMessage,
  type LayoutOutboundMessage,
  type LayoutWorkerScope,
} from "@/workers/graph-layout.worker";

/**
 * 3D 布局的 A6 清单（ADR-022 附录 A6）。
 *
 * 纯函数、node 环境：不测 WebGL、不引 jsdom。Worker 协议只测它的纯函数部分
 * （`createLayoutMessageHandler` / `installLayoutWorker`），用假作用域代替真 Worker。
 */

const FILE_PATH = "pakp:obj:obj1:abc";

function node(id: string, type = "concept"): LightragNode {
  return { id, type, description: "", filePath: FILE_PATH };
}

function edge(source: string, target: string): LightragEdge {
  return { source, target, description: "", filePath: FILE_PATH };
}

function buildView(spec: {
  nodes: readonly string[];
  edges: readonly (readonly [string, string])[];
  center: string;
  depth?: 1 | 2 | 3;
  maxNodes?: number;
}): GraphViewModel {
  return buildGraphViewModel({
    subgraph: {
      nodes: spec.nodes.map((id) => node(id)),
      edges: spec.edges.map(([source, target]) => edge(source, target)),
    },
    status: null,
    center: spec.center,
    depth: spec.depth ?? 3,
    maxNodes: spec.maxNodes ?? 600,
  });
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * 分层样例图：1 个中心 + hop1 + hop2 + hop3，`hop3Total` 个 3 跳节点轮流挂在
 * hop2 节点下。默认 1 + 12 + 36 + 101 = 150 个节点（报告里的 150 点样例）。
 */
function sampleView(hop1 = 12, hop2Per = 3, hop3Total = 101): GraphViewModel {
  const nodes: string[] = ["C"];
  const edges: [string, string][] = [];
  const hop2: string[] = [];

  for (let a = 0; a < hop1; a += 1) {
    nodes.push(`A${pad(a)}`);
    edges.push(["C", `A${pad(a)}`]);
  }
  for (let a = 0; a < hop1; a += 1) {
    for (let b = 0; b < hop2Per; b += 1) {
      const id = `B${pad(a)}-${pad(b)}`;
      nodes.push(id);
      edges.push([`A${pad(a)}`, id]);
      hop2.push(id);
    }
  }
  for (let k = 0; k < hop3Total; k += 1) {
    const id = `D${pad(k)}`;
    nodes.push(id);
    edges.push([hop2[k % hop2.length], id]);
  }

  return buildView({ nodes, edges, center: "C" });
}

function positionOf(result: GalaxyLayoutResult, id: string): [number, number, number] {
  const index = result.indexById.get(id);
  if (index === undefined) throw new Error(`布局里没有节点 ${id}`);
  return [
    result.positions[index * 3],
    result.positions[index * 3 + 1],
    result.positions[index * 3 + 2],
  ];
}

function toAnchors(result: GalaxyLayoutResult): Record<string, [number, number, number]> {
  const anchors: Record<string, [number, number, number]> = {};
  result.ids.forEach((id, index) => {
    anchors[id] = [
      result.positions[index * 3],
      result.positions[index * 3 + 1],
      result.positions[index * 3 + 2],
    ];
  });
  return anchors;
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function meanRadius(view: GraphViewModel, result: GalaxyLayoutResult, hop: 1 | 2 | 3): number {
  let sum = 0;
  let count = 0;
  for (const viewNode of view.nodes) {
    if (viewNode.hop !== hop || viewNode.flags.isUnreachable) continue;
    const index = result.indexById.get(viewNode.id) as number;
    sum += Math.hypot(
      result.positions[index * 3],
      result.positions[index * 3 + 1],
      result.positions[index * 3 + 2],
    );
    count += 1;
  }
  return count === 0 ? 0 : sum / count;
}

function minPairDistance(result: GalaxyLayoutResult): number {
  const n = result.ids.length;
  let min = Infinity;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const d = Math.hypot(
        result.positions[i * 3] - result.positions[j * 3],
        result.positions[i * 3 + 1] - result.positions[j * 3 + 1],
        result.positions[i * 3 + 2] - result.positions[j * 3 + 2],
      );
      if (d < min) min = d;
    }
  }
  return min;
}

function positionsEqual(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  const left = Buffer.from(a.buffer, a.byteOffset, a.byteLength);
  const right = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  return left.equals(right);
}

describe("layoutGalaxy3d · 确定性", () => {
  it("同 view + 同 options 两次调用 positions 逐字节相等", () => {
    const view = sampleView();
    const first = layoutGalaxy3d(view, { seedKey: "cache-key-a" });
    const second = layoutGalaxy3d(view, { seedKey: "cache-key-a" });

    expect(first.positions.length).toBe(view.nodes.length * 3);
    expect(positionsEqual(first.positions, second.positions)).toBe(true);
    expect(first.ids).toEqual(second.ids);
    expect(first.ticks).toBe(second.ticks);
  });

  it("同 view + 同 anchors 逐字节相等，且 seedKey 不参与坐标（只做缓存名）", () => {
    const view = sampleView(6, 2, 12);
    const base = layoutGalaxy3d(view, { seedKey: "a", maxTicks: 24 });
    const anchors = toAnchors(base);

    const first = layoutGalaxy3d(view, { seedKey: "a", anchors, maxTicks: 24 });
    const second = layoutGalaxy3d(view, { seedKey: "另一个键", anchors, maxTicks: 24 });
    const third = layoutGalaxy3d(view, { seedKey: "a", anchors, maxTicks: 24 });

    expect(positionsEqual(first.positions, third.positions)).toBe(true);
    // seedKey 只用于缓存与基线命名：换名字不许换图案。
    expect(positionsEqual(first.positions, second.positions)).toBe(true);
  });
});

describe("layoutGalaxy3d · 播种几何", () => {
  it("中心节点落在原点", () => {
    const view = sampleView();
    const result = layoutGalaxy3d(view, { seedKey: "center" });
    const center = positionOf(result, "C");
    expect(center[0]).toBeCloseTo(0, 6);
    expect(center[1]).toBeCloseTo(0, 6);
    expect(center[2]).toBeCloseTo(0, 6);
  });

  it("1/2/3 跳平均半径单调递增，且贴着 85 / 150 / 210", () => {
    const view = sampleView();
    const result = layoutGalaxy3d(view, { seedKey: "rings" });

    const hop1 = meanRadius(view, result, 1);
    const hop2 = meanRadius(view, result, 2);
    const hop3 = meanRadius(view, result, 3);

    expect(hop1).toBeLessThan(hop2);
    expect(hop2).toBeLessThan(hop3);
    // 松弛之后允许偏移，但不许把三层盘拉成别的东西。
    expect(Math.abs(hop1 - 85)).toBeLessThan(25);
    expect(Math.abs(hop2 - 150)).toBeLessThan(30);
    expect(Math.abs(hop3 - 210)).toBeLessThan(40);
  });

  it("不可达节点落在 340 外环", () => {
    const view = buildView({
      nodes: ["C", "A1", "A2", "孤岛1", "孤岛2"],
      edges: [
        ["C", "A1"],
        ["A1", "A2"],
        ["孤岛1", "孤岛2"],
      ],
      center: "C",
    });
    const result = layoutGalaxy3d(view, { seedKey: "islands" });

    for (const id of ["孤岛1", "孤岛2"]) {
      const [x, y, z] = positionOf(result, id);
      const radius = Math.hypot(x, y, z);
      expect(radius).toBeGreaterThan(280);
      expect(radius).toBeLessThan(400);
    }
    // 可达的 2 跳节点仍在 2 跳环附近，没有被外环拽走。
    const [ax, , az] = positionOf(result, "A2");
    expect(Math.hypot(ax, az)).toBeLessThan(260);
  });

  it("bounds 包住所有节点（含节点半径）", () => {
    const view = sampleView();
    const result = layoutGalaxy3d(view, { seedKey: "bounds" });
    for (let i = 0; i < result.ids.length; i += 1) {
      const point = [
        result.positions[i * 3],
        result.positions[i * 3 + 1],
        result.positions[i * 3 + 2],
      ];
      const spread = distance(point, result.bounds.center) + result.radius[i];
      expect(spread).toBeLessThanOrEqual(result.bounds.radius + 1e-3);
    }
  });
});

describe("layoutGalaxy3d · 健康检查", () => {
  it("150 节点样例里没有 NaN / Infinity", () => {
    const view = sampleView();
    const result = layoutGalaxy3d(view, { seedKey: "finite" });
    for (let i = 0; i < result.positions.length; i += 1) {
      expect(Number.isFinite(result.positions[i])).toBe(true);
    }
    expect(Number.isFinite(result.bounds.radius)).toBe(true);
    expect(Number.isFinite(result.layoutMs)).toBe(true);
  });

  it("节点不重叠：最小间距大于 3 个世界单位", () => {
    const view = sampleView();
    const result = layoutGalaxy3d(view, { seedKey: "spacing" });
    expect(minPairDistance(result)).toBeGreaterThan(3);
  });
});

describe("layoutGalaxy3d · anchors", () => {
  it("同一中心连算 5 次，位置集合逐字节不变", () => {
    const view = sampleView(8, 2, 16);
    const first = layoutGalaxy3d(view, { seedKey: "loop" });
    const anchors = toAnchors(first);

    let current = first;
    for (let i = 0; i < 5; i += 1) {
      current = layoutGalaxy3d(view, { seedKey: "loop", anchors });
      expect(positionsEqual(current.positions, first.positions)).toBe(true);
    }
  });

  it("换中心时共有节点位移小于阈值", () => {
    const viewA = sampleView(8, 2, 16);
    const layoutA = layoutGalaxy3d(viewA, { seedKey: "switch" });
    const anchors = toAnchors(layoutA);

    // 同一个节点集合、换一个中心：共有节点不该被重新排到另一侧。
    const viewB = buildView({
      nodes: viewA.nodes.map((entry) => entry.id),
      edges: viewA.edges.map((entry) => [entry.source, entry.target] as const),
      center: "A00",
    });
    const layoutB = layoutGalaxy3d(viewB, { seedKey: "switch", anchors });

    let maxShift = 0;
    for (const viewNode of viewA.nodes) {
      if (viewNode.id === "A00") continue; // 新中心被移到原点，这是预期
      const before = positionOf(layoutA, viewNode.id);
      const after = positionOf(layoutB, viewNode.id);
      maxShift = Math.max(maxShift, distance(before, after));
    }
    expect(maxShift).toBeLessThan(30);
    // 新中心确实回到原点。
    const [cx, cy, cz] = positionOf(layoutB, "A00");
    expect(Math.hypot(cx, cy, cz)).toBeLessThan(1e-3);
  });

  it("非法 anchor（NaN / 长度不对）被忽略，不污染坐标", () => {
    const view = sampleView(4, 2, 4);
    const baseline = layoutGalaxy3d(view, { seedKey: "bad-anchor" });
    const broken = layoutGalaxy3d(view, {
      seedKey: "bad-anchor",
      anchors: {
        A00: [Number.NaN, 0, 0],
        A01: [1, 2] as unknown as [number, number, number],
      },
    });
    expect(positionsEqual(baseline.positions, broken.positions)).toBe(true);
  });
});

describe("layoutGalaxy3d · 预算", () => {
  it("maxTicks 显式给值 → ticks 正好等于它，且不置 truncated", () => {
    const view = sampleView(4, 2, 4);
    const result = layoutGalaxy3d(view, { seedKey: "budget", maxTicks: 7 });
    expect(result.ticks).toBe(7);
    expect(result.truncated).toBe(false);
  });

  it("默认 maxTicks 按节点数分档：≤150 → 80、151–600 → 150、601–2000 → 220", () => {
    expect(defaultMaxTicks(0)).toBe(80);
    expect(defaultMaxTicks(150)).toBe(80);
    expect(defaultMaxTicks(151)).toBe(150);
    expect(defaultMaxTicks(600)).toBe(150);
    expect(defaultMaxTicks(601)).toBe(220);
    expect(defaultMaxTicks(2000)).toBe(220);

    const small = layoutGalaxy3d(sampleView(4, 2, 4), { seedKey: "tier" }); // 13 个节点
    expect(small.ticks).toBe(80);

    // 1 + 12 + 36 + 150 = 199 个节点 → 151–600 档
    const medium = layoutGalaxy3d(sampleView(12, 3, 150), { seedKey: "tier" });
    expect(medium.ticks).toBe(150);

    // 1 + 20 + 100 + 500 = 621 个节点 → 601–2000 档
    const large = layoutGalaxy3d(sampleView(20, 5, 500), { seedKey: "tier" });
    expect(large.ticks).toBe(220);
  });

  it("deadlineMs = 0 → 一个 tick 都不跑，truncated 为 true", () => {
    const view = sampleView();
    const result = layoutGalaxy3d(view, { seedKey: "deadline", deadlineMs: 0 });
    expect(result.ticks).toBe(0);
    expect(result.truncated).toBe(true);
    // 仍要给出可用的播种解，而不是空数组。
    expect(result.positions.length).toBe(view.nodes.length * 3);
  });

  it(">2000 节点抽稀到 2000 再布局，并置 truncated", () => {
    const hop1 = 10;
    const hop2Per = 10;
    const hop3Total = 2100;
    const view = sampleView(hop1, hop2Per, hop3Total);
    expect(view.nodes.length).toBeGreaterThan(2000);

    const result = layoutGalaxy3d(view, { seedKey: "downsample", maxTicks: 2 });
    expect(result.ids.length).toBe(2000);
    expect(result.positions.length).toBe(2000 * 3);
    expect(result.truncated).toBe(true);
    // 抽稀保留的是 hop 小、度数高的节点：中心一定在里面。
    expect(result.indexById.has("C")).toBe(true);

    // 抽稀路径也要确定：同输入两次调用逐字节相等。
    const again = layoutGalaxy3d(view, { seedKey: "downsample", maxTicks: 2 });
    expect(positionsEqual(result.positions, again.positions)).toBe(true);
  });
});

describe("layoutGalaxy3d · 映射与半径", () => {
  it("indexById 与 ids 互逆", () => {
    const view = sampleView(6, 2, 10);
    const result = layoutGalaxy3d(view, { seedKey: "inverse" });
    expect(result.ids.length).toBe(view.nodes.length);

    result.ids.forEach((id, index) => {
      expect(result.indexById.get(id)).toBe(index);
    });
    expect(result.indexById.size).toBe(result.ids.length);

    // 两边都是同一批节点，没有多也没有少。
    const layoutIds = new Set(result.ids);
    for (const viewNode of view.nodes) expect(layoutIds.has(viewNode.id)).toBe(true);

    // 迭代顺序是契约：ids 按 id 码点序，不受 view.nodes 的 (hop, degree) 排序影响。
    expect([...result.ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(result.ids);
  });

  it("radius 与 node.size 的四档一一对应", () => {
    const view = sampleView();
    const result = layoutGalaxy3d(view, { seedKey: "radius" });
    for (const viewNode of view.nodes) {
      const index = result.indexById.get(viewNode.id) as number;
      // Float32Array 存不住 4.4 的十进制表示，按 1e-4 比。
      expect(result.radius[index]).toBeCloseTo(SIZE_WORLD_RADIUS[viewNode.size], 4);
    }
    expect(SIZE_WORLD_RADIUS).toEqual({ s: 1.9, m: 2.5, l: 3.3, xl: 4.4 });
    // 中心度数最高 → xl。
    const centerIndex = result.indexById.get("C") as number;
    expect(result.radius[centerIndex]).toBeCloseTo(4.4, 4);
  });
});

describe("layoutGalaxy3d · 退化输入", () => {
  it("空图返回空结果且不抛错", () => {
    const view = buildGraphViewModel({
      subgraph: { nodes: [], edges: [] },
      status: null,
      center: "不存在的中心",
      depth: 2,
      maxNodes: 150,
    });
    const result = layoutGalaxy3d(view, { seedKey: "empty" });
    expect(result.positions.length).toBe(0);
    expect(result.radius.length).toBe(0);
    expect(result.ids).toEqual([]);
    expect(result.indexById.size).toBe(0);
    expect(result.ticks).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.bounds.radius).toBe(0);
  });

  it("单节点图把它放在原点", () => {
    const view = buildView({ nodes: ["唯一"], edges: [], center: "唯一" });
    const result = layoutGalaxy3d(view, { seedKey: "single" });
    expect(result.ids).toEqual(["唯一"]);
    expect(result.positions[0]).toBe(0);
    expect(result.positions[1]).toBe(0);
    expect(result.positions[2]).toBe(0);
    expect(result.ticks).toBe(defaultMaxTicks(1));
    expect(result.bounds.radius).toBeCloseTo(SIZE_WORLD_RADIUS.s, 5);
  });

  it("全不可达的碎图：没有中心，全部落外环且数值有限", () => {
    const view = buildView({
      nodes: ["甲", "乙", "丙"],
      edges: [
        ["甲", "乙"],
        ["乙", "丙"],
      ],
      // 中心不在集合里：模型把所有节点记 hop 3 + isUnreachable。
      center: "缺席的中心",
    });
    const result = layoutGalaxy3d(view, { seedKey: "fragmented" });

    expect(result.ids.length).toBe(3);
    for (const id of result.ids) {
      const [x, y, z] = positionOf(result, id);
      expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)).toBe(true);
      expect(Math.hypot(x, y, z)).toBeGreaterThan(250);
    }
    expect(minPairDistance(result)).toBeGreaterThan(3);
  });
});

type DoneMessage = Extract<LayoutOutboundMessage, { type: "done" }>;

interface WorkerHarness {
  readonly posted: LayoutOutboundMessage[];
  send(data: LayoutInboundMessage): void;
  /** 派发所有待跑的宏任务（模拟事件循环让出后 Worker 继续干活）。 */
  flush(): void;
}

/**
 * 假作用域 + 手动调度器：默认 400ms 预算的用例要真的跑 400ms，而队列丢弃的用例
 * 必须能控制「消息到达」与「布局开始」的先后，所以不用真定时器。
 */
function installHarness(options: InstallLayoutWorkerOptions = {}): WorkerHarness {
  const posted: LayoutOutboundMessage[] = [];
  const tasks: (() => void)[] = [];
  let listener: ((event: MessageEvent<LayoutInboundMessage>) => void) | null = null;
  const scope: LayoutWorkerScope = {
    postMessage(message) {
      posted.push(message);
    },
    addEventListener(_type, handler) {
      listener = handler;
    },
  };
  installLayoutWorker(scope, {
    ...options,
    scheduler: options.scheduler ?? {
      schedule(task) {
        tasks.push(task);
      },
    },
  });
  return {
    posted,
    send(data) {
      (listener as (event: MessageEvent<LayoutInboundMessage>) => void)({
        data,
      } as MessageEvent<LayoutInboundMessage>);
    },
    flush() {
      while (tasks.length > 0) {
        const task = tasks.shift() as () => void;
        task();
      }
    },
  };
}

describe("graph-layout.worker · 协议", () => {
  const view = sampleView(6, 2, 8);
  const options = { seedKey: "worker", maxTicks: 16 };

  it("layout 请求回 done，结果与同步调用逐字节一致", () => {
    const handler = createLayoutMessageHandler({ onCancel: () => undefined });
    const reply = handler({ type: "layout", view, options }) as DoneMessage;
    expect(reply.type).toBe("done");

    const direct = layoutGalaxy3d(view, options);
    expect(positionsEqual(reply.result.positions, direct.positions)).toBe(true);
    expect(reply.result.ids).toEqual(direct.ids);
    expect(reply.result.radius).toEqual(direct.radius);
  });

  it("cancel 走 onCancel 且不回消息，也不污染后续请求", () => {
    let cancels = 0;
    const handler = createLayoutMessageHandler({
      onCancel: () => {
        cancels += 1;
      },
    });

    expect(handler({ type: "cancel" })).toBeNull();
    expect(cancels).toBe(1);

    // 旧实现是「置标志位 → 下一次 layout 立刻退出」，那恰好证明 cancel 无效。
    // 现在 cancel 只清队列：后续请求照常跑满显式 maxTicks。
    const reply = handler({ type: "layout", view, options }) as DoneMessage;
    expect(reply.type).toBe("done");
    expect(reply.result.ticks).toBe(16);
    expect(reply.result.truncated).toBe(false);
  });

  it("未知消息类型 / 缺 view 走 error，不抛异常", () => {
    const handler = createLayoutMessageHandler({ onCancel: () => undefined });
    const unknown = handler({ type: "bogus" } as unknown as LayoutInboundMessage);
    expect(unknown?.type).toBe("error");
    const missing = handler({ type: "layout", options } as unknown as LayoutInboundMessage);
    expect(missing?.type).toBe("error");
    if (missing?.type === "error") expect(missing.message).toContain("view");
  });
});

describe("graph-layout.worker · 默认 400ms 预算", () => {
  /** 1 + 10 + 100 + 1889 = 2000：正好到档位上限，不触发抽稀，截断只能来自 deadline。 */
  function view2000(): GraphViewModel {
    const view = sampleView(10, 10, 1889);
    expect(view.nodes.length).toBe(2000);
    return view;
  }

  it("withWorkerBudget：不传 deadlineMs 注入 400，显式值（含 0）优先", () => {
    expect(WORKER_TICK_BUDGET_MS).toBe(400);

    const implicit = withWorkerBudget({ seedKey: "x" });
    expect(implicit.deadlineMs).toBe(400);
    expect(withWorkerBudget(undefined).deadlineMs).toBe(400);
    expect(withWorkerBudget({ seedKey: "x", deadlineMs: 0 }).deadlineMs).toBe(0);
    expect(withWorkerBudget({ seedKey: "x", deadlineMs: 120 }).deadlineMs).toBe(120);
    expect(withWorkerBudget({ seedKey: "x" }, 250).deadlineMs).toBe(250);
    // seedKey / maxTicks 原样透传，默认预算不碰别的字段。
    expect(withWorkerBudget({ seedKey: "x", maxTicks: 7 }).maxTicks).toBe(7);
    expect(withWorkerBudget({ seedKey: "x" }).seedKey).toBe("x");
  });

  it("2000 节点不传 deadlineMs：Worker 在 400ms 左右停止并 truncated", () => {
    const view = view2000();
    const harness = installHarness();
    harness.send({ type: "layout", view, options: { seedKey: "worker-budget" } });
    harness.flush();

    expect(harness.posted.length).toBe(1);
    const reply = harness.posted[0] as DoneMessage;
    expect(reply.type).toBe("done");
    expect(reply.result.ids.length).toBe(2000);
    expect(reply.result.positions.length).toBe(2000 * 3);

    // 默认 maxTicks 是 220：被提前打断才说明 400ms 预算真的接上了。
    expect(reply.result.truncated).toBe(true);
    expect(reply.result.ticks).toBeLessThan(defaultMaxTicks(2000));
    expect(reply.result.ticks).toBeGreaterThan(0);

    // 下界是「到点才停」，上界给宽（默认 5s 用例超时内），避免机器负载导致 flaky。
    expect(reply.result.layoutMs).toBeGreaterThanOrEqual(WORKER_TICK_BUDGET_MS);
    expect(reply.result.layoutMs).toBeLessThan(1200);
  });

  it("冻结的 layoutGalaxy3d 不注入默认预算：默认值只在 Worker 层", () => {
    const view = view2000();
    const result = layoutGalaxy3d(view, { seedKey: "no-default" });
    expect(result.ticks).toBe(defaultMaxTicks(2000));
    expect(result.truncated).toBe(false);
  });
});

describe("graph-layout.worker · 取消 = 队列丢弃", () => {
  const viewA = sampleView(2, 1, 0); // 1 + 2 + 2 = 5 个节点
  const viewB = sampleView(4, 1, 0); // 1 + 4 + 4 = 9 个节点

  it("layout 之后、开始之前收到 cancel → 丢弃并回 cancelled，不回 done", () => {
    const harness = installHarness();
    harness.send({ type: "layout", view: viewA, options: { seedKey: "a" } });
    harness.send({ type: "cancel" });
    harness.flush();

    expect(harness.posted).toEqual([{ type: "cancelled" }]);
  });

  it("空队列上的 cancel 是 no-op，不回任何消息", () => {
    const harness = installHarness();
    harness.send({ type: "cancel" });
    harness.flush();

    expect(harness.posted).toEqual([]);
  });

  it("已经开始的布局不会被 cancel 打断（队列语义的边界，由 400ms 预算兜底）", () => {
    const harness = installHarness();
    harness.send({ type: "layout", view: viewA, options: { seedKey: "a", maxTicks: 8 } });
    harness.flush(); // 布局已经跑完：说明「运行中取消」在同步循环里不可能发生

    harness.send({ type: "cancel" });
    harness.flush();

    expect(harness.posted.length).toBe(1);
    const done = harness.posted[0] as DoneMessage;
    expect(done.type).toBe("done");
    expect(done.result.ticks).toBe(8);
    expect(done.result.truncated).toBe(false);
  });

  it("两条 layout 挤在同一批消息里：旧的被覆盖并回 cancelled，只算最新那条", () => {
    const harness = installHarness();
    harness.send({ type: "layout", view: viewA, options: { seedKey: "a" } });
    harness.send({ type: "layout", view: viewB, options: { seedKey: "b" } });
    harness.flush();

    expect(harness.posted.map((message) => message.type)).toEqual(["cancelled", "done"]);
    const done = harness.posted[1] as DoneMessage;
    expect(done.result.ids.length).toBe(viewB.nodes.length);
  });

  it("cancel 之后的新 layout 照常跑满（旧实现会把它当成截断）", () => {
    const harness = installHarness();
    harness.send({ type: "cancel" });
    harness.send({ type: "layout", view: viewA, options: { seedKey: "a", maxTicks: 10 } });
    harness.flush();

    expect(harness.posted.length).toBe(1);
    const done = harness.posted[0] as DoneMessage;
    expect(done.type).toBe("done");
    expect(done.result.ticks).toBe(10);
    expect(done.result.truncated).toBe(false);
  });
});

describe("graph-layout.worker · 主线程 import 无副作用", () => {
  const WATCHED = [
    "self",
    "window",
    "WorkerGlobalScope",
    "postMessage",
    "addEventListener",
  ] as const;
  const original = new Map<string, PropertyDescriptor | undefined>(
    WATCHED.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );

  afterEach(() => {
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    vi.resetModules();
  });

  it("模拟浏览器主线程（self === window）import 不注册监听、不 postMessage", async () => {
    const postMessage = vi.fn();
    const addEventListener = vi.fn();
    const fakeWindow = { postMessage, addEventListener };
    (globalThis as Record<string, unknown>).window = fakeWindow;
    (globalThis as Record<string, unknown>).self = fakeWindow;

    vi.resetModules();
    await import("@/workers/graph-layout.worker");

    expect(addEventListener).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("真的在 Worker 作用域（存在 WorkerGlobalScope）时才挂一个 message 监听", async () => {
    const postMessage = vi.fn();
    const listeners: unknown[] = [];
    (globalThis as Record<string, unknown>).WorkerGlobalScope = class WorkerGlobalScope {};
    (globalThis as Record<string, unknown>).postMessage = postMessage;
    (globalThis as Record<string, unknown>).addEventListener = (
      type: string,
      listener: unknown,
    ) => {
      if (type === "message") listeners.push(listener);
    };

    vi.resetModules();
    await import("@/workers/graph-layout.worker");

    expect(listeners.length).toBe(1);
    expect(postMessage).not.toHaveBeenCalled();
  });
});
