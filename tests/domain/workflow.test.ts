import { describe, expect, it } from "vitest";

import { DomainError } from "../../src/domain/errors";
import { workStatuses, type WorkStatus } from "../../src/domain/objects";
import {
  allowedTransitions,
  assertTransition,
  canTransition,
  workStatusOrder,
} from "../../src/domain/workflow";

const internal = { library: "internal" } as const;
const external = { library: "external" } as const;

/** 逐条列出的期望迁移表，与实现里的显式表互相印证。 */
const expectedEdges: ReadonlyArray<[WorkStatus, WorkStatus]> = [
  ["draft", "finished"],
  ["finished", "published"],
  ["published", "practiced"],
];

describe("workflow.canTransition", () => {
  it("允许三条正向迁移（内库）", () => {
    for (const [from, to] of expectedEdges) {
      expect(canTransition(from, to, internal)).toBe(true);
    }
  });

  it("拒绝跳级、回退与自环", () => {
    for (const from of workStatuses) {
      for (const to of workStatuses) {
        const listed = expectedEdges.some(([a, b]) => a === from && b === to);
        if (!listed) {
          expect(canTransition(from, to, internal), `${from} -> ${to}`).toBe(false);
        }
      }
    }
  });

  it("外库作品不能迁移到 practiced", () => {
    expect(canTransition("published", "practiced", external)).toBe(false);
    expect(canTransition("draft", "practiced", external)).toBe(false);
    // 外库的其他正向迁移不受影响
    expect(canTransition("draft", "finished", external)).toBe(true);
    expect(canTransition("finished", "published", external)).toBe(true);
  });

  it("渲染顺序只用于展示，且包含全部四个状态", () => {
    expect(new Set(workStatusOrder)).toEqual(new Set(workStatuses));
  });
});

describe("workflow.assertTransition", () => {
  it("合法迁移不抛错", () => {
    expect(() => assertTransition("draft", "finished", internal)).not.toThrow();
  });

  it("跳级时抛 INVALID_TRANSITION 并带上下文", () => {
    expect.assertions(3);
    try {
      assertTransition("draft", "published", internal);
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      const domainError = error as DomainError;
      expect(domainError.code).toBe("INVALID_TRANSITION");
      expect(domainError.details).toMatchObject({ from: "draft", to: "published" });
    }
  });

  it("外库迁移到 practiced 抛专属错误码", () => {
    expect.assertions(2);
    try {
      assertTransition("published", "practiced", external);
    } catch (error) {
      expect((error as DomainError).code).toBe("EXTERNAL_LIBRARY_PRACTICED");
      expect((error as DomainError).details).toMatchObject({ library: "external" });
    }
  });

  it("同状态视为非法迁移", () => {
    expect(() => assertTransition("draft", "draft", internal)).toThrow(DomainError);
  });
});

describe("workflow.allowedTransitions", () => {
  it("内库与终态的可用操作", () => {
    expect(allowedTransitions("draft", internal)).toEqual(["finished"]);
    expect(allowedTransitions("finished", internal)).toEqual(["published"]);
    expect(allowedTransitions("published", internal)).toEqual(["practiced"]);
    expect(allowedTransitions("practiced", internal)).toEqual([]);
  });

  it("外库作品的 published 没有可用迁移", () => {
    expect(allowedTransitions("published", external)).toEqual([]);
  });
});
