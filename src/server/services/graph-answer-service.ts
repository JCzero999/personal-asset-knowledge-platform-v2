import { DomainError } from "../../domain/errors";
import { testBaseUrl } from "../../lib/llm-settings";
import type { LlmConfig, LlmProvider } from "./llm-settings-service";

/**
 * 图谱问答的**生成**环节：LightRAG 只提供上下文，答案由用户在
 * 「设置 → 大模型」里绑定的模型生成（OpenAI 兼容 `/chat/completions`）。
 *
 * 边界：
 * - 密钥只出现在请求头里，不进响应、不进日志、不进错误文案；
 * - 上游错误体整体丢弃（可能回显请求头或内部信息），只按状态码给中文提示；
 * - 超时沿用配置里的 `timeoutMs`（默认 300 秒，本地 7B 模型也够）。
 */

export interface GraphAnswerRequest {
  question: string;
  /** LightRAG `only_need_context` 返回的检索上下文。 */
  context: string;
  /** 检索上下文本身是模型摘要（旧版 LightRAG 不支持 only_need_context 时的兜底）。 */
  contextIsSummary?: boolean;
}

export interface GraphAnswerResult {
  response: string;
  model: string;
  provider: LlmProvider;
}

export interface GraphAnswerDeps {
  fetchImpl?: typeof fetch;
}

export const GRAPH_ANSWER_SYSTEM_PROMPT = [
  "你是「个人资产与知识库平台」的问答助手，回答用户关于自己知识库内容的问题。",
  "",
  "规则：",
  "1. 只使用<上下文>里的信息回答，不要引入外部知识，不要推测。",
  "2. 用简体中文直接给结论；几句话能说清就不要展开成长文。",
  "3. 上下文不足以回答时，明确说「现有资料里没有足够的信息」，并指出缺什么。",
  "4. 不要编造出处、链接或文档名；不要输出 Markdown 标题。",
].join("\n");

/** 本地 7B 模型的上下文窗口小（ollama 默认 4k），云端模型可以放宽。 */
const OLLAMA_CONTEXT_CHARS = 4_000;
const CLOUD_CONTEXT_CHARS = 12_000;
const MAX_ANSWER_TOKENS = 800;

export function graphAnswerContextBudget(provider: LlmProvider): number {
  return provider === "ollama" ? OLLAMA_CONTEXT_CHARS : CLOUD_CONTEXT_CHARS;
}

function clipContext(context: string, budget: number): string {
  const text = context.trim();
  if (text.length <= budget) return text;
  return `${text.slice(0, budget)}\n…（上下文过长，已截断）`;
}

/**
 * 实际请求地址：Ollama 的 OpenAI 兼容层在 `/v1` 下，LightRAG 的
 * `LLM_BINDING_HOST` 写的是不带 `/v1` 的根地址（见 `testBaseUrl`）。
 */
export function chatCompletionsUrl(config: Pick<LlmConfig, "provider" | "baseUrl">): string {
  return `${testBaseUrl(config.provider, config.baseUrl)}/chat/completions`;
}

function timeoutSeconds(config: LlmConfig): number {
  return Math.round(config.timeoutMs / 1000);
}

/** 网络层失败的中文文案；原始 message 可能带地址，但不带密钥。 */
export function describeFetchFailure(error: unknown, config: LlmConfig): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return `模型服务 ${timeoutSeconds(config)} 秒内没有响应，请稍后重试，或到「设置 → 大模型」调整超时。`;
    }
    const cause = (error as Error & { cause?: { code?: string } }).cause;
    switch (cause?.code) {
      case "ECONNREFUSED":
        return "模型服务未响应（目标地址没有服务在监听），请到「设置 → 大模型」检查服务地址，或确认本机模型已启动。";
      case "ENOTFOUND":
      case "EAI_AGAIN":
        return "模型服务地址解析失败，请到「设置 → 大模型」检查服务地址。";
      case "CERT_HAS_EXPIRED":
      case "DEPTH_ZERO_SELF_SIGNED_CERT":
        return "模型服务的证书校验失败，请到「设置 → 大模型」检查服务地址。";
      default:
        break;
    }
  }
  return "模型服务未响应，请到「设置 → 大模型」检查服务地址与模型是否可用。";
}

/** HTTP 状态码的中文文案；不透传上游错误体。 */
export function describeStatusFailure(status: number): string {
  if (status === 401 || status === 403) {
    return "模型鉴权失败（API Key 无效或权限不足），请到「设置 → 大模型」更新密钥。";
  }
  if (status === 404) {
    return "模型接口地址不对（返回 404），请到「设置 → 大模型」检查服务地址是否带版本前缀（如 /v1）。";
  }
  if (status === 429) {
    return "模型服务限流或额度不足，请稍后重试。";
  }
  if (status === 400 || status === 422) {
    return "模型服务不接受这次请求（模型名可能不对），请到「设置 → 大模型」检查模型名。";
  }
  if (status >= 500) {
    return "模型服务内部错误，请稍后重试。";
  }
  return `模型服务返回 HTTP ${status}，请到「设置 → 大模型」检查配置。`;
}

export interface ChatCompletionBody {
  choices?: Array<{ message?: { content?: unknown } }>;
}

/** 用绑定模型生成答案；失败一律收敛成可行动的中文 `DomainError`。 */
export async function generateGraphAnswer(
  config: LlmConfig,
  request: GraphAnswerRequest,
  deps: GraphAnswerDeps = {},
): Promise<GraphAnswerResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const context = clipContext(request.context, graphAnswerContextBudget(config.provider));
  const contextLabel = request.contextIsSummary
    ? "（以下是对知识库检索结果的摘要）"
    : "（以下是从知识库检索到的上下文）";

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
          { role: "system", content: GRAPH_ANSWER_SYSTEM_PROMPT },
          {
            role: "user",
            content: `问题：${request.question}\n\n<上下文>${contextLabel}\n${context}\n</上下文>`,
          },
        ],
        temperature: 0.2,
        max_tokens: MAX_ANSWER_TOKENS,
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
  const answer = typeof content === "string" ? content.trim() : "";

  if (!answer) {
    throw new DomainError("INTERNAL", "模型没有返回内容，请稍后重试。");
  }

  return { response: answer, model: config.model, provider: config.provider };
}
