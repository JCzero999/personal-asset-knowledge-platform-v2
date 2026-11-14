import { eq } from "drizzle-orm";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { DomainError, ValidationError } from "../../domain/errors";
import type { ActorContext } from "../authz";
import type { AppDatabase } from "../db/client";
import { settings } from "../db/schema";
import {
  SecretBoxError,
  decryptSecret,
  encryptSecret,
  maskSecret,
  resolveSettingsSecret,
} from "../security/secret-box";
import { writeAudit } from "./audit-service";

/**
 * 大模型供应商配置（ADR-025）。
 *
 * 边界：
 * - 落库值整段加密（见 `security/secret-box.ts`），接口只返回掩码；
 * - 没有库内配置时按 `infra/lightrag/.env` 推导「当前生效值」，只读不改；
 * - `apply` 是唯一会碰本机 LightRAG 的操作：写 .env → 只重启 lightrag-server
 *   → 轮询 /health，失败回滚 .env 并重启回原配置。
 *
 * 所有函数都接受注入依赖（fetch / spawn / 文件路径），测试不碰真实服务。
 */

export const SETTINGS_LLM_KEY = "llm";

export const LLM_PROVIDERS = [
  "openai",
  "deepseek",
  "qwen",
  "ollama",
  "custom",
] as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const LLM_TIMEOUT_MIN_MS = 30_000;
export const LLM_TIMEOUT_MAX_MS = 1_800_000;
export const LLM_DEFAULT_TIMEOUT_MS = 300_000;
const MODEL_MAX_LENGTH = 120;
const API_KEY_MAX_LENGTH = 512;

/** 内部形态：含明文 API Key，只在服务端内存里流转。 */
export interface LlmConfig {
  provider: LlmProvider;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  apiKey: string;
}

/** 对外形态：绝不含明文密钥。 */
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

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  provider: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  model: "deepseek-r1:7b",
  timeoutMs: LLM_DEFAULT_TIMEOUT_MS,
  apiKey: "",
};

/* -------------------------------------------------------------------------- */
/* 校验                                                                        */
/* -------------------------------------------------------------------------- */

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("请求体必须是 JSON 对象");
  }
  return body as Record<string, unknown>;
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

