/**
 * 3D 银河布局 Worker（ADR-022 附录 A3「Worker 协议」）。
 *
 * 入站：
 * - `{ type: "layout", view, options }` — 进 one-slot 队列，由一个宏任务 flush；
 * - `{ type: "cancel" }` — **只丢弃还没开始的那条请求**，见下。
 *
 * 出站（每条 layout 请求最多一条终态回复）：
 * - `{ type: "done", result }` / `{ type: "error", message }`；
 * - `{ type: "cancelled" }` — 这条请求在开始前被 cancel 或更新的 layout 丢掉了。
 *
 * 取消语义（2026-11-13 修正，v1.3）：布局是同步循环，Worker 的事件循环在整段布局期间
 * 不派发新消息——所以一条 `cancel` **物理上不可能落在布局进行中**。上一版写的是
 * 「置标志位、下个 tick 间隙退出」，但该标志位在下次 layout 前又被清零，实际永远无效
 * （旧测试「cancel 后下一次 layout 立即退出」只是证明了这一点）。现在取消是**队列语义**：
 * 请求先进 one-slot 队列，在一次宏任务里 flush；在此之前到达的 cancel（或更新的 layout）
 * 把它丢掉并回一条 `cancelled`。**已经开始的布局不可中断，由 400ms tick 预算兜底。**
 *
 * 两个时钟：
 * - `WORKER_TICK_BUDGET_MS = 400` 是 Worker 内 tick 预算，由本层**默认注入**
 *   （调用方不传 `deadlineMs` 也生效），到点以当前解返回并置 `truncated`；
 * - 验收第 3 条的 ≤1200ms 是端到端，含序列化、调度、首帧，不在本文件里度量。
 *   one-slot 队列让出一条宏任务的延迟（~0–4ms）算进端到端，不算进 tick 预算。
 *
 * 边界：**不 import React / three / 任何 `@/components`**，只 import 纯数学的布局模块；
 * 不碰 `window`、不测量帧。模块被主线程 import 时**无副作用**：只有真的处在 Worker
 * 作用域（`WorkerGlobalScope` 存在）才自动挂载——浏览器主线程的 `self` 就是 `window`，
 * 用 `typeof self` 判断会把监听装到 window 上。
 */

import type { GraphViewModel } from "@/lib/graph-model";
import {
  layoutGalaxy3dControlled,
  type GalaxyLayoutOptions,
  type GalaxyLayoutResult,
} from "@/lib/graph-layout-3d";

/** Worker 内 tick 预算（A3「两个时钟」里的第一个）。调用方不传 `deadlineMs` 时用它。 */
export const WORKER_TICK_BUDGET_MS = 400;

export interface LayoutRequestMessage {
  readonly type: "layout";
  readonly view: GraphViewModel;
  readonly options: GalaxyLayoutOptions;
}

/**
 * `cancel` 的语义是「丢弃还没开始的请求」，不是「打断正在跑的布局」；
 * 名字保留是为了不动 A3 的线上协议，语义见文件头。
 */
export interface LayoutCancelMessage {
  readonly type: "cancel";
}

export type LayoutInboundMessage = LayoutRequestMessage | LayoutCancelMessage;

export type LayoutOutboundMessage =
  | { readonly type: "done"; readonly result: GalaxyLayoutResult }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "cancelled" };

export interface LayoutWorkerControl {
  /** 收到 `cancel` 时调用；安装层的实现是清空待跑队列。 */
  readonly onCancel: () => void;
}

/**
 * 把调用方给的 options 与 Worker 默认预算合并：显式 `deadlineMs`（含 0）优先，
 * 其余情况一律用 `budgetMs`。冻结签名 `layoutGalaxy3d` 不改，默认值只在本层生效。
 */
export function withWorkerBudget(
  options: GalaxyLayoutOptions | undefined,
  budgetMs: number = WORKER_TICK_BUDGET_MS,
): GalaxyLayoutOptions {
  const requested = options ?? { seedKey: "" };
  const explicit = requested.deadlineMs;
  return {
    ...requested,
    deadlineMs: typeof explicit === "number" && Number.isFinite(explicit) ? explicit : budgetMs,
  };
}

/**
 * 协议的纯函数部分：把一条入站消息变成一条出站消息（`cancel` 返回 null，不回消息）。
 * 单独导出是为了在 node 环境里测协议本身，不必起 Worker、不必引 jsdom。
 * 注意这里**没有** `shouldStop`：同步循环期间读不到消息，所谓「运行中取消」是假的。
 */
