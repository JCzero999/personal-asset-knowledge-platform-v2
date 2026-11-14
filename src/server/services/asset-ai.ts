import type { BusinessObject } from "../../domain/objects";
import { DomainError } from "../../domain/errors";
import {
  AI_DIMENSION_MAX,
  AI_DIMENSION_MIN,
  AI_DIMENSIONS,
  VALUE_DIMENSIONS,
  VALUE_SCORE_MAX,
  VALUE_SCORE_MIN,
  buildAiScoreDetail,
  buildValueScores,
  fallbackValueScores,
  isAiDimensionKey,
  isValueDimensionKey,
  type AiDimensionKey,
  type AiScoreDetail,
  type ValueDimensionKey,
  type ValueScores,
} from "../../domain/value";
import type { AppDatabase } from "../db/client";
import {
  chatCompletionsUrl,
  describeFetchFailure,
  describeStatusFailure,
  type ChatCompletionBody,
} from "./graph-answer-service";
import { resolveLlmConfigWithSource, type LlmConfig } from "./llm-settings-service";

/**
 * AI 提炼 / 打分 / 价值评估的**调用层**（规格 v2.0 第 5–7 节）。
 *
 * 边界（与 `graph-answer-service` 一致）：
 * - 密钥只进 `Authorization` 头，不进响应、日志与错误文案；
 * - 上游错误体整体丢弃，只按状态码给中文提示；
 * - 模型只负责「给分 + 理由」，加权、阈值、分级一律由 `domain/value.ts` 计算，
 *   模型自报的总分直接忽略，保证历史分数可比；
 * - 模型不可用/返回脏数据时，`evaluateValueScores` 可以退回确定性兜底，
 *   而提炼与打分没有兜底——它们的结果会直接决定资产去留，编不出来就是失败。
 */

const EXTRACT_MAX_TOKENS = 1_600;
const SCORE_MAX_TOKENS = 900;
const VALUE_MAX_TOKENS = 900;

const NOT_CONFIGURED_MESSAGE =
  "尚未绑定大模型，请到「设置 → 大模型」完成配置后再试。";

/* -------------------------------------------------------------------------- */
/* 依赖与调用                                                                  */
/* -------------------------------------------------------------------------- */

export interface AiChatRequest {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
  model: string;
}

/** 测试注入用的最小补全函数。 */
export type AiChatFn = (request: AiChatRequest) => Promise<string>;

export interface AssetAiDeps {
  fetchImpl?: typeof fetch;
  envPath?: string;
  env?: Record<string, string | undefined>;
  secret?: string;
  /** 注入后视为「已绑定模型」，不再解析配置、不发真实请求。 */
  chat?: AiChatFn;
  /** 注入时写进明细的模型名。 */
  model?: string;
}

