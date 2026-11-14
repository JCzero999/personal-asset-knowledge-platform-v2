import {
  isAiStatus,
  isValueLevel,
  type AiStatus,
  type BusinessObject,
  type ValueLevel,
} from "@/domain/objects";

/**
 * 内容流转生命周期（规格 v2.0）：AI 评分、人工复核、实践沉淀与价值等级。
 *
 * 值域与字段的真相在 `src/domain/objects.ts`，这里只放**展示层**的换算：
 * 徽标文案与语义色、分数与权重归一化、列表筛选的 URL 解析。所有读取都对
 * 缺省值（null / 未打分）兜底，组件不必自己判空。
 */

/** 维度明细的最小结构：AI 六维与价值五维都能直接传进来。 */
export interface DimensionLike {
  key: string;
  label?: string;
  weight?: number;
  score?: number;
  reason?: string;
}

/** 规格第 5.1 节的六个 AI 维度：接口没带 label 时按 key 回退。 */
export const aiDimensionLabels: Record<string, string> = {
  completeness: "内容完整度与结构清晰度",
  insight: "洞察深度 / 非显而易见性",
  actionability: "可操作性 / 可落地性",
  relevance: "与已有内库资产的关联与互补性",
  timeliness: "时效性与长期价值潜力",
  credibility: "来源可信度与验证痕迹",
};

/** 规格第 6.1 节的五个价值维度。 */
export const valueDimensionLabels: Record<string, string> = {
  practice: "实践验证强度",
  reuse: "复用频率 / 复利潜力",
  transferability: "可迁移性",
  uniqueness: "独特性 / 稀缺性",
  timeliness: "时效性 / 衰减速度",
};

/** 外库资产缺省视为「未打分」；内库资产缺省表示还没做价值评估。 */
export function readAiStatus(object: BusinessObject): AiStatus {
  return isAiStatus(object.aiStatus) ? object.aiStatus : "unscored";
}

export function readValueLevel(object: BusinessObject): ValueLevel | null {
  return isValueLevel(object.valueLevel) ? object.valueLevel : null;
}

export function readAiScore(object: BusinessObject): number | null {
  const score = typeof object.aiScore === "number" ? object.aiScore : object.aiScoreDetail?.total;
  return typeof score === "number" && Number.isFinite(score) ? score : null;
}

/** 分数展示：整数不带小数，其余保留一位。 */
export function formatScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

export type BadgeTone = "muted" | "ok" | "info" | "warn" | "danger";

export interface LifecycleBadge {
  key: string;
  label: string;
  tone: BadgeTone;
}

/** 外库资产的 AI 状态徽标；内库资产不显示 AI 徽标。 */
export function aiBadge(object: BusinessObject): LifecycleBadge | null {
  if (object.type !== "asset" || object.library !== "external") return null;

  const status = readAiStatus(object);
  const score = readAiScore(object);
  const scoreText = score === null ? "" : `${formatScore(score)} 分`;

  switch (status) {
    case "auto_pass":
      return {
        key: "ai-auto_pass",
        label: scoreText ? `${scoreText} · AI 推荐` : "AI 推荐",
        tone: "ok",
      };
    case "needs_review":
      return {
        key: "ai-needs_review",
        label: scoreText ? `${scoreText} · 待人工复核` : "待人工复核",
        tone: "warn",
      };
    case "low_value":
      return {
        key: "ai-low_value",
        label: scoreText ? `${scoreText} · 低价值` : "低价值",
        tone: "danger",
      };
    case "approved":
      return {
        key: "ai-approved",
        label: scoreText ? `${scoreText} · 已通过` : "已通过",
        tone: "info",
      };
    case "rejected":
      return { key: "ai-rejected", label: "已拒绝", tone: "danger" };
    default:
      return { key: "ai-unscored", label: "未打分", tone: "muted" };
  }
}

/** 内库资产的价值等级徽标；S/A 分别落在 success / info 语义色上。 */
export function valueBadge(object: BusinessObject): LifecycleBadge | null {
  if (object.type !== "asset" || object.library !== "internal") return null;

  const level = readValueLevel(object);
  if (!level) return null;

  const tone: BadgeTone =
    level === "S" ? "ok"
    : level === "A" ? "info"
    : level === "B" ? "muted"
    : "warn";

  return { key: `level-${level}`, label: `${level} 级`, tone };
}

/** 列表行与详情页头部共用的徽标组：内库看等级，外库看评分。 */
export function lifecycleBadges(object: BusinessObject): LifecycleBadge[] {
  if (object.type !== "asset") return [];
  const badge = valueBadge(object) ?? aiBadge(object);
  return badge ? [badge] : [];
}