export function createLayoutMessageHandler(
  control: LayoutWorkerControl,
  budgetMs: number = WORKER_TICK_BUDGET_MS,
): (message: LayoutInboundMessage) => LayoutOutboundMessage | null {
  return (message: LayoutInboundMessage): LayoutOutboundMessage | null => {
    if (!message || typeof message !== "object") {
      return { type: "error", message: "布局消息必须是一个对象" };
    }
    if (message.type === "cancel") {
      control.onCancel();
      return null;
    }
    if (message.type !== "layout") {
      return { type: "error", message: "未知的布局消息类型" };
    }
    if (!message.view || !Array.isArray(message.view.nodes)) {
      return { type: "error", message: "布局请求缺少 view.nodes" };
    }
    try {
      const result = layoutGalaxy3dControlled(
        message.view,
        withWorkerBudget(message.options, budgetMs),
      );
      return { type: "done", result };
    } catch (error) {
      return {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

/** Worker 作用域里我们用到的最小面；不引 lib.webworker，避免与 lib.dom 冲突。 */
export interface LayoutWorkerScope {
  postMessage(message: LayoutOutboundMessage): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<LayoutInboundMessage>) => void,
  ): void;
}

/** 让出一条宏任务用；测试可注入手动队列，避免依赖真定时器。 */
export interface LayoutWorkerScheduler {
  schedule(task: () => void): void;
}

export const defaultLayoutWorkerScheduler: LayoutWorkerScheduler = {
  schedule(task) {
    setTimeout(task, 0);
  },
};

export interface InstallLayoutWorkerOptions {
  readonly scheduler?: LayoutWorkerScheduler;
  /** 覆盖默认 400ms 预算；生产不传，只有测试用来把预算压短。 */
  readonly budgetMs?: number;
}

/**
 * 把协议挂到给定作用域上。取消是队列语义：one-slot 队列 + 一次宏任务 flush，
 * 在 flush 之前到达的 cancel 或更新的 layout 会丢掉尚未开始的那条（回 `cancelled`）。
 * 已经开始的布局不会被 cancel 打断——那是同步循环的物理上限，由 400ms 预算兜底。
 */
export function installLayoutWorker(
  scope: LayoutWorkerScope,
  options: InstallLayoutWorkerOptions = {},
): void {
  const budgetMs = options.budgetMs ?? WORKER_TICK_BUDGET_MS;
  const scheduler = options.scheduler ?? defaultLayoutWorkerScheduler;

  /** one-slot 队列：只保留最新一条还没开始的请求。 */
  let pending: LayoutRequestMessage | null = null;
  let flushScheduled = false;

  const handle = createLayoutMessageHandler(
    {
      onCancel: () => {
        pending = null;
      },
    },
    budgetMs,
  );

  const flush = () => {
    flushScheduled = false;
    const request = pending;
    pending = null;
    if (!request) return;
    const reply = handle(request);
    if (reply) scope.postMessage(reply);
  };

  scope.addEventListener("message", (event) => {
    const data = event.data;

    if (data && data.type === "layout") {
      // 还没开始的那条被新请求覆盖：明确回一条 cancelled，调用方不用等永远不会来的 done。
      if (pending !== null) {
        pending = null;
        scope.postMessage({ type: "cancelled" });
      }
      pending = data;
      if (!flushScheduled) {
        flushScheduled = true;
        scheduler.schedule(flush);
      }
      return;
    }

    if (data && data.type === "cancel") {
      const dropped = pending !== null;
      handle(data); // 队列清空交给纯函数协议的 onCancel，只有一处决策
      if (dropped) scope.postMessage({ type: "cancelled" });
      return;
    }

    // 未知类型 / 非法消息：立刻回 error，不进队列。
    const reply = handle(data as LayoutInboundMessage);
    if (reply) scope.postMessage(reply);
  });
}

/**
 * 只有真的处在 Worker 作用域才自动挂载。
 * 判据用 `WorkerGlobalScope` 而不是 `self`：浏览器主线程 `self === window`，
 * 用 `self` 判断会让任何 import 本模块的组件在 window 上装监听并向 window postMessage。
 */
const workerGlobals = globalThis as unknown as {
  WorkerGlobalScope?: unknown;
  postMessage?: (message: LayoutOutboundMessage) => void;
  addEventListener?: (
    type: "message",
    listener: (event: MessageEvent<LayoutInboundMessage>) => void,
  ) => void;
};

if (
  typeof workerGlobals.WorkerGlobalScope !== "undefined" &&
  typeof workerGlobals.postMessage === "function" &&
  typeof workerGlobals.addEventListener === "function"
) {
  installLayoutWorker(workerGlobals as unknown as LayoutWorkerScope);
}
