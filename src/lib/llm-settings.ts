/**
 * 「系统 → 大模型」页面的共享口径（ADR-025 / 19_DESIGN_LLM_PREVIEW §2）。
 *
 * 只放纯函数与常量：供应商预设、前端校验、秒 ↔ 毫秒换算。
 * 权限与密钥校验的最终裁决在服务端（`src/server/services/llm-settings-service.ts`），
 * 这里的校验只负责「在用户按下保存之前把明显错误说出来」，两边文案保持一致。
 */

export const llmProviders = ["openai", "deepseek", "qwen", "ollama", "custom"] as const;

export type LlmProvider = (typeof llmProviders)[number];

export const llmProviderLabels: Record<LlmProvider, string> = {
  openai: "OpenAI",
  deepseek: "DeepSeek",
  qwen: "通义千问",
  ollama: "本机 Ollama",
  custom: "自定义",
};

/** 服务端视图，字段与 `LlmSettingsView` 对齐；永远不含明文密钥。 */
export interface LlmSettingsView {
  provider: LlmProvider;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  hasKey: boolean;
  keyMasked: string | null;
  appliedToLightrag: boolean;
  updatedAt: string | null;
}

export interface LlmTestResult {
  ok: boolean;
  latencyMs: number;
  status: number | null;
  error?: string;
}

export interface LlmApplyResult {
  applied: boolean;
  restarted: boolean;
  backup: string;
  healthLatencyMs: number | null;
  updatedAt: string | null;
}

export interface LlmPreset {
  id: LlmProvider;
  name: string;
  hint: string;
  baseUrl: string;
  model: string;
  /** 本机 Ollama 可以不填密钥。 */
  keyRequired: boolean;
}

/** 预设顺序即页面顺序：常用的外部服务在前，本机在后。 */
export const llmPresets: readonly LlmPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    hint: "标准 OpenAI 接口",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    keyRequired: true,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    hint: "国内直连，延迟低",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    keyRequired: true,
  },
  {
    id: "qwen",
    name: "通义千问",
    hint: "走兼容模式地址",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    keyRequired: true,
  },
  {
    id: "custom",
    name: "自定义",
    hint: "填服务商兼容地址",
    baseUrl: "",
    model: "",
    keyRequired: true,
  },
  {
    id: "ollama",
    name: "本机 Ollama",
    hint: "免费但慢，约 7 字/秒",
    // 与 infra/lightrag/.env 的 LLM_BINDING_HOST 一致，不带 /v1；
    // 测试连接时再补兼容前缀（见 `testBaseUrl`）。
    baseUrl: "http://127.0.0.1:11434",
    model: "deepseek-r1:7b",
    keyRequired: false,
  },
];

/** 服务端 `LLM_TIMEOUT_MIN_MS / MAX_MS` 的秒数表达。 */
export const LLM_TIMEOUT_MIN_SECONDS = 30;
export const LLM_TIMEOUT_MAX_SECONDS = 1800;
export const DEFAULT_TIMEOUT_SECONDS = 300;
export const API_KEY_MAX_LENGTH = 512;
export const MODEL_MAX_LENGTH = 120;

export function providerLabel(provider: LlmProvider): string {
  return llmProviderLabels[provider] ?? provider;
}

export function presetFor(provider: LlmProvider): LlmPreset | null {
  return llmPresets.find((preset) => preset.id === provider) ?? null;
}

export function presetKeyRequired(provider: LlmProvider): boolean {
  return presetFor(provider)?.keyRequired ?? true;
}

export function timeoutSecondsFromMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return DEFAULT_TIMEOUT_SECONDS;
  return Math.round(timeoutMs / 1000);
}

export function timeoutMsFromSeconds(seconds: number): number {
  return Math.round(seconds * 1000);
}

/** 本机地址：与后端 `isLocalHost` 同一份判断。 */
function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/**
 * 服务地址校验：返回错误文案，通过则返回 null。
 * 规则与后端 `normalizeBaseUrl` 一致——远程必须 https，本机允许 http。
 */
export function validateBaseUrl(value: string): string | null {
  const raw = value.trim();
  if (!raw) return "请填写服务地址";

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "这不是一个合法地址，例如 https://api.deepseek.com/v1";
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "只支持 https；本机地址可以用 http";
  }
  if (url.protocol === "http:" && !isLocalHostname(url.hostname)) {
    return "远程地址必须用 https，http 只允许本机";
  }
  if (url.username || url.password) {
    return "地址里不要带账号密码，密钥填在下方的 API Key";
  }
  if (url.search || url.hash) {
    return "地址不要带查询参数或锚点";
  }

  return null;
}

export function validateModel(value: string): string | null {
  const model = value.trim();
  if (!model) return "请填写模型名";
  if (model.length > MODEL_MAX_LENGTH) return `模型名不能超过 ${MODEL_MAX_LENGTH} 个字符`;
  if (/\s/.test(model)) return "模型名里不能有空格";
  if (/[\u0000-\u001f\u007f]/.test(model)) return "模型名不能包含控制字符";
  return null;
}

export function validateTimeoutSeconds(value: string): string | null {
  const seconds = Number(value.trim());
  if (!value.trim() || !Number.isInteger(seconds)) return "填一个整数秒数";
  if (seconds < LLM_TIMEOUT_MIN_SECONDS || seconds > LLM_TIMEOUT_MAX_SECONDS) {
    return `超时需在 ${LLM_TIMEOUT_MIN_SECONDS}–${LLM_TIMEOUT_MAX_SECONDS} 秒之间`;
  }
  return null;
}

export function validateApiKey(value: string, provider: LlmProvider): string | null {
  if (!presetKeyRequired(provider)) return null;
  if (!value.trim()) return "请填写 API Key";
  if (value.trim().length > API_KEY_MAX_LENGTH) {
    return `API Key 不能超过 ${API_KEY_MAX_LENGTH} 个字符`;
  }
  return null;
}

/**
 * 连接测试实际使用的地址：Ollama 的 OpenAI 兼容层在 `/v1` 下，
 * 而 LightRAG 的 `LLM_BINDING_HOST` 写的是不带 `/v1` 的根地址。
 * 只影响测试请求，不改保存值。
 */
export function testBaseUrl(provider: LlmProvider, baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (provider !== "ollama") return trimmed;
  if (/\/v\d+$/.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}

/** 应用失败时服务端把回滚结果放在 `details` 里，这里取出来给页面用。 */
export interface LlmApplyFailureDetails {
  rolledBack?: boolean;
  reason?: string;
  backup?: string;
}
