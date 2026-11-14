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

const EXTRACT_MAX_TOKENS = 4_096;
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
  "任务：从一篇作品正文里提炼 3–5 条可复用的知识资产（可独立理解、可迁移的知识单元）。",
  "",
  "规则：",
  "1. 只依据给定正文，不得编造正文里没有的事实、数据或出处。",
  "2. 每条必须是一个可独立理解的知识单元：至少包含一个完整判断或一组完整步骤；一句话碎片、只有名词短语的条目不得成条。",
  "3. 不为凑数拆分：同一知识点不要拆成多条，同类碎片合并成一条；正文确实不足以支撑 3 条时可以少于 3 条，但至少要提炼 1 条。",
  "4. title：动宾短语，不超过 30 字，不含序号（不要写「1.」「一、」）。",
  "5. summary：60–120 字，结论先行，说清「是什么 + 为什么重要」。",
  "6. scenario：不超过 40 字，说明适用场景。",
  "7. keyPoints：2–4 条，每条不超过 50 字，是可执行要点，不要堆叠原句。",
  "8. excerpt：100–300 字，必须逐字摘自正文的连续原文，不要改写、不要拼接，用于日后核对出处。",
  "9. tags：1–3 个，优先复用「已有标签」里的词；没有合适的再给新的短词。",
  "10. 与正文无关时返回空数组。",
  "",
  JSON_RULE,
  '输出格式：{"assets":[{"title":"...","summary":"...","scenario":"...","keyPoints":["..."],"excerpt":"...","tags":["..."]}]}',
].join("\n");

export function buildExtractUserPrompt(
  work: Pick<BusinessObject, "title" | "description">,
  content: string,
  availableTags: readonly string[] = [],
): string {
  const description = work.description?.trim();

  return [
    `作品标题：${work.title}`,
    description ? `作品说明：${description}` : "",
    availableTags.length > 0
      ? `已有标签（能复用就复用）：${availableTags.join("、")}`
      : "",
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
  /** 由 summary + scenario + keyPoints 拼成，写入 objects.description。 */
  description: string;
  summary: string;
  scenario: string;
  keyPoints: string[];
  /** 逐字摘自原文的 100–300 字段落，同时作为资产的正文快照。 */
  excerpt: string;
  tags: string[];
}

export interface ExtractDiscard {
  index: number;
  title: string;
  reason: string;
}

export interface ParseExtractOptions {
  /**
   * 作品正文：用于校验 excerpt 是否逐字摘自原文。
   * 缺省时跳过逐字校验（只给直接调用解析器的测试留口子）。
   */
  sourceText?: string;
  /** 丢弃条目的日志出口；默认 console.warn，测试可注入静默实现。 */
  onDiscard?: (info: ExtractDiscard) => void;
}

const MAX_EXTRACTED_ASSETS = 5;
const MAX_EXTRACTED_TITLE = 30;
const SUMMARY_MIN = 60;
const SUMMARY_MAX = 120;
const SCENARIO_MAX = 40;
const KEY_POINT_MIN = 2;
const KEY_POINT_MAX = 4;
const KEY_POINT_LENGTH = 50;
const EXCERPT_MIN = 100;
const EXCERPT_MAX = 300;
const DESCRIPTION_MAX = 500;
const TAG_MAX = 3;
const TAG_LENGTH = 20;

/** 按 Unicode 码点计数，避免 emoji / 生僻字把一个字符算成两个。 */
function charLength(value: string): number {
  return Array.from(value).length;
}

function takeChars(value: string, max: number): string {
  const chars = Array.from(value);

  return chars.length <= max ? value : chars.slice(0, max).join("");
}

/** 去掉模型爱加的序号：「1.」「1、」「(1)」「一、」「第 1 条」。 */
function stripLeadingNumbering(title: string): string {
  return title
    .replace(/^第[一二三四五六七八九十百\d]+[条点]\s*/, "")
    .replace(/^第[一二三四五六七八九十百\d]+\s*[、.．]\s*/, "")
    .replace(/^[(（]\s*\d{1,2}\s*[)）]\s*/, "")
    .replace(/^\d{1,2}\s*[.、．:：)）]\s*/, "")
    .replace(/^[一二三四五六七八九十]+\s*[、.．]\s*/, "")
    .trim();
}

/**
 * excerpt 校验：优先严格子串；模型偶尔把换行压成空格，退一步只忽略空白差异，
 * 其余字符必须完全一致——改写、拼接、跨段拼贴都会被丢弃。
 */
