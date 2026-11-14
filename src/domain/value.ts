/**
 * 价值评估的纯领域规则（规格 v2.0 第 5、6 节）。
 *
 * 两份权重 / 阈值表都只在这里定义一次：服务层只负责「问模型、解析 JSON」，
 * 加权、判定、分级全部由本文件计算，模型返回的总分一律忽略——否则提示词
 * 与算法任何一处改动都会让历史分数不可比。
 */

import type { AiStatus, ValueLevel } from "./objects";

/* -------------------------------------------------------------------------- */
/* 外库资产打分（6 维，进入内库的门槛）                                        */
/* -------------------------------------------------------------------------- */

export interface AiDimensionDefinition {
  key: AiDimensionKey;
  label: string;
  weight: number;
}

export const AI_DIMENSION_KEYS = [
  "completeness",
  "insight",
  "actionability",
  "relevance",
  "timeliness",
  "credibility",
] as const;

export type AiDimensionKey = (typeof AI_DIMENSION_KEYS)[number];

/** 权重合计必须为 100（单测钉死）；顺序即提示词里的展示顺序。 */
export const AI_DIMENSIONS: readonly AiDimensionDefinition[] = [
  { key: "completeness", label: "内容完整度与结构清晰度", weight: 20 },
  { key: "insight", label: "洞察深度 / 非显而易见性", weight: 25 },
  { key: "actionability", label: "可操作性 / 可落地性", weight: 20 },
  { key: "relevance", label: "与已有内库资产的关联与互补性", weight: 15 },
  { key: "timeliness", label: "时效性与长期价值潜力", weight: 10 },
  { key: "credibility", label: "来源可信度与验证痕迹", weight: 10 },
];

export const AI_SCORE_WEIGHT_TOTAL = 100;

/** 综合分阈值（含端点）：≥75 自动进入内库，60–74 待复核，<60 低价值。 */
export const AI_AUTO_PASS_SCORE = 75;
export const AI_REVIEW_SCORE = 60;

/** 每维 0–100 分。 */
export const AI_DIMENSION_MIN = 0;
export const AI_DIMENSION_MAX = 100;

export type AiVerdict = "auto_pass" | "needs_review" | "low_value";

export interface AiDimensionScore {
  key: AiDimensionKey;
  label: string;
  weight: number;
  score: number;
  /** 该维贡献的加权分（score × weight / 100）。 */
  weighted: number;
  reason: string;
}

export interface AiScoreDetail {
  dimensions: AiDimensionScore[];
  /** 四舍五入后的加权总分（0–100）。 */
  total: number;
  verdict: AiVerdict;
  model: string;
  /** UTC ISO-8601。 */
  scoredAt: string;
  source: "model" | "fallback";
  /** 人工复核痕迹；只有复核过的资产才有。 */
  review?: {
    decision: "approve" | "reject";
    note: string | null;
    at: string;
    actorSub: string;
  };
}

export function isAiDimensionKey(value: unknown): value is AiDimensionKey {
  return typeof value === "string" && (AI_DIMENSION_KEYS as readonly string[]).includes(value);
}

/**
 * 加权总分：Σ(score × weight) / 100，四舍五入到整数。
 *
 * 先加权再取整，与「先取整再加权」在 .5 处的判定可能不同；阈值 75 / 60
 * 都按取整后的整数比较，避免出现「74.6 分被判为待复核」的边界歧义。
 */
export function aiWeightedTotal(scores: Record<AiDimensionKey, number>): number {
  let sum = 0;

  for (const dimension of AI_DIMENSIONS) {
    sum += (scores[dimension.key] * dimension.weight) / AI_SCORE_WEIGHT_TOTAL;
  }

  return Math.round(sum);
}

/** 综合分 → 处置结论。 */
export function aiVerdictFor(total: number): AiVerdict {
  if (total >= AI_AUTO_PASS_SCORE) return "auto_pass";
  if (total >= AI_REVIEW_SCORE) return "needs_review";
  return "low_value";
}

/** 判定结论对应的资产状态；三个结论与 `ai_status` 取值一一对应。 */
export function aiStatusForVerdict(verdict: AiVerdict): AiStatus {
  return verdict;
}