export function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError("接口地址不能为空", { field: "baseUrl" });
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ValidationError("接口地址不是合法 URL", { field: "baseUrl" });
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ValidationError("接口地址只支持 https（本机可用 http）", { field: "baseUrl" });
  }

  if (url.protocol === "http:" && !isLocalHost(url.hostname)) {
    throw new ValidationError("远程地址必须使用 https；http 只允许本机地址", {
      field: "baseUrl",
    });
  }

  if (url.username || url.password) {
    throw new ValidationError("接口地址不要包含账号密码，请填在 API Key 里", {
      field: "baseUrl",
    });
  }

  if (url.search || url.hash) {
    throw new ValidationError("接口地址不要带查询参数或锚点", { field: "baseUrl" });
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${pathname}`;
}

function normalizeProvider(value: unknown): LlmProvider {
  if (typeof value !== "string" || !(LLM_PROVIDERS as readonly string[]).includes(value)) {
    throw new ValidationError("供应商取值非法", {
      field: "provider",
      allowed: [...LLM_PROVIDERS],
    });
  }
  return value as LlmProvider;
}

function normalizeModel(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError("模型名不能为空", { field: "model" });
  }

  const model = value.trim();
  if (model.length > MODEL_MAX_LENGTH) {
    throw new ValidationError(`模型名不能超过 ${MODEL_MAX_LENGTH} 个字符`, { field: "model" });
  }

  if (/[\u0000-\u001f\u007f]/.test(model)) {
    throw new ValidationError("模型名不能包含控制字符", { field: "model" });
  }

  return model;
}

function normalizeTimeout(value: unknown): number {
  const timeout = typeof value === "string" ? Number(value) : value;

  if (
    typeof timeout !== "number" ||
    !Number.isInteger(timeout) ||
    timeout < LLM_TIMEOUT_MIN_MS ||
    timeout > LLM_TIMEOUT_MAX_MS
  ) {
    throw new ValidationError("超时需在 30–1800 秒之间", {
      field: "timeoutMs",
      min: LLM_TIMEOUT_MIN_MS,
      max: LLM_TIMEOUT_MAX_MS,
    });
  }

  return timeout;
}

function normalizeApiKey(value: unknown, field = "apiKey"): string {
  if (value === null) return "";
  if (typeof value !== "string") {
    throw new ValidationError("API Key 必须是字符串", { field });
  }

  const key = value.trim();
  if (key.length > API_KEY_MAX_LENGTH) {
    throw new ValidationError(`API Key 不能超过 ${API_KEY_MAX_LENGTH} 个字符`, { field });
  }

  if (/[\u0000-\u001f\u007f]/.test(key)) {
    throw new ValidationError("API Key 不能包含控制字符", { field });
  }

  return key;
}

export interface NormalizeOptions {
  /** true 时只要求出现一部分字段，其余沿用 base。 */
  partial?: boolean;
}

/** 把请求体合并到 base 上并整体校验；`partial` 供「测试连接」用。 */
export function normalizeLlmConfig(
  body: unknown,
  base: LlmConfig = DEFAULT_LLM_CONFIG,
  options: NormalizeOptions = {},
): LlmConfig {
  const record = asRecord(body);

  const pick = <T>(field: string, fallback: T, read: (value: unknown) => T): T => {
    if (!(field in record) || record[field] === undefined) {
      if (options.partial) return fallback;
      throw new ValidationError(`缺少字段 ${field}`, { field });
    }
    return read(record[field]);
  };

  const provider = pick("provider", base.provider, normalizeProvider);
  const baseUrl = pick("baseUrl", base.baseUrl, normalizeBaseUrl);
  const model = pick("model", base.model, normalizeModel);
  const timeoutMs = pick("timeoutMs", base.timeoutMs, normalizeTimeout);

  const apiKey =
    "apiKey" in record && record.apiKey !== undefined
      ? normalizeApiKey(record.apiKey)
      : base.apiKey;

  if (provider !== "ollama" && !apiKey) {
    throw new ValidationError("请填写 API Key", { field: "apiKey" });
  }

  return { provider, baseUrl, model, timeoutMs, apiKey };
}

/* -------------------------------------------------------------------------- */
/* 存储                                                                        */
/* -------------------------------------------------------------------------- */

function requireSecret(explicit?: string): string {
  const secret = explicit?.trim() || resolveSettingsSecret();
  if (!secret) {
    throw new DomainError(
      "INTERNAL",
      "服务端未配置 SETTINGS_ENC_KEY，无法保存或读取 API Key",
    );
  }
  return secret;
}

function readStoredConfig(db: AppDatabase, secret?: string): LlmConfig | null {
  const row = db
    .select()
    .from(settings)
    .where(eq(settings.key, SETTINGS_LLM_KEY))
    .get();

  if (!row) return null;

  try {
    const parsed = JSON.parse(decryptSecret(row.valueEncrypted, requireSecret(secret))) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      throw new SecretBoxError("配置内容不是对象");
    }
    return normalizeLlmConfig(parsed, DEFAULT_LLM_CONFIG);
  } catch (error) {
    if (error instanceof SecretBoxError) {
      throw new DomainError("INTERNAL", error.message);
    }
    if (error instanceof ValidationError) {
      throw new DomainError("INTERNAL", "已保存的大模型配置无效，请重新保存");
    }
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* infra/lightrag/.env                                                         */
/* -------------------------------------------------------------------------- */

export function defaultLightragEnvPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.LIGHTRAG_ENV_PATH?.trim();
  if (configured) return path.resolve(configured);
  return path.resolve(process.cwd(), "infra", "lightrag", ".env");
}

export function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }

  return values;
}

function readEnvValues(envPath: string): Record<string, string> | null {
  if (!existsSync(envPath)) return null;
  try {
    return parseEnvFile(readFileSync(envPath, "utf8"));
  } catch {
    return null;
  }
}

function providerFromEnv(values: Record<string, string>): LlmProvider {
  const binding = (values.LLM_BINDING ?? "").toLowerCase();
  const host = (values.LLM_BINDING_HOST ?? "").toLowerCase();

  if (binding === "ollama") return "ollama";
  if (host.includes("api.deepseek.com")) return "deepseek";
  if (host.includes("dashscope.aliyuncs.com")) return "qwen";
  if (host.includes("api.openai.com")) return "openai";
  return "custom";
}

/** 环境文件 → 内部配置；宿主模型是 ollama 时占位 Key 归零，便于 hasKey 正确。 */
export function configFromEnvValues(values: Record<string, string>): LlmConfig {
  const provider = providerFromEnv(values);
  const rawKey = (values.LLM_BINDING_API_KEY ?? "").trim();
  const timeoutSeconds = Number(values.LLM_TIMEOUT);

  return {
    provider,
    baseUrl: (values.LLM_BINDING_HOST ?? "").trim() || DEFAULT_LLM_CONFIG.baseUrl,
    model: (values.LLM_MODEL ?? "").trim() || DEFAULT_LLM_CONFIG.model,
    timeoutMs:
      Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
        ? Math.min(Math.max(Math.round(timeoutSeconds * 1000), LLM_TIMEOUT_MIN_MS), LLM_TIMEOUT_MAX_MS)
        : LLM_DEFAULT_TIMEOUT_MS,
    apiKey: provider === "ollama" && rawKey === "ollama" ? "" : rawKey,
  };
}

export function readEnvConfig(envPath: string): LlmConfig | null {
  const values = readEnvValues(envPath);
  return values ? configFromEnvValues(values) : null;
}

/** 只改 LLM_* 五个键，其余行（含注释、Embedding、API 服务鉴权）原样保留。 */
export function renderLightragEnv(original: string, config: LlmConfig): string {
  const values: Record<string, string> = {
    LLM_BINDING: config.provider === "ollama" ? "ollama" : "openai",
    LLM_MODEL: config.model,
    LLM_BINDING_HOST: config.baseUrl,
    LLM_BINDING_API_KEY:
      config.provider === "ollama" ? config.apiKey || "ollama" : config.apiKey,
    LLM_TIMEOUT: String(Math.round(config.timeoutMs / 1000)),
  };

  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n]/.test(value)) {
      throw new ValidationError(`配置值 ${key} 不能包含换行`, { field: "config" });
    }
  }

  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const seen = new Set<string>();
  const lines = original.split(/\r?\n/).map((line) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match || !(match[1] in values)) return line;
    seen.add(match[1]);
    return `${match[1]}=${values[match[1]]}`;
  });

  const missing = Object.keys(values).filter((key) => !seen.has(key));
  if (missing.length > 0) {
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    lines.push("", "# 由「系统 → 大模型」写入（ADR-025）");
    for (const key of missing) {
      lines.push(`${key}=${values[key]}`);
    }
  }

  return `${lines.join(newline)}${newline}`;
}

/** 库内配置与 .env 是否逐项一致（只在服务端比较，密钥不出内存）。 */
export function isAppliedToLightrag(config: LlmConfig, envPath: string): boolean {
  const values = readEnvValues(envPath);
  if (!values) return false;

  const envConfig = configFromEnvValues(values);
  const envBinding = (values.LLM_BINDING ?? "").toLowerCase();
  const expectedBinding = config.provider === "ollama" ? "ollama" : "openai";

  return (
    envBinding === expectedBinding &&
    envConfig.baseUrl.replace(/\/+$/, "") === config.baseUrl.replace(/\/+$/, "") &&
    envConfig.model === config.model &&
    envConfig.timeoutMs === config.timeoutMs &&
    envConfig.apiKey === config.apiKey
  );
}

/* -------------------------------------------------------------------------- */
/* 读取 / 保存                                                                 */
/* -------------------------------------------------------------------------- */

function toView(
  config: LlmConfig,
  updatedAt: string | null,
  envPath: string,
): LlmSettingsView {
  const hasKey = Boolean(config.apiKey);
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    timeoutMs: config.timeoutMs,
    hasKey,
    keyMasked: hasKey ? maskSecret(config.apiKey) : null,
    appliedToLightrag: isAppliedToLightrag(config, envPath),
    updatedAt,
  };
}

export interface LlmSettingsDeps {
  envPath?: string;
  env?: Record<string, string | undefined>;
  secret?: string;
}

/**
 * 读取视图。优先级：库内配置 → .env → 内置默认。
 * 没有库内行时 `updatedAt` 为 null，表示「来自环境文件，尚未在页面保存过」。
 */
export function getLlmSettings(
  db: AppDatabase,
  deps: LlmSettingsDeps = {},
): LlmSettingsView {
  const envPath = deps.envPath ?? defaultLightragEnvPath(deps.env);
  const stored = readStoredConfig(db, deps.secret);

  if (stored) {
    const row = db
      .select()
      .from(settings)
      .where(eq(settings.key, SETTINGS_LLM_KEY))
      .get();
    return toView(stored, row?.updatedAt ?? null, envPath);
  }

  const envConfig = readEnvConfig(envPath) ?? DEFAULT_LLM_CONFIG;
  return toView(envConfig, null, envPath);
}

/**
 * 服务端内部使用的**完整**配置（含明文密钥），优先级与 `getLlmSettings` 一致：
 * 库内配置 → `infra/lightrag/.env` → 内置默认。
 *
 * 只给服务端调用链使用：返回值不进任何 API 响应、不进日志。
 */
export function resolveLlmConfig(
  db: AppDatabase,
  deps: LlmSettingsDeps = {},
): LlmConfig {
  return resolveLlmConfigWithSource(db, deps).config;
}

/** 配置来源：stored = 页面保存过；env = 只改了 .env；default = 从未配置。 */
export type LlmConfigSource = "stored" | "env" | "default";

/**
 * 与 `resolveLlmConfig` 同源，额外告诉调用方「这份配置是真的被配置过，
 * 还是内置默认值」。AI 提炼/打分据此区分「模型没绑」与「模型连不上」：
 * 前者直接给可行动的中文提示，后者才值得发一次网络请求。
 */
export function resolveLlmConfigWithSource(
  db: AppDatabase,
  deps: LlmSettingsDeps = {},
): { config: LlmConfig; source: LlmConfigSource } {
  const envPath = deps.envPath ?? defaultLightragEnvPath(deps.env);
  const stored = readStoredConfig(db, deps.secret);

  if (stored) {
    return { config: stored, source: "stored" };
  }

  const envConfig = readEnvConfig(envPath);

  if (envConfig) {
    return { config: envConfig, source: "env" };
  }

  return { config: DEFAULT_LLM_CONFIG, source: "default" };
}

export function updateLlmSettings(
  db: AppDatabase,
  actor: ActorContext,
  body: unknown,
  deps: LlmSettingsDeps = {},
): LlmSettingsView {
  const envPath = deps.envPath ?? defaultLightragEnvPath(deps.env);
  const base = readStoredConfig(db, deps.secret) ?? readEnvConfig(envPath) ?? DEFAULT_LLM_CONFIG;
  const config = normalizeLlmConfig(body, base);
  const keyChanged = config.apiKey !== base.apiKey;

  const encrypted = encryptSecret(JSON.stringify(config), requireSecret(deps.secret));
  const now = new Date().toISOString();

  db.transaction((tx) => {
    tx.insert(settings)
      .values({
        key: SETTINGS_LLM_KEY,
        valueEncrypted: encrypted,
        updatedAt: now,
        updatedBy: actor.sub,
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: { valueEncrypted: encrypted, updatedAt: now, updatedBy: actor.sub },
      })
      .run();

    writeAudit(tx, {
      actor,
      action: "settings.llm.update",
      targetType: "settings",
      targetId: SETTINGS_LLM_KEY,
      detail: {
        provider: config.provider,
        baseUrl: config.baseUrl,
        model: config.model,
        timeoutMs: config.timeoutMs,
        keyChanged,
      },
    });
  });

  return toView(config, now, envPath);
}

/* -------------------------------------------------------------------------- */
/* 测试连接                                                                    */
/* -------------------------------------------------------------------------- */

function sanitize(text: string, secret?: string): string {
  let safe = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (secret) {
    safe = safe.split(secret).join(maskSecret(secret) ?? "…");
  }
  return safe.slice(0, 300);
}

function describeFetchError(error: unknown, secret?: string): string {
  if (!(error instanceof Error)) return "无法连接";

  if (error.name === "TimeoutError" || error.name === "AbortError") {
    return "请求超时";
  }

  const cause = (error as Error & { cause?: { code?: string } }).cause;
  switch (cause?.code) {
    case "ECONNREFUSED":
      return "无法连接：目标地址未监听（服务未启动或地址不对）";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "无法解析域名（检查接口地址或网络）";
    case "CERT_HAS_EXPIRED":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
      return "证书校验失败（证书过期或不受信任）";
    default:
      return sanitize(error.message, secret) || "无法连接";
  }
}

export interface LlmTestDeps extends LlmSettingsDeps {
  fetchImpl?: typeof fetch;
}

/**
 * 向 `{baseUrl}/chat/completions` 发最小请求（max_tokens 8）。
 * 网络 / 鉴权失败不进 HTTP 错误码，而是 `{ ok:false, error }`，
 * 让页面能把「测试结果」和「接口错误」分开显示。
 */
export async function testLlmConnection(
  db: AppDatabase,
  body: unknown,
  deps: LlmTestDeps = {},
): Promise<LlmTestResult> {
  const envPath = deps.envPath ?? defaultLightragEnvPath(deps.env);
  const base = readStoredConfig(db, deps.secret) ?? readEnvConfig(envPath) ?? DEFAULT_LLM_CONFIG;
  const config = normalizeLlmConfig(body, base, { partial: true });

  if (!config.apiKey && config.provider !== "ollama") {
    throw new ValidationError("请先填写 API Key 再测试", { field: "apiKey" });
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const started = Date.now();

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 8,
        stream: false,
      }),
      signal: AbortSignal.timeout(Math.min(config.timeoutMs, 30_000)),
    });

    const latencyMs = Date.now() - started;

    if (!response.ok) {
      const text = sanitize(await response.text().catch(() => ""), config.apiKey);
      const hint =
        response.status === 401 || response.status === 403
          ? "鉴权失败（API Key 无效或权限不足）"
          : response.status === 404
            ? "接口地址不对（返回 404）"
            : `供应商返回 HTTP ${response.status}`;

      return {
        ok: false,
        latencyMs,
        status: response.status,
        error: text ? `${hint}：${text}` : hint,
      };
    }

    return { ok: true, latencyMs, status: response.status };
  } catch (error) {
    const latencyMs = Date.now() - started;
    return {
      ok: false,
      latencyMs,
      status: null,
      error: describeFetchError(error, config.apiKey),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* 应用：写 .env → 只重启 lightrag-server → 轮询 /health → 失败回滚             */
/* -------------------------------------------------------------------------- */

export interface LlmApplyDeps extends LlmSettingsDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  runPowerShell?: (script: string) => string;
  spawnDetached?: (exePath: string, cwd: string) => void;
  killProcess?: (pid: number) => void;
  now?: () => number;
  healthTimeoutMs?: number;
  pollIntervalMs?: number;
  /** 测试与演练用：只写 .env 不重启。 */
  skipRestart?: boolean;
}

export interface LlmApplyResult {
  applied: boolean;
  restarted: boolean;
  rolledBack: false;
  backup: string;
  healthLatencyMs: number | null;
  updatedAt: string | null;
}

interface LightragProcess {
  pid: number;
  name: string;
  commandLine: string;
}

function defaultRunPowerShell(script: string): string {
  if (process.platform !== "win32") {
    throw new DomainError("INTERNAL", "自动重启目前只支持 Windows 本机");
  }

  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 20_000 },
  );

  if (result.error) {
    throw new DomainError("INTERNAL", "无法调用 PowerShell 查询 LightRAG 进程");
  }
  // 脚本写错或权限不足时 PowerShell 退出码非 0、stdout 为空；不看退出码就会
  // 被当成「没有进程」，于是跳过重启却报告成功。
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").trim().split(/\r?\n/)[0]?.slice(0, 200) ?? "";
    throw new DomainError("INTERNAL", "查询 LightRAG 进程失败", { detail });
  }

  return result.stdout ?? "";
}

function defaultSpawnDetached(exePath: string, cwd: string): void {
  // 延续 start.ps1 的日志约定：重启后的进程仍写 lightrag.log / lightrag.err.log，
  // 否则「重启后为什么还失败」就查无实据。日志打不开也要照常启动。
  let stdio: "ignore" | ["ignore", number, number] = "ignore";
  try {
    stdio = ["ignore", openSync(path.join(cwd, "lightrag.log"), "a"), openSync(path.join(cwd, "lightrag.err.log"), "a")];
  } catch {
    stdio = "ignore";
  }

  const child = spawn(exePath, [], {
    cwd,
    detached: true,
    stdio,
    windowsHide: true,
    // 控制台中文/emoji 横幅在 GBK 代码页下会抛 UnicodeEncodeError 直接退出；
    // 从服务里拉起的进程没有终端，必须显式要求 UTF-8。
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
  });
  child.unref();
}

/** 只匹配 lightrag-server，排除 embedding（9381）与任何其他进程。 */
export function findLightragProcesses(runPowerShell: (script: string) => string): LightragProcess[] {
  const script = [
    "$items = Get-CimInstance Win32_Process | Where-Object {",
    "  $_.CommandLine -and",
    "  $_.CommandLine -match 'lightrag-server' -and",
    "  $_.CommandLine -notmatch 'embedding_server' -and",
    "  $_.CommandLine -notmatch '9381'",
    "} | Select-Object ProcessId,Name,CommandLine;",
    "if ($items) { $items | ConvertTo-Json -Compress }",
    // 以分号分隔：PowerShell 会把同一行里紧跟的参数并进上一条命令，
    // 拼成空格连接时 `Select-Object … if (…)` 直接报错，整段静默失败。
  ].join(" ");

  const raw = runPowerShell(script).trim();
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DomainError("INTERNAL", "无法解析 LightRAG 进程列表");
  }

  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items
    .map((item) => {
      const record = (item ?? {}) as Record<string, unknown>;
      return {
        pid: Number(record.ProcessId),
        name: String(record.Name ?? ""),
        commandLine: String(record.CommandLine ?? ""),
      };
    })
    .filter(
      (item: LightragProcess) =>
        Number.isInteger(item.pid) &&
        item.pid > 0 &&
        /lightrag-server/i.test(item.commandLine) &&
        /^[\w.-]+\.exe$/i.test(item.name) &&
        !/embedding_server|9381/i.test(item.commandLine),
    );
}

function killProcessTree(pid: number): void {
  const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  if (result.error || result.status !== 0) {
    throw new DomainError("INTERNAL", "LightRAG 进程停止失败，配置没有生效", { pid });
  }
}

export interface RestartOutcome {
  killed: number[];
  started: boolean;
}

/** 停掉所有 lightrag-server 进程（不动 embedding / docker），再从 .env 目录启动。 */
export function restartLightrag(
  envPath: string,
  deps: Pick<LlmApplyDeps, "runPowerShell" | "spawnDetached" | "killProcess"> = {},
): RestartOutcome {
  const runPowerShell = deps.runPowerShell ?? defaultRunPowerShell;
  const spawnDetached = deps.spawnDetached ?? defaultSpawnDetached;
  const killProcess = deps.killProcess ?? killProcessTree;

  const processes = findLightragProcesses(runPowerShell);
  if (processes.length === 0) {
    // 旧进程还在监听时，新进程会抢不到端口而立刻退出，健康检查却由旧进程
    // 应答——那正是「报告已重启、配置实际没生效」的来源，必须直接失败。
    throw new DomainError(
      "INTERNAL",
      "没有找到正在运行的 LightRAG 进程，无法重启，配置没有生效",
    );
  }

  const killed = processes.map((item) => item.pid);
  for (const pid of killed) {
    killProcess(pid);
  }

  const cwd = path.dirname(envPath);
  const exePath = path.join(cwd, ".venv", "Scripts", "lightrag-server.exe");

  if (!existsSync(exePath)) {
    throw new DomainError("INTERNAL", "找不到 lightrag-server 可执行文件，未重启", {
      expected: path.join(".venv", "Scripts", "lightrag-server.exe"),
    });
  }

  spawnDetached(exePath, cwd);
  return { killed, started: true };
}

function lightragHealthTarget(env: Record<string, string | undefined>): { url: string; apiKey: string } {
  const base = (env.LIGHTRAG_BASE_URL?.trim() || "http://127.0.0.1:9621").replace(/\/+$/, "");
  return { url: `${base}/health`, apiKey: env.LIGHTRAG_API_KEY?.trim() ?? "" };
}

async function pollHealth(
  target: { url: string; apiKey: string },
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<number> {
  const started = now();
  const deadline = started + timeoutMs;

  while (now() < deadline) {
    try {
      const response = await fetchImpl(target.url, {
        headers: target.apiKey ? { "X-API-Key": target.apiKey } : {},
        signal: AbortSignal.timeout(3_000),
      });
      if (response.ok) return now() - started;
    } catch {
      // 服务正在启动，继续轮询。
    }

    await sleep(pollIntervalMs);
  }

  throw new DomainError("INTERNAL", "LightRAG 未在限定时间内恢复健康");
}

/**
 * 应用配置。成功返回备份路径与健康耗时；失败会先把 .env 回滚并重启回原配置，
 * 再抛出带 `rolledBack` 的 INTERNAL 错误。
 */
export async function applyLlmSettings(
  db: AppDatabase,
  actor: ActorContext,
  deps: LlmApplyDeps = {},
): Promise<LlmApplyResult> {
  const envPath = deps.envPath ?? defaultLightragEnvPath(deps.env);
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const healthTimeoutMs = deps.healthTimeoutMs ?? 60_000;
  const pollIntervalMs = deps.pollIntervalMs ?? 2_000;

  if (!existsSync(envPath)) {
    throw new DomainError("INTERNAL", "找不到 infra/lightrag/.env，无法应用配置");
  }

  const config = readStoredConfig(db, deps.secret);
  if (!config) {
    throw new ValidationError("请先保存大模型配置再应用");
  }

  const original = readFileSync(envPath, "utf8");
  const next = renderLightragEnv(original, config);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${envPath}.bak-${stamp}`;
  copyFileSync(envPath, backup);

  let written = false;
  let restarted = false;
  let restartAttempted = false;
  let healthLatencyMs: number | null = null;

  const restart = () => {
    if (deps.skipRestart) return { killed: [] as number[], started: false };
    return restartLightrag(envPath, {
      runPowerShell: deps.runPowerShell,
      spawnDetached: deps.spawnDetached,
      killProcess: deps.killProcess,
    });
  };

  try {
    writeFileSync(envPath, next, "utf8");
    written = true;

    if (!deps.skipRestart) {
      restartAttempted = true;
      restart();
      restarted = true;
      healthLatencyMs = await pollHealth(
        lightragHealthTarget(env),
        fetchImpl,
        sleep,
        now,
        healthTimeoutMs,
        pollIntervalMs,
      );
    }

    writeAudit(db, {
      actor,
      action: "settings.llm.apply",
      targetType: "settings",
      targetId: SETTINGS_LLM_KEY,
      detail: {
        provider: config.provider,
        model: config.model,
        baseUrl: config.baseUrl,
        backup: path.basename(backup),
        restarted,
      },
    });

    return {
      applied: true,
      restarted,
      rolledBack: false,
      backup: path.basename(backup),
      healthLatencyMs,
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    const reason = error instanceof Error ? sanitize(error.message) : "未知错误";
    const rolledBack = written;

    if (written) {
      try {
        copyFileSync(backup, envPath);
      } catch {
        // 回滚写失败也要继续尝试重启，最终错误里如实说明。
      }

      if (restartAttempted && !deps.skipRestart) {
        try {
          restart();
          await pollHealth(
            lightragHealthTarget(env),
            fetchImpl,
            sleep,
            now,
            Math.min(healthTimeoutMs, 30_000),
            pollIntervalMs,
          );
        } catch {
          // 回滚重启失败：错误信息里标注，交给人工处理。
        }
      }
    }

    try {
      writeAudit(db, {
        actor,
        action: "settings.llm.apply",
        targetType: "settings",
        targetId: SETTINGS_LLM_KEY,
        detail: { provider: config.provider, model: config.model, reason, rolledBack },
        result: "error",
      });
    } catch {
      // 审计失败不能覆盖原始错误。
    }

    throw new DomainError(
      "INTERNAL",
      rolledBack
        ? "应用失败：已回滚配置并尝试重启回原设置"
        : "应用失败：未能写入 infra/lightrag/.env",
      { rolledBack, reason, backup: path.basename(backup) },
    );
  }
}
