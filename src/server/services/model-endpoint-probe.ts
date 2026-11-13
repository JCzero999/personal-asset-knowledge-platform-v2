/**
 * 模型端点探测（图谱失败诊断的取证旁路）。
 *
 * 为什么存在：LightRAG 的 `role_ollama_complete` 会把底层异常吞掉，`doc_status.error_msg`
 * 经常只剩 `C[1/29]: doc-…-chunk-000: ` 这样的空尾巴，页面只能写「未返回原因」。
 * 与其猜，不如按当前生效的大模型配置直接探一次供应商端点，把
 * 「服务根本没在跑 / 鉴权失败 / 地址不对 / 超时」这些可判定的结论翻成人话。
 *
 * 边界（ADR-025 只读侧）：
 * - 只 import `llm-settings-service` 的读取能力：不改配置、不写 .env、不重启引擎；
 * - 密钥只进请求头，绝不进 URL / message / 缓存键（缓存键用摘要）；
 * - 默认 3 秒超时、30 秒内存缓存，翻页与刷新不会反复打供应商接口；
 * - 任何异常都收敛成 `ok: false` + 中文 message，调用方不会因此 500。
 */

import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";

import type { AppDatabase } from "../db/client";
import { settings } from "../db/schema";
import { decryptSecret, resolveSettingsSecret } from "../security/secret-box";
import {
  DEFAULT_LLM_CONFIG,
  SETTINGS_LLM_KEY,
  configFromEnvValues,
  defaultLightragEnvPath,
  normalizeLlmConfig,
  readEnvConfig,
  type LlmConfig,
} from "./llm-settings-service";

/** 单次探测的上限；供应商接口正常情况下远快于此。 */
export const MODEL_PROBE_TIMEOUT_MS = 3_000;
/** 结论缓存时长：同一配置 30 秒内复用，避免刷新风暴。 */
export const MODEL_PROBE_TTL_MS = 30_000;

/** 探测只需要这三项；`timeoutMs` 是引擎的抽取超时，不用于探测。 */
export interface ModelProbeConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
}

/** 探测只关心状态码，不读响应体；真实 `fetch` 的 Response 结构上满足它。 */
export interface ModelProbeResponse {
  status: number;
  ok?: boolean;
}

export type ModelProbeFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal },
) => Promise<ModelProbeResponse>;

export interface ModelDiagnosis {
  /** 探测完成时间（ISO 8601）。缓存命中时保留首次探测的时间。 */
  checkedAt: string;
  /** true 端点可达；false 不可达或用不了；null 拿不到可探测的地址。 */
  ok: boolean | null;
  latencyMs: number;
  /** 中文、可直接给人看，并写明下一步。 */
  message: string;
}

interface ModelProbeCacheEntry {
  at: number;
  diagnosis: ModelDiagnosis;
}

export interface ModelProbeCache {
  get(key: string): ModelProbeCacheEntry | undefined;
  set(key: string, entry: ModelProbeCacheEntry): void;
}

export function createModelProbeCache(): ModelProbeCache {
  const store = new Map<string, ModelProbeCacheEntry>();
  return {
    get: (key) => store.get(key),
    set: (key, entry) => {
      store.set(key, entry);
    },
  };
}

/** 进程级默认缓存：status 接口每次请求新建实例就失去意义，所以放在模块级。 */
const defaultCache = createModelProbeCache();

export interface ModelProbeOptions {
  /** 跳过配置解析（测试 / 调用方已知道端点时）。 */
  config?: ModelProbeConfig;
  fetch?: ModelProbeFetch;
  timeoutMs?: number;
  now?: () => number;
  /** `null` 关闭缓存；不传用进程级 30 秒缓存。 */
  cache?: ModelProbeCache | null;
  envPath?: string;
  env?: Record<string, string | undefined>;
  secret?: string;
}

export interface ModelProbeConfigDeps {
  envPath?: string;
  env?: Record<string, string | undefined>;
  secret?: string;
}

function readStoredConfig(db: AppDatabase, secret?: string): LlmConfig | null {
  const row = db.select().from(settings).where(eq(settings.key, SETTINGS_LLM_KEY)).get();
  if (!row) return null;

  const key = secret?.trim() || resolveSettingsSecret();
  if (!key) return null;

  const parsed = JSON.parse(decryptSecret(row.valueEncrypted, key)) as unknown;
  if (typeof parsed !== "object" || parsed === null) return null;
  return normalizeLlmConfig(parsed, DEFAULT_LLM_CONFIG);
}