/** 逐维组装明细（含加权贡献），`scores` 必须六维齐全。 */
export function buildAiScoreDetail(input: {
  scores: Record<AiDimensionKey, number>;
  reasons: Partial<Record<AiDimensionKey, string>>;
  model: string;
  scoredAt: string;
  source?: AiScoreDetail["source"];
}): AiScoreDetail {
  const dimensions: AiDimensionScore[] = AI_DIMENSIONS.map((dimension) => ({
    key: dimension.key,
    label: dimension.label,
    weight: dimension.weight,
    score: input.scores[dimension.key],
    weighted: Math.round((input.scores[dimension.key] * dimension.weight) / AI_SCORE_WEIGHT_TOTAL * 100) / 100,
    reason: input.reasons[dimension.key] ?? "",
  }));

  const total = aiWeightedTotal(input.scores);

  return {
    dimensions,
    total,
    verdict: aiVerdictFor(total),
    model: input.model,
    scoredAt: input.scoredAt,
    source: input.source ?? "model",
  };
}

/* -------------------------------------------------------------------------- */
/* 内库资产价值评估（5 维，决定 S/A/B/C）                                      */
/* -------------------------------------------------------------------------- */

export const VALUE_DIMENSION_KEYS = [
  "practice",
  "reuse",
  "transferability",
  "uniqueness",
  "timeliness",
] as const;

export type ValueDimensionKey = (typeof VALUE_DIMENSION_KEYS)[number];

export interface ValueDimensionDefinition {
  key: ValueDimensionKey;
  label: string;
  question: string;
}

export const VALUE_DIMENSIONS: readonly ValueDimensionDefinition[] = [
  { key: "practice", label: "实践验证强度", question: "被真实数据与结果验证的深度" },
  { key: "reuse", label: "复用频率 / 复利潜力", question: "被重复调用的频率与持续产生价值的能力" },
  { key: "transferability", label: "可迁移性", question: "能否应用到其他领域或问题" },
  { key: "uniqueness", label: "独特性 / 稀缺性", question: "是否为个人独有洞察" },
  { key: "timeliness", label: "时效性 / 衰减速度", question: "价值随时间贬值的速度" },
];

export const VALUE_SCORE_MIN = 1;
export const VALUE_SCORE_MAX = 5;

/** 等级边界按五维总分（5–25）划分，等价于平均分 4.2 / 3.2 / 2.2。 */
export const VALUE_LEVEL_THRESHOLDS = { S: 21, A: 16, B: 11 } as const;

export interface ValueDimensionScore {
  key: ValueDimensionKey;
  label: string;
  score: number;
  reason: string;
}

export interface ValueScores {
  dimensions: ValueDimensionScore[];
  /** 五维平均分，保留两位小数（1–5）。 */
  average: number;
  level: ValueLevel;
  model: string | null;
  /** UTC ISO-8601。 */
  assessedAt: string;
  /**
   * model     模型评估
   * fallback  模型不可用 / 失败时的确定性兜底（全维 2 分 → C 级）
   * migration 0010 迁移对存量资产的兜底标注
   * rule      v2.1 动态升降级：只替换复用维度后按同一套阈值重算
   */
  source: "model" | "fallback" | "migration" | "rule";
}

export function isValueDimensionKey(value: unknown): value is ValueDimensionKey {
  return typeof value === "string" && (VALUE_DIMENSION_KEYS as readonly string[]).includes(value);
}

export function valueScoreSum(scores: Record<ValueDimensionKey, number>): number {
  return VALUE_DIMENSION_KEYS.reduce((sum, key) => sum + scores[key], 0);
}

/** 五维总分 → S/A/B/C。 */
export function valueLevelFor(scores: Record<ValueDimensionKey, number>): ValueLevel {
  const sum = valueScoreSum(scores);

  if (sum >= VALUE_LEVEL_THRESHOLDS.S) return "S";
  if (sum >= VALUE_LEVEL_THRESHOLDS.A) return "A";
  if (sum >= VALUE_LEVEL_THRESHOLDS.B) return "B";
  return "C";
}

export function buildValueScores(input: {
  scores: Record<ValueDimensionKey, number>;
  reasons?: Partial<Record<ValueDimensionKey, string>>;
  model?: string | null;
  assessedAt: string;
  source?: ValueScores["source"];
}): ValueScores {
  const dimensions: ValueDimensionScore[] = VALUE_DIMENSIONS.map((dimension) => ({
    key: dimension.key,
    label: dimension.label,
    score: input.scores[dimension.key],
    reason: input.reasons?.[dimension.key] ?? "",
  }));

  const sum = valueScoreSum(input.scores);

  return {
    dimensions,
    average: Math.round((sum / VALUE_DIMENSION_KEYS.length) * 100) / 100,
    level: valueLevelFor(input.scores),
    model: input.model ?? null,
    assessedAt: input.assessedAt,
    source: input.source ?? "model",
  };
}

