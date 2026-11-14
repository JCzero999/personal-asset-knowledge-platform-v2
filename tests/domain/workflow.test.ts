import { describe, expect, it } from "vitest";

import { DomainError } from "../../src/domain/errors";
import { workStatuses, type WorkStatus } from "../../src/domain/objects";
import {
  allowedTransitions,
  assertTransition,
  canTransition,
  workStatusOrder,
} from "../../src/domain/workflow";

/**
 * 规格 v2.0（ADR-029）：作品只存在于外库。
 * 迁移表本身不变，但 `practiced` 只能在外库发生；内库只是历史数据的兼容分支。
 */
const external = { library: "external" } as const;
const internal = { library: "internal" } as const;

/** 逐条列出的期望迁移表，与实现里的显式表互相印证。 */
const expectedEdges: ReadonlyArray<[WorkStatus, WorkStatus]> = [
  ["draft", "finished"],
  ["finished", "published"],
  ["published", "practiced"],
];

describe("workflow.canTransition", () => {
  it("允许三条正向迁移（外库）", () => {
    for (const [from, to] of expectedEdges) {
      expect(canTransition(from, to, external)).toBe(true);
    }
  });

  it("拒绝跳级、回退与自环", () => {
    for (const from of workStatuses) {
      for (const to of workStatuses) {
        const listed = expectedEdges.some(([a, b]) => a === from && b === to);
        if (!listed) {
          expect(canTransition(from, to, external), `${from} -> ${to}`).toBe(false);
        }
      }
    }
  });

  it("内库作品不能迁移到 practiced（作品只存在于外库）", () => {
    expect(canTransition("published", "practiced", internal)).toBe(false);
    expect(canTransition("draft", "practiced", internal)).toBe(false);
    // 内库的其他正向迁移不受影响（历史数据的兼容分支）
    expect(canTransition("draft", "finished", internal)).toBe(true);
    expect(canTransition("finished", "published", internal)).toBe(true);
  });

  it("渲染顺序只用于展示，且包含全部四个状态", () => {
    expect(new Set(workStatusOrder)).toEqual(new Set(workStatuses));
  });
});

describe("workflow.assertTransition", () => {
  it("合法迁移不抛错", () => {
    expect(() => assertTransition("draft", "finished", external)).not.toThrow();
  });

  it("跳级时抛 INVALID_TRANSITION 并带上下文", () => {
    expect.assertions(3);
    try {
      assertTransition("draft", "published", external);
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      const domainError = error as DomainError;
      expect(domainError.code).toBe("INVALID_TRANSITION");
      expect(domainError.details).toMatchObject({ from: "draft", to: "published" });
    }
  });

  it("内库迁移到 practiced 抛专属错误码", () => {
    expect.assertions(2);
    try {
      assertTransition("published", "practiced", internal);
    } catch (error) {
      expect((error as DomainError).code).toBe("WORK_MUST_BE_EXTERNAL");
      expect((error as DomainError).details).toMatchObject({ library: "internal" });
    }
  });

  it("同状态视为非法迁移", () => {
    expect(() => assertTransition("draft", "draft", external)).toThrow(DomainError);
  });
});

describe("workflow.allowedTransitions", () => {
  it("外库的可用操作", () => {
    expect(allowedTransitions("draft", external)).toEqual(["finished"]);
    expect(allowedTransitions("finished", external)).toEqual(["published"]);
    expect(allowedTransitions("published", external)).toEqual(["practiced"]);
    expect(allowedTransitions("practiced", external)).toEqual([]);
  });

  it("内库作品的 published 没有可用迁移", () => {
    expect(allowedTransitions("published", internal)).toEqual([]);
  });
});