/**
 * 当前生效配置：库内 → `process.env` 的 LLM_* → `infra/lightrag/.env` → 内置默认。
 *
 * 与页面显示同源（`getLlmSettings` 的优先级），但这里需要明文 Key 才能探测云端端点，
 * 所以走同一条读取链路而不是掩码视图；任何一步失败都继续往下退。
 */
export function resolveModelProbeConfig(
  db: AppDatabase | null,
  deps: ModelProbeConfigDeps = {},
): ModelProbeConfig {
  if (db) {
    try {
      const stored = readStoredConfig(db, deps.secret);
      if (stored) {
        return { provider: stored.provider, baseUrl: stored.baseUrl, apiKey: stored.apiKey };
      }
    } catch {
      // 未配置 SETTINGS_ENC_KEY / 行内容损坏：退回环境，不让诊断跟着 500。
    }
  }

  const env = deps.env ?? process.env;
  if ((env.LLM_BINDING ?? "").trim() || (env.LLM_BINDING_HOST ?? "").trim()) {
    const fromEnv = configFromEnvValues({
      LLM_BINDING: env.LLM_BINDING ?? "",
      LLM_BINDING_HOST: env.LLM_BINDING_HOST ?? "",
      LLM_MODEL: env.LLM_MODEL ?? "",
      LLM_BINDING_API_KEY: env.LLM_BINDING_API_KEY ?? "",
      LLM_TIMEOUT: env.LLM_TIMEOUT ?? "",
    });
    return { provider: fromEnv.provider, baseUrl: fromEnv.baseUrl, apiKey: fromEnv.apiKey };
  }

  try {
    const fileConfig = readEnvConfig(deps.envPath ?? defaultLightragEnvPath(env));
    if (fileConfig) {
      return {
        provider: fileConfig.provider,
        baseUrl: fileConfig.baseUrl,
        apiKey: fileConfig.apiKey,
      };
    }
  } catch {
    // 文件不可读（打包环境没有 infra/）：用内置默认。
  }

  return {
    provider: DEFAULT_LLM_CONFIG.provider,
    baseUrl: DEFAULT_LLM_CONFIG.baseUrl,
    apiKey: DEFAULT_LLM_CONFIG.apiKey,
  };
}

function trimBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/** 只给 message 用：`URL.host` 天然不含 `user:pass@`。 */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

function isOllama(config: ModelProbeConfig): boolean {
  return config.provider.trim().toLowerCase() === "ollama";
}

function probeRequest(config: ModelProbeConfig): { url: string; headers: Record<string, string> } {
  const base = trimBaseUrl(config.baseUrl);
  if (isOllama(config)) {
    // Ollama 原生清单接口；Key 对它没有意义。
    return { url: `${base}/api/tags`, headers: { accept: "application/json" } };
  }

  const headers: Record<string, string> = { accept: "application/json" };
  const key = config.apiKey.trim();
  // Ollama 的 OpenAI 兼容模式接受任意 Key（常见占位值就是 "ollama"），不必带。
  if (key && key !== "ollama") {
    headers.authorization = `Bearer ${key}`;
  }
  return { url: `${base}/models`, headers };
}

/** 只取错误码 / 名称：不把 error.message 拼进文案，避免把 URL 或凭据带出去。 */
function errorCodeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string" && direct) return direct;
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause === "object" && cause !== null) {
    const nested = (cause as { code?: unknown }).code;
    if (typeof nested === "string" && nested) return nested;
  }
  return null;
}

function errorNameOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && name) return name;
  }
  return "";
}

function timeoutMessage(timeoutMs: number, url: string): string {
  const host = hostOf(url);
  const where = host ? `（${host}）` : "";
  return `探测超时：${Math.round(timeoutMs / 1000)} 秒内模型服务没有响应${where}。可能服务过载或网络不通，稍后再试，或到「系统 → 大模型」调整配置。`;
}

function failureMessage(
  error: unknown,
  timeoutMs: number,
  url: string,
): string {
  const name = errorNameOf(error);
  if (name === "TimeoutError" || name === "AbortError") {
    return timeoutMessage(timeoutMs, url);
  }

  const code = errorCodeOf(error);
  const host = hostOf(url) ?? "模型服务地址";

  switch (code) {
    case "ECONNREFUSED":
      return `模型服务不可达：连接被拒绝（${host}）。本机 Ollama 请确认已启动（ollama serve）；云端请检查 baseUrl 与端口。`;
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `模型服务域名解析失败（${host}）：请检查 baseUrl 是否写对、网络是否可用。`;
    case "ECONNRESET":
    case "EPIPE":
      return `模型服务连接被重置（${host}）：可能是代理或防火墙中断，请稍后重试。`;
    case "CERT_HAS_EXPIRED":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
      return `模型服务 HTTPS 证书校验失败（${host}）：请换用有效的证书或正确的地址。`;
    default:
      break;
  }

  return `探测模型服务时出错（${host}）${
    code ? `，错误码 ${code}` : ""
  }。请重试；仍失败就到「系统 → 大模型」测试连接。`;
}