/**
 * 确定性兜底：五维各 2 分（「一般」档），总分 10 → C 级。
 *
 * 结算不能因为模型不可用而失败（规格第 7 节第 2 条），所以必须有这份
 * 不依赖任何外部调用的结果；`source: "fallback"` 让界面能提示「待重评」。
 */
export function fallbackValueScores(assessedAt: string): ValueScores {
  return buildValueScores({
    scores: { practice: 2, reuse: 2, transferability: 2, uniqueness: 2, timeliness: 2 },
    assessedAt,
    source: "fallback",
  });
}

/* -------------------------------------------------------------------------- */
/* 动态升降级（规格 v2.1 §2）                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 价值历史的触发来源（ADR-030）。`create` 覆盖「创建即入库」与「6 维打分
 * 自动沉淀」两条路径；`migration` 只出现在 0011 的回填。
 */
export const VALUE_ASSESSMENT_TRIGGERS = [
  "create",
  "settle",
  "review",
  "manual_reassess",
  "auto_upgrade",
  "auto_downgrade",
  "migration",
] as const;

export type ValueAssessmentTrigger = (typeof VALUE_ASSESSMENT_TRIGGERS)[number];

export function isValueAssessmentTrigger(value: unknown): value is ValueAssessmentTrigger {
  return (
    typeof value === "string" &&
    (VALUE_ASSESSMENT_TRIGGERS as readonly string[]).includes(value)
  );
}

/** 五维 JSON → 纯分数表；缺维度按最低分处理，脏数据不会让升降级算崩。 */
export function valueScoreRecord(scores: ValueScores): Record<ValueDimensionKey, number> {
  const record = {} as Record<ValueDimensionKey, number>;

  for (const key of VALUE_DIMENSION_KEYS) {
    record[key] = scores.dimensions.find((dimension) => dimension.key === key)?.score ?? VALUE_SCORE_MIN;
  }

  return record;
}

/**
 * 近 30 天调用次数 → 复用维度分（1–5）。
 * 阈值来自 v2.1 §2：10 次满分，5 次 4 分，3 次 3 分，1 次 2 分，0 次 1 分。
 */
export function reuseScoreFor(useCount30d: number): number {
  if (useCount30d >= 10) return 5;
  if (useCount30d >= 5) return 4;
  if (useCount30d >= 3) return 3;
  if (useCount30d >= 1) return 2;
  return 1;
}

const LEVEL_ORDER: readonly ValueLevel[] = ["C", "B", "A", "S"];

function levelRank(level: ValueLevel): number {
  return LEVEL_ORDER.indexOf(level);
}

/** 同一资产 24 小时内最多自动调整一次（v2.1 §2 安全阀）。 */
export const DYNAMIC_ADJUST_THROTTLE_MS = 24 * 60 * 60 * 1_000;

/** 90 天未用直接降级；60 天且近 30 天零调用也降级。 */
export const DYNAMIC_IDLE_DAYS = 90;
export const DYNAMIC_ZERO_USE_DAYS = 60;

export interface DynamicAdjustmentInput {
  currentLevel: ValueLevel;
  /** 当前五维分数（`valueScoreRecord(asset.valueScores)`）。 */
  scores: Record<ValueDimensionKey, number>;
  /** 近 30 天事件数。 */
  useCount30d: number;
  /** 距上次使用（从未使用则距创建）的整天数；null = 无法计算，不降级。 */
  daysSinceLastUse: number | null;
  /** 手动锁定后一律不动。 */
  locked: boolean;
  /** 上一次自动调整时间（UTC ISO）；为空表示从未调整。 */
  lastAdjustedAt: string | null;
  /** 本次评估时间（UTC ISO）。 */
  now: string;
}

export interface DynamicAdjustment {
  type: "upgrade" | "downgrade";
  level: ValueLevel;
  scores: ValueScores;
  reason: string;
}