export interface AssetAi {
  /** false = 从未配置过模型（内置默认值），调用方应直接走兜底或报可行动错误。 */
  configured: boolean;
  model: string;
  complete(request: {
    system: string;
    user: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<string>;
}

async function callChatCompletion(
  config: LlmConfig,
  request: { system: string; user: string; maxTokens: number; temperature: number },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let response: Response;

  try {
    response = await fetchImpl(chatCompletionsUrl(config), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    throw new DomainError("INTERNAL", describeFetchFailure(error, config));
  }

  if (!response.ok) {
    // 上游错误体可能回显请求头（含密钥）：读完丢弃，只按状态码给文案。
    await response.text().catch(() => "");
    throw new DomainError("INTERNAL", describeStatusFailure(response.status));
  }

  const body = (await response.json().catch(() => null)) as ChatCompletionBody | null;
  const content = body?.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content.trim() : "";

  if (!text) {
    throw new DomainError("INTERNAL", "模型没有返回内容，请稍后重试。");
  }

  return text;
}

export function createAssetAi(db: AppDatabase, deps: AssetAiDeps = {}): AssetAi {
  if (deps.chat) {
    const chat = deps.chat;
    const model = deps.model ?? "injected";

    return {
      configured: true,
      model,
      complete: (request) =>
        chat({
          ...request,
          maxTokens: request.maxTokens ?? SCORE_MAX_TOKENS,
          temperature: request.temperature ?? 0.2,
          model,
        }),
    };
  }

  const { config, source } = resolveLlmConfigWithSource(db, deps);

  return {
    // 从未配置过（既没有库内设置，也没有 .env）时不发请求：
    // 发出去只会连到内置默认地址，得到一句与真实原因无关的连接错误。
    configured: source !== "default",
    model: config.model,
    complete: (request) =>
      callChatCompletion(
        config,
        {
          system: request.system,
          user: request.user,
          maxTokens: request.maxTokens ?? SCORE_MAX_TOKENS,
          temperature: request.temperature ?? 0.2,
        },
        deps.fetchImpl,
      ),
  };
}

function requireConfigured(ai: AssetAi): void {
  if (!ai.configured) {
    throw new DomainError("INTERNAL", NOT_CONFIGURED_MESSAGE);
  }
}

/* -------------------------------------------------------------------------- */
/* 提示词                                                                      */
/* -------------------------------------------------------------------------- */

const JSON_RULE = "只输出一个 JSON 对象，不要输出 Markdown 代码块、解释或前后缀。";

export const EXTRACT_SYSTEM_PROMPT = [
  "你是「个人知识与资产平台」的内容提炼助手。",
  "任务：从一篇作品正文里提炼出可以复用的知识资产（可复利、可迁移的知识单元）。",
  "",
  "规则：",
  "1. 只依据给定正文，不要编造正文里没有的事实、数据或出处。",
  "2. 每篇作品提炼 1–5 个资产；正文信息量不足时宁可少提炼。",
  "3. 资产标题是名词性短语，20 字以内；描述写「是什么 + 为什么有用 + 怎么用」，200 字以内。",
  "4. tags 用正文里已有的关键概念，2–5 个，短词优先。",
  "5. 与正文无关时返回空数组。",
  "",
  JSON_RULE,
  '输出格式：{"assets":[{"title":"...","description":"...","tags":["..."]}]}',
].join("\n");

export function buildExtractUserPrompt(
  work: Pick<BusinessObject, "title" | "description">,
  content: string,
): string {
  const description = work.description?.trim();

  return [
    `作品标题：${work.title}`,
    description ? `作品说明：${description}` : "",
    "",
    "<正文>",
    content,
    "</正文>",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export const SCORE_SYSTEM_PROMPT = [
  "你是「个人知识与资产平台」的资产评审员，负责判断一条外库资产是否值得沉淀进内库。",
  "",
  "按六个维度各自打 0–100 分（整数），并给出一句不超过 40 字的中文理由：",
  ...AI_DIMENSIONS.map(
    (dimension) => `- ${dimension.key}（${dimension.label}，权重 ${dimension.weight}%）：${dimensionHint(dimension.key)}`,
  ),
  "",
  "打分要严格：没有具体方法、只有常识复述的内容，insight 与 actionability 不应超过 50 分。",
  `不要自己计算总分，也不要给等级。${JSON_RULE}`,
  '输出格式：{"dimensions":[{"key":"completeness","score":80,"reason":"..."}]}',
].join("\n");

function dimensionHint(key: AiDimensionKey): string {
  switch (key) {
    case "completeness":
      return "是否有清晰的问题-方法-结论结构，关键步骤是否完整";
    case "insight":
      return "是否只是常识复述，是否具备个人视角、反直觉洞察或因果分析";
    case "actionability":
      return "是否包含具体步骤、检查清单、判断标准或可执行案例";
    case "relevance":
      return "与内库已有资产是补充、升级还是重复";
    case "timeliness":
      return "是否强依赖当下热点或工具版本，底层逻辑是否稳定";
    case "credibility":
      return "来源质量、是否有数据支撑、是否已有实践痕迹";
  }
}

export function buildScoreUserPrompt(
  asset: Pick<BusinessObject, "title" | "description" | "tags" | "source" | "sourceType" | "origin">,
  internalTitles: readonly string[],
): string {
  return [
    `资产标题：${asset.title}`,
    asset.description ? `资产内容：${asset.description}` : "资产内容：（无正文，仅有标题）",
    asset.tags.length > 0 ? `标签：${asset.tags.join("、")}` : "",
    `来源：${sourceLabel(asset.source, asset.sourceType, asset.origin)}`,
    "",
    internalTitles.length > 0
      ? `<已有内库资产>（用于判断关联与互补）\n${internalTitles.map((title) => `- ${title}`).join("\n")}\n</已有内库资产>`
      : "（内库目前没有资产，relevance 按「潜在可连接的知识领域」判断）",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function sourceLabel(
  source: BusinessObject["source"],
  sourceType: BusinessObject["sourceType"],
  origin: BusinessObject["origin"],
): string {
  const sourceText = source === "ai_extracted" ? "AI 提炼" : "手写";
  const typeText =
    sourceType === "practiced_work"
      ? "实践沉淀"
      : sourceType === "ai_extract"
        ? "AI 提炼"
        : "外部直接录入";
  const originText = origin === "imported" ? "导入" : "自建";

  return `${sourceText} / ${typeText} / ${originText}`;
}

export const VALUE_SYSTEM_PROMPT = [
  "你是「个人知识与资产平台」的价值评估员，为已进入内库的资产做 5 维价值评估。",
  "",
  "每个维度打 1–5 分（整数），并给出一句不超过 40 字的中文理由：",
  ...VALUE_DIMENSIONS.map(
    (dimension) =>
      `- ${dimension.key}（${dimension.label}）：${dimension.question}。1 分 = 最低，3 分 = 中等，5 分 = 最高`,
  ),
  "",
  `不要自己算总分，也不要给 S/A/B/C 等级。${JSON_RULE}`,
  '输出格式：{"dimensions":[{"key":"practice","score":3,"reason":"..."}]}',
].join("\n");

export function buildValueUserPrompt(
  asset: Pick<BusinessObject, "title" | "description" | "tags" | "useCount" | "lastUsedAt">,
): string {
  return [
    `资产标题：${asset.title}`,
    asset.description ? `资产内容：${asset.description}` : "资产内容：（无正文，仅有标题）",
    asset.tags.length > 0 ? `标签：${asset.tags.join("、")}` : "",
    `累计调用次数：${asset.useCount}${asset.lastUsedAt ? `，最近一次 ${asset.lastUsedAt}` : ""}`,
    "",
    "调用次数与最近使用时间是复用频率的客观信号，请结合内容本身判断。",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/* -------------------------------------------------------------------------- */
/* 解析                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 模型偶尔会包一层 ```json 或加一句「好的，以下是」。只取第一个 `{` 到最后一个
 * `}`：比正则宽容，也不会把正文里的花括号当成结构。
 */
export function parseModelJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start < 0 || end <= start) {
    throw new DomainError("INTERNAL", "模型没有返回可解析的 JSON，请稍后重试。");
  }

  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    throw new DomainError("INTERNAL", "模型返回的 JSON 无法解析，请稍后重试。");
  }
}

export interface ExtractedAsset {
  title: string;
  description: string;
  tags: string[];
}

const MAX_EXTRACTED_ASSETS = 5;
const MAX_EXTRACTED_TITLE = 200;
const MAX_EXTRACTED_DESCRIPTION = 5_000;

/** 提炼结果收敛：字段缺失即丢弃该项，标题/描述超长直接截断（不因模型啰嗦整体失败）。 */
export function parseExtractedAssets(text: string): ExtractedAsset[] {
  const payload = parseModelJson(text) as { assets?: unknown };
  const raw = Array.isArray(payload?.assets) ? payload.assets : [];

  const assets: ExtractedAsset[] = [];

  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;

    const record = item as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim() : "";

    if (!title) continue;

    const description =
      typeof record.description === "string" ? record.description.trim() : "";

    assets.push({
      title: title.slice(0, MAX_EXTRACTED_TITLE),
      description: description.slice(0, MAX_EXTRACTED_DESCRIPTION),
      tags: Array.isArray(record.tags)
        ? record.tags
            .filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
            .map((tag) => tag.trim())
            .slice(0, 8)
        : [],
    });

    if (assets.length >= MAX_EXTRACTED_ASSETS) break;
  }

  return assets;
}

interface ParsedDimensions {
  scores: Record<string, number>;
  reasons: Record<string, string>;
}

/**
 * 兼容两种模型输出：`dimensions` 数组（提示词要求的形状）或
 * `{ completeness: 80, ... }` 平铺对象。键名必须是已知维度。
 */
function parseDimensionList(text: string, allowed: readonly string[]): ParsedDimensions {
  const payload = parseModelJson(text) as Record<string, unknown>;
  const scores: Record<string, number> = {};
  const reasons: Record<string, string> = {};

  const list = Array.isArray(payload?.dimensions) ? payload.dimensions : null;

  if (list) {
    for (const item of list) {
      if (typeof item !== "object" || item === null) continue;

      const record = item as Record<string, unknown>;
      const key = record.key;

      if (typeof key !== "string" || !allowed.includes(key)) continue;
      if (typeof record.score !== "number" || !Number.isFinite(record.score)) continue;

      scores[key] = record.score;
      reasons[key] =
        typeof record.reason === "string" ? record.reason.trim().slice(0, 200) : "";
    }
  } else {
    for (const key of allowed) {
      const value = payload?.[key];

      if (typeof value === "number" && Number.isFinite(value)) {
        scores[key] = value;
      }
    }
  }

  const missing = allowed.filter((key) => scores[key] === undefined);

  if (missing.length > 0) {
    throw new DomainError("INTERNAL", `模型返回的打分缺少维度：${missing.join("、")}`, {
      missing,
    });
  }

  return { scores, reasons };
}

function assertRange(scores: Record<string, number>, min: number, max: number): void {
  for (const [key, value] of Object.entries(scores)) {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new DomainError("INTERNAL", `模型返回的分数超出 ${min}–${max}：${key}=${value}`, {
        key,
        value,
      });
    }
  }
}

/** 6 维打分：只取模型给的分数与理由，总分/判定由领域层计算。 */
export function parseAiScoreDetail(
  text: string,
  model: string,
  scoredAt: string,
): AiScoreDetail {
  const { scores, reasons } = parseDimensionList(text, AI_DIMENSIONS.map((item) => item.key));

  assertRange(scores, AI_DIMENSION_MIN, AI_DIMENSION_MAX);

  const typed: Record<AiDimensionKey, number> = {} as Record<AiDimensionKey, number>;

  for (const dimension of AI_DIMENSIONS) {
    if (!isAiDimensionKey(dimension.key)) continue;
    typed[dimension.key] = scores[dimension.key];
  }

  return buildAiScoreDetail({
    scores: typed,
    reasons: reasons as Partial<Record<AiDimensionKey, string>>,
    model,
    scoredAt,
  });
}

/** 5 维评估：1–5 分，等级由领域层按总分换算。 */
export function parseValueScores(
  text: string,
  model: string,
  assessedAt: string,
): ValueScores {
  const { scores, reasons } = parseDimensionList(text, VALUE_DIMENSIONS.map((item) => item.key));

  assertRange(scores, VALUE_SCORE_MIN, VALUE_SCORE_MAX);

  const typed: Record<ValueDimensionKey, number> = {} as Record<ValueDimensionKey, number>;

  for (const dimension of VALUE_DIMENSIONS) {
    if (!isValueDimensionKey(dimension.key)) continue;
    typed[dimension.key] = scores[dimension.key];
  }

  return buildValueScores({
    scores: typed,
    reasons: reasons as Partial<Record<ValueDimensionKey, string>>,
    model,
    assessedAt,
    source: "model",
  });
}

/* -------------------------------------------------------------------------- */
/* 对外动作                                                                    */
/* -------------------------------------------------------------------------- */

/** 从作品正文提炼资产候选（不做去重，去重由服务层按标题判定）。 */
export async function extractAssetCandidates(
  db: AppDatabase,
  work: Pick<BusinessObject, "title" | "description">,
  content: string,
  deps: AssetAiDeps = {},
): Promise<ExtractedAsset[]> {
  const ai = createAssetAi(db, deps);
  requireConfigured(ai);

  const text = await ai.complete({
    system: EXTRACT_SYSTEM_PROMPT,
    user: buildExtractUserPrompt(work, content),
    maxTokens: EXTRACT_MAX_TOKENS,
    temperature: 0.3,
  });

  return parseExtractedAssets(text);
}

/** 6 维打分；模型失败直接抛错（调用方不该静默放过一条未评的资产）。 */
export async function scoreAssetByModel(
  db: AppDatabase,
  asset: BusinessObject,
  internalTitles: readonly string[],
  deps: AssetAiDeps = {},
  now: string = new Date().toISOString(),
): Promise<AiScoreDetail> {
  const ai = createAssetAi(db, deps);
  requireConfigured(ai);

  const text = await ai.complete({
    system: SCORE_SYSTEM_PROMPT,
    user: buildScoreUserPrompt(asset, internalTitles),
    maxTokens: SCORE_MAX_TOKENS,
    temperature: 0.2,
  });

  return parseAiScoreDetail(text, ai.model, now);
}

/**
 * 5 维价值评估。
 *
 * `fallbackOnError` 决定模型不可用 / 返回脏数据时的行为：
 * - true：返回确定性兜底（C 级，source = fallback），结算与自动沉淀因此永不失败；
 * - false：原样抛错（用户主动点「重评」时，静默降级会把好资产判成 C）。
 */
export async function evaluateValueScores(
  db: AppDatabase,
  asset: Pick<BusinessObject, "title" | "description" | "tags"> &
    Partial<Pick<BusinessObject, "useCount" | "lastUsedAt">>,
  deps: AssetAiDeps = {},
  options: { now?: string; fallbackOnError: boolean } = { fallbackOnError: false },
): Promise<ValueScores> {
  const at = options.now ?? new Date().toISOString();
  const ai = createAssetAi(db, deps);

  if (!ai.configured) {
    if (options.fallbackOnError) return fallbackValueScores(at);
    throw new DomainError("INTERNAL", NOT_CONFIGURED_MESSAGE);
  }

  try {
    const text = await ai.complete({
      system: VALUE_SYSTEM_PROMPT,
      user: buildValueUserPrompt({
        title: asset.title,
        description: asset.description,
        tags: asset.tags,
        useCount: asset.useCount ?? 0,
        lastUsedAt: asset.lastUsedAt ?? null,
      }),
      maxTokens: VALUE_MAX_TOKENS,
      temperature: 0.2,
    });

    return parseValueScores(text, ai.model, at);
  } catch (error) {
    if (options.fallbackOnError) return fallbackValueScores(at);
    throw error;
  }
}