export const valueLevelDescriptions: Record<ValueLevel, string> = {
  S: "核心资产 · 高验证、高复用、高可迁移",
  A: "重要资产 · 有明确验证，复用价值较好",
  B: "一般资产 · 已进入内库，价值中等",
  C: "观察资产 · 价值较低，考虑降级或归档",
};

/** 分数在进度条里的占比；AI 维度满分 100，价值维度满分 5。超出时截断。 */
export function scorePercent(score: number | undefined, max: number): number {
  if (typeof score !== "number" || !Number.isFinite(score) || max <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((score / max) * 100)));
}

/** 权重归一化成百分比数字（0.2 与 20 等价）。 */
export function weightPercent(weight: number | undefined): number | null {
  if (typeof weight !== "number" || !Number.isFinite(weight)) return null;
  const value = weight <= 1 ? weight * 100 : weight;
  return Math.round(value);
}

export function dimensionLabel(dimension: DimensionLike, kind: "ai" | "value"): string {
  if (dimension.label && dimension.label.trim()) return dimension.label;
  const table = kind === "ai" ? aiDimensionLabels : valueDimensionLabels;
  return table[dimension.key] ?? dimension.key;
}

/* ============================================================
   列表筛选：URL 是唯一真相，和 WorkspaceFilters 并列而不侵入它
   （`workspace-filters.ts` 属于筛选的核心契约，生命周期筛选单独成组）。
   ============================================================ */

/** 复核池筛选只开放三个操作口径：待复核 / 低价值 / 已通过。 */
export const reviewStatusFilters = ["needs_review", "low_value", "approved"] as const;
export type ReviewStatusFilter = (typeof reviewStatusFilters)[number];

export const reviewStatusFilterLabels: Record<ReviewStatusFilter, string> = {
  needs_review: "待复核",
  low_value: "低价值",
  approved: "已通过",
};

export interface LifecycleFilters {
  aiStatus: ReviewStatusFilter | null;
  valueLevel: ValueLevel | null;
}

export const defaultLifecycleFilters: LifecycleFilters = {
  aiStatus: null,
  valueLevel: null,
};

export function isReviewStatusFilter(value: unknown): value is ReviewStatusFilter {
  return typeof value === "string" && (reviewStatusFilters as readonly string[]).includes(value);
}

type ParamSource = Record<string, string | string[] | undefined>;

function readParam(params: ParamSource, key: string): string {
  const raw = params[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() ?? "";
}

export function parseLifecycleFilters(params: ParamSource): LifecycleFilters {
  const aiRaw = readParam(params, "aiStatus");
  const levelRaw = readParam(params, "valueLevel");

  return {
    aiStatus: isReviewStatusFilter(aiRaw) ? aiRaw : null,
    valueLevel: isValueLevel(levelRaw) ? levelRaw : null,
  };
}

export function hasLifecycleFilters(filters: LifecycleFilters): boolean {
  return filters.aiStatus !== null || filters.valueLevel !== null;
}

/**
 * 把生命周期条件追加到已有的工作台链接上。
 * 传空值时主动删除参数，保证「清空筛选」后地址是干净的。
 */
export function withLifecycleParams(href: string, filters: LifecycleFilters): string {
  const [path, query = ""] = href.split("?");
  const params = new URLSearchParams(query);

  if (filters.aiStatus) params.set("aiStatus", filters.aiStatus);
  else params.delete("aiStatus");

  if (filters.valueLevel) params.set("valueLevel", filters.valueLevel);
  else params.delete("valueLevel");

  const next = params.toString();
  return next ? `${path}?${next}` : path;
}

/**
 * 服务端过滤：未打分的对象不会命中「待复核」，语义与规格一致；
 * 未评估的内库资产同样不会出现在任何等级里。
 */
export function filterByLifecycle<T extends BusinessObject>(
  objects: readonly T[],
  filters: LifecycleFilters,
): T[] {
  if (!hasLifecycleFilters(filters)) return [...objects];

  return objects.filter((object) => {
    if (object.type !== "asset") return false;
    if (filters.aiStatus && readAiStatus(object) !== filters.aiStatus) return false;
    if (filters.valueLevel && readValueLevel(object) !== filters.valueLevel) return false;
    return true;
  });
}

export interface LifecycleChip {
  key: string;
  label: string;
}

export function lifecycleChips(filters: LifecycleFilters): LifecycleChip[] {
  const chips: LifecycleChip[] = [];
  if (filters.aiStatus) {
    chips.push({ key: "aiStatus", label: reviewStatusFilterLabels[filters.aiStatus] });
  }
  if (filters.valueLevel) {
    chips.push({ key: "valueLevel", label: `${filters.valueLevel} 级` });
  }
  return chips;
}