function statusMessage(status: number, url: string): string {
  const host = hostOf(url) ?? "模型服务";
  if (status === 401 || status === 403) {
    return `模型接口鉴权失败（HTTP ${status}）：请到「系统 → 大模型」检查 API Key 是否有效、是否属于这个端点。`;
  }
  if (status === 404) {
    return `模型接口返回 404（${host}）：请检查 baseUrl 是否写全——OpenAI 兼容接口通常以 /v1 结尾。`;
  }
  if (status === 429) {
    return `模型接口限流（HTTP 429）：供应商暂不接受更多请求，稍后再试或换一个端点。`;
  }
  if (status >= 500) {
    return `模型服务返回 HTTP ${status}（${host}）：供应商侧异常，稍后重试。`;
  }
  return `模型接口返回 HTTP ${status}（${host}）：请到「系统 → 大模型」用「测试连接」核对配置。`;
}

function cacheKeyOf(config: ModelProbeConfig): string {
  const keyDigest = config.apiKey
    ? createHash("sha256").update(config.apiKey).digest("hex").slice(0, 12)
    : "-";
  return `${config.provider.trim().toLowerCase()}|${trimBaseUrl(config.baseUrl)}|${keyDigest}`;
}

async function runProbe(
  config: ModelProbeConfig,
  options: ModelProbeOptions,
): Promise<ModelDiagnosis> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? MODEL_PROBE_TIMEOUT_MS;
  const base = trimBaseUrl(config.baseUrl);

  if (!base) {
    return {
      checkedAt: new Date(now()).toISOString(),
      ok: null,
      latencyMs: 0,
      message:
        "还没有可探测的模型端点：请到「系统 → 大模型」填写 baseUrl 并保存，再回来刷新进度。",
    };
  }

  const request = probeRequest(config);
  const started = now();
  let response: ModelProbeResponse;
  try {
    response = await (options.fetch ?? (fetch as ModelProbeFetch))(request.url, {
      method: "GET",
      headers: request.headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const latencyMs = Math.max(0, now() - started);
    return {
      checkedAt: new Date(now()).toISOString(),
      ok: false,
      latencyMs,
      message: failureMessage(error, timeoutMs, request.url),
    };
  }

  const latencyMs = Math.max(0, now() - started);
  const checkedAt = new Date(now()).toISOString();
  const ok = response.status >= 200 && response.status < 300;
  if (ok) {
    return {
      checkedAt,
      ok: true,
      latencyMs,
      message: `模型服务可连接（${hostOf(request.url) ?? "端点"}，${latencyMs}ms），但抽取仍然失败，请查看 LightRAG 引擎日志；也可以到「系统 → 大模型」测试连接后重新抽取。`,
    };
  }

  return {
    checkedAt,
    ok: false,
    latencyMs,
    message: statusMessage(response.status, request.url),
  };
}

/**
 * 探测当前模型端点。永不抛错：解析配置、发请求、读响应全程兜底。
 *
 * `db` 可为 null（调用方没有数据库句柄时只用环境配置）。
 */
export async function probeModelEndpoint(
  db: AppDatabase | null,
  options: ModelProbeOptions = {},
): Promise<ModelDiagnosis> {
  const now = options.now ?? Date.now;

  let config: ModelProbeConfig;
  try {
    config = options.config ?? resolveModelProbeConfig(db, options);
  } catch {
    return {
      checkedAt: new Date(now()).toISOString(),
      ok: null,
      latencyMs: 0,
      message:
        "读取大模型配置失败，无法探测模型端点：请到「系统 → 大模型」重新保存一次配置后再刷新。",
    };
  }

  try {
    const cache = options.cache === undefined ? defaultCache : options.cache;

    if (cache) {
      const key = cacheKeyOf(config);
      const hit = cache.get(key);
      if (hit && now() - hit.at < MODEL_PROBE_TTL_MS) {
        return hit.diagnosis;
      }

      const diagnosis = await runProbe(config, options);
      cache.set(key, { at: now(), diagnosis });
      return diagnosis;
    }

    return await runProbe(config, options);
  } catch (error) {
    return {
      checkedAt: new Date(now()).toISOString(),
      ok: false,
      latencyMs: 0,
      message: failureMessage(error, options.timeoutMs ?? MODEL_PROBE_TIMEOUT_MS, config.baseUrl),
    };
  }
}
