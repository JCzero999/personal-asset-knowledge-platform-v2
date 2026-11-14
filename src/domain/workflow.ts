import type { Library } from "./objects";
import { DomainError } from "./errors";
import type { WorkStatus } from "./objects";

/**
 * 作品状态机。
 *
 * 迁移关系写成显式的「来源 → 允许目标」表，不依赖任何顺序数组；
 * `workStatusOrder` 只用于界面渲染顺序，不能拿来判断合法性。
 *
 * ADR-029 取代 ADR-008 的一条：作品只存在于外库，`published → practiced`
 * 是用户在看完数据后的手动确认，并由服务层在同一事务里立即沉淀为内库资产。
 */

export interface TransitionContext {
  library: Library;
}

/** 仅用于展示与列表排序。 */
export const workStatusOrder: readonly WorkStatus[] = [
  "draft",
  "finished",
  "published",
  "practiced",
];

/** 显式迁移表：每个来源状态单独列出允许的目标状态。 */
const transitionTable: Readonly<Record<WorkStatus, readonly WorkStatus[]>> = {
  draft: ["finished"],
  finished: ["published"],
  published: ["practiced"],
  practiced: [],
};

export function canTransition(
  from: WorkStatus,
  to: WorkStatus,
  context: TransitionContext,
): boolean {
  if (from === to) {
    return false;
  }

  if (!transitionTable[from].includes(to)) {
    return false;
  }

  // 「已实践」只能发生在作品唯一所在的库（外库）里（ADR-029）。
  if (to === "practiced" && context.library !== "external") {
    return false;
  }

  return true;
}

export function assertTransition(
  from: WorkStatus,
  to: WorkStatus,
  context: TransitionContext,
): void {
  if (from === to) {
    throw new DomainError("INVALID_TRANSITION", `作品已处于 ${from} 状态，无需迁移`, {
      from,
      to,
    });
  }

  if (to === "practiced" && context.library !== "external") {
    throw new DomainError(
      "WORK_MUST_BE_EXTERNAL",
      "作品只存在于外库，标记「已实践」必须在外库完成",
      { from, to, library: context.library },
    );
  }

  if (!transitionTable[from].includes(to)) {
    throw new DomainError("INVALID_TRANSITION", `不允许从 ${from} 迁移到 ${to}`, {
      from,
      to,
      allowed: transitionTable[from],
    });
  }
}

/** 当前状态下（结合库别）所有合法的目标状态，供 UI 渲染操作按钮。 */
export function allowedTransitions(
  from: WorkStatus,
  context: TransitionContext,
): readonly WorkStatus[] {
  return transitionTable[from].filter((to) => canTransition(from, to, context));
}