/**
 * 计算一次自动升降级；返回 null 表示「不调整」。
 *
 * 规则（v2.1 §2）：
 * - 锁定、24h 内调过 → 不动；
 * - 降级优先：>90 天未用，或近 30 天零调用且 >60 天未用 → 降 1 级，C 级不再降；
 * - 升级：近 30 天 ≥5 次且 30 天内有调用 → 替换复用维度后重算，最多升 1 级；
 * - 两端都只改「复用」为主的分数，等级一律由 `valueLevelFor` 重算，保证
 *   等级与五维分永远自洽（不存在「标签写 B、分数却是 S」的行）。
 */
export function planDynamicAdjustment(
  input: DynamicAdjustmentInput,
): DynamicAdjustment | null {
  if (input.locked) return null;

  const nowMs = Date.parse(input.now);

  if (!Number.isFinite(nowMs)) return null;

  if (input.lastAdjustedAt) {
    const lastMs = Date.parse(input.lastAdjustedAt);

    if (Number.isFinite(lastMs) && nowMs - lastMs < DYNAMIC_ADJUST_THROTTLE_MS) {
      return null;
    }
  }

  const currentRank = levelRank(input.currentLevel);
  const idleDays = input.daysSinceLastUse;

  // ---- 降级（优先判定）----
  const shouldDowngrade =
    idleDays !== null &&
    (idleDays > DYNAMIC_IDLE_DAYS ||
      (input.useCount30d === 0 && idleDays > DYNAMIC_ZERO_USE_DAYS));

  if (shouldDowngrade) {
    if (input.currentLevel === "C") return null;

    const scores: Record<ValueDimensionKey, number> = {
      ...input.scores,
      reuse: reuseScoreFor(0),
    };

    // 复用从 5 降到 1 最多减 4 分，阈值间隔 5 分，可能一次都跨不过去。
    // 从最高分维度开始逐点下调，直到等级真正下降：只降一级就停。
    while (levelRank(valueLevelFor(scores)) >= currentRank) {
      const key = highestAdjustableDimension(scores);

      if (key === null) break;

      scores[key] -= 1;
    }

    const level = valueLevelFor(scores);

    if (levelRank(level) >= currentRank) return null;

    return {
      type: "downgrade",
      level,
      scores: buildValueScores({
        scores,
        assessedAt: input.now,
        model: null,
        source: "rule",
      }),
      reason:
        `${idleDays} 天未使用（近 30 天 ${input.useCount30d} 次调用），` +
        `复用维度降至 ${reuseScoreFor(0)} 分，${input.currentLevel} → ${level}`,
    };
  }

  // ---- 升级 ----
  const recentlyUsed = idleDays !== null && idleDays <= 30;
  const shouldUpgrade = input.useCount30d >= 5 && recentlyUsed;

  if (!shouldUpgrade) return null;
  if (input.currentLevel === "S") return null;

  const nextReuse = reuseScoreFor(input.useCount30d);
  const scores: Record<ValueDimensionKey, number> = { ...input.scores, reuse: nextReuse };
  const level = valueLevelFor(scores);

  // 复用最多 +4 分，低于相邻档的 5 分间隔，因此重算后至多升一级；
  // 这里仍显式比较，分数没有真正跨档时不做无意义的「调整」。
  if (levelRank(level) <= currentRank) return null;

  return {
    type: "upgrade",
    level,
    scores: buildValueScores({
      scores,
      assessedAt: input.now,
      model: null,
      source: "rule",
    }),
    reason:
      `近 30 天调用 ${input.useCount30d} 次，复用维度升至 ${nextReuse} 分，` +
      `${input.currentLevel} → ${level}`,
  };
}

/**
 * 降级时优先下调当前最高、且仍高于 1 分的维度。
 *
 * 为什么不是只改复用：复用已经压到 1 分仍可能留在原档（例如 S 级总分 25、
 * 复用 5 → 1 后总分 21 仍是 S）。降级承诺的是「等级真的降一级」，因此必须
 * 继续动其他维度；按固定顺序取最高分，结果可复现。
 */
function highestAdjustableDimension(
  scores: Record<ValueDimensionKey, number>,
): ValueDimensionKey | null {
  let candidate: ValueDimensionKey | null = null;

  for (const key of VALUE_DIMENSION_KEYS) {
    if (scores[key] <= VALUE_SCORE_MIN) continue;
    if (candidate === null || scores[key] > scores[candidate]) {
      candidate = key;
    }
  }

  return candidate;
}