function isVerbatimExcerpt(excerpt: string, source: string): boolean {
  if (source.includes(excerpt)) return true;

  const squash = (value: string) => value.replace(/\s+/g, " ").trim();

  return squash(source).includes(squash(excerpt));
}

/**
 * 提炼结果收敛（规格 v2.1 §1）：字段不全、似碎片的条目直接丢弃并记日志；
 * 超长字段截断而不是让整批失败。
 */
export function parseExtractedAssets(
  text: string,
  options: ParseExtractOptions = {},
): ExtractedAsset[] {
  const payload = parseModelJson(text) as { assets?: unknown };
  const raw = Array.isArray(payload?.assets) ? payload.assets : [];
  const logDiscard =
    options.onDiscard ??
    ((info: ExtractDiscard) => {
      console.warn("[extract] 丢弃不合格条目", info);
    });

  const assets: ExtractedAsset[] = [];

  for (const [index, item] of raw.entries()) {
    if (assets.length >= MAX_EXTRACTED_ASSETS) break;

    const discard = (title: string, reason: string) => {
      logDiscard({ index, title, reason });
    };

    if (typeof item !== "object" || item === null) {
      discard("", "条目不是对象");
      continue;
    }

    const record = item as Record<string, unknown>;
    const title = stripLeadingNumbering(
      typeof record.title === "string" ? record.title.trim() : "",
    );

    if (!title) {
      discard("", "缺少标题");
      continue;
    }

    const summaryRaw = typeof record.summary === "string" ? record.summary.trim() : "";

    if (!summaryRaw) {
      discard(title, "缺少摘要");
      continue;
    }

    if (charLength(summaryRaw) < SUMMARY_MIN) {
      discard(title, `摘要不足 ${SUMMARY_MIN} 字，疑似碎片`);
      continue;
    }

    const summary = takeChars(summaryRaw, SUMMARY_MAX);
    const scenarioRaw = typeof record.scenario === "string" ? record.scenario.trim() : "";

    if (!scenarioRaw) {
      discard(title, "缺少适用场景");
      continue;
    }

    const scenario = takeChars(scenarioRaw, SCENARIO_MAX);

    const keyPoints = (Array.isArray(record.keyPoints) ? record.keyPoints : [])
      .filter((point): point is string => typeof point === "string")
      .map((point) => takeChars(point.trim(), KEY_POINT_LENGTH))
      .filter((point) => point.length > 0)
      .slice(0, KEY_POINT_MAX);

    if (keyPoints.length < KEY_POINT_MIN) {
      discard(title, `要点不足 ${KEY_POINT_MIN} 条`);
      continue;
    }

    const excerptRaw = typeof record.excerpt === "string" ? record.excerpt.trim() : "";

    if (!excerptRaw) {
      discard(title, "缺少原文摘录");
      continue;
    }

    const excerpt = takeChars(excerptRaw, EXCERPT_MAX);

    if (charLength(excerpt) < EXCERPT_MIN) {
      discard(title, `原文摘录不足 ${EXCERPT_MIN} 字`);
      continue;
    }

    if (options.sourceText && !isVerbatimExcerpt(excerpt, options.sourceText)) {
      discard(title, "原文摘录不是正文的逐字片段");
      continue;
    }

    const tags = [
      ...new Set(
        (Array.isArray(record.tags) ? record.tags : [])
          .filter((tag): tag is string => typeof tag === "string")
          .map((tag) => takeChars(tag.trim(), TAG_LENGTH))
          .filter((tag) => tag.length > 0),
      ),
    ].slice(0, TAG_MAX);

    // 标签不是知识单元的一部分：宁可空着让用户后补，也不因此丢掉内容。

    assets.push({
      title: takeChars(title, MAX_EXTRACTED_TITLE),
      description: takeChars(
        `${summary}｜适用场景：${scenario}｜要点：${keyPoints.join("；")}`,
        DESCRIPTION_MAX,
      ),
      summary,
      scenario,
      keyPoints,
      excerpt,
      tags,
    });
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
  options: { availableTags?: readonly string[] } = {},
): Promise<ExtractedAsset[]> {
  const ai = createAssetAi(db, deps);
  requireConfigured(ai);

  const text = await ai.complete({
    system: EXTRACT_SYSTEM_PROMPT,
    user: buildExtractUserPrompt(work, content, options.availableTags ?? []),
    maxTokens: EXTRACT_MAX_TOKENS,
    temperature: 0.3,
  });

  return parseExtractedAssets(text, { sourceText: content });
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
