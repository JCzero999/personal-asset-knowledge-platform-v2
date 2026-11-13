"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { callJson } from "@/lib/api-fetch";
import { formatDateTime } from "@/lib/content-format";
import {
  DEFAULT_TIMEOUT_SECONDS,
  llmPresets,
  providerLabel,
  testBaseUrl,
  timeoutMsFromSeconds,
  timeoutSecondsFromMs,
  validateApiKey,
  validateBaseUrl,
  validateModel,
  validateTimeoutSeconds,
  type LlmApplyResult,
  type LlmApplyFailureDetails,
  type LlmProvider,
  type LlmSettingsView,
  type LlmTestResult,
} from "@/lib/llm-settings";
import { Icon } from "./icon";

/**
 * 「系统 → 大模型」（ADR-025 / 19_DESIGN_LLM_PREVIEW §2）。
 *
 * 页面只做三件事：读当前配置、改一份待保存的配置、把保存值应用到 LightRAG。
 * 「保存」与「应用」刻意分开——应用会重启抽取服务，中途失败由服务端回滚 .env，
 * 页面负责如实呈现「已回滚 / 需要人工」两种情况。
 */

type Phase = "loading" | "ready" | "unavailable" | "error";

function trimBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

type StepState = "idle" | "running" | "done" | "failed";

interface ApplyState {
  steps: StepState[];
  message: string | null;
  rolledBack: boolean;
  backup: string | null;
  healthMs: number | null;
}

/**
 * 应用失败时服务端会自己回滚并重启；步骤条只如实标出走到哪一步。
 */
const applyStepLabels = [
  "校验配置",
  "写入配置",
  "重启抽取服务",
  "等待服务就绪",
  "完成",
] as const;

function StepMark({ state }: { state: StepState }) {
  if (state === "running") {
    return <span className="spinner llm-step-spinner" aria-hidden="true" />;
  }
  if (state === "done") {
    return <Icon name="check" size={16} />;
  }
  if (state === "failed") {
    return <Icon name="alert" size={16} />;
  }
  return <span className="llm-step-dot" aria-hidden="true" />;
}

export function LlmSettingsPanel({ canWrite }: { canWrite: boolean }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [phaseMessage, setPhaseMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState<LlmSettingsView | null>(null);

  const [provider, setProvider] = useState<LlmProvider>("ollama");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(DEFAULT_TIMEOUT_SECONDS));
  const [apiKey, setApiKey] = useState("");
  const [keyEditing, setKeyEditing] = useState(true);

  const [pending, setPending] = useState<null | "save" | "test" | "apply">(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ result: LlmTestResult; at: Date } | null>(null);
  const [applyState, setApplyState] = useState<ApplyState | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const confirmRef = useRef<HTMLDialogElement>(null);
  const applySectionRef = useRef<HTMLElement>(null);

  const hydrate = useCallback((view: LlmSettingsView) => {
    setProvider(view.provider);
    setBaseUrl(view.baseUrl);
    setModel(view.model);
    setTimeoutSeconds(String(timeoutSecondsFromMs(view.timeoutMs)));
    setApiKey("");
    // 已保存过密钥时默认显示掩码行；没有密钥则直接显示输入框。
    setKeyEditing(!view.hasKey);
  }, []);

  const load = useCallback(async () => {
    const response = await callJson<LlmSettingsView>("/api/settings/llm", {
      cache: "no-store",
    });

    if (!response.ok) {
      if (response.unavailable) {
        setPhase("unavailable");
        setPhaseMessage("大模型设置的服务端还没准备好。稍后点「重新加载」再试。");
      } else {
        setPhase("error");
        setPhaseMessage(response.message);
      }
      return;
    }

    setSaved(response.data);
    hydrate(response.data);
    setPhase("ready");
  }, [hydrate]);

  // 首次进入由 effect 触发；重试按钮先回到加载态再请求。
  const reload = useCallback(() => {
    setPhase("loading");
    setPhaseMessage(null);
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const dialog = confirmRef.current;
    if (!dialog) return;
    if (confirming && !dialog.open) dialog.showModal();
    if (!confirming && dialog.open) dialog.close();
  }, [confirming]);

  const busy = pending !== null;
  const editable = canWrite && !busy;
  const dirty = saved
    ? provider !== saved.provider
      || trimBaseUrl(baseUrl) !== saved.baseUrl
      || model.trim() !== saved.model
      || timeoutMsFromSeconds(Number(timeoutSeconds)) !== saved.timeoutMs
      || apiKey.trim() !== ""
    : true;

  /** 沿用已保存的密钥：同一供应商、已保存过、且这次没输入新的。 */
  const savedKeyUsable = Boolean(saved?.hasKey)
    && saved?.provider === provider
    && apiKey.trim() === "";

  function collectErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    const urlError = validateBaseUrl(baseUrl);
    if (urlError) errors.baseUrl = urlError;
    const modelError = validateModel(model);
    if (modelError) errors.model = modelError;
    const timeoutError = validateTimeoutSeconds(timeoutSeconds);
    if (timeoutError) errors.timeoutMs = timeoutError;
    const keyError = validateApiKey(apiKey, provider);
    if (keyError && !savedKeyUsable) {
      errors.apiKey = keyError;
    }
    return errors;
  }

  function pickPreset(next: LlmProvider) {
    if (!editable) return;
    const previous = llmPresets.find((preset) => preset.id === provider) ?? null;
    const target = llmPresets.find((preset) => preset.id === next) ?? null;
    if (!target) return;

    setProvider(next);

    // 只替换「空着的」或「仍等于上一个预设默认值」的字段，不覆盖用户手填的内容。
    const urlIsDefault = trimBaseUrl(baseUrl) === "" || trimBaseUrl(baseUrl) === (previous ? trimBaseUrl(previous.baseUrl) : "");
    if (urlIsDefault && target.baseUrl) setBaseUrl(target.baseUrl);

    const modelIsDefault = model.trim() === "" || model.trim() === (previous?.model ?? "");
    if (modelIsDefault && target.model) setModel(target.model);

    setFieldErrors({});
  }

  async function save() {
    if (!editable) return;

    const errors = collectErrors();
    setFieldErrors(errors);
    setFormError(null);
    if (Object.keys(errors).length > 0) return;

    setPending("save");
    const body: Record<string, unknown> = {
      provider,
      baseUrl: trimBaseUrl(baseUrl),
      model: model.trim(),
      timeoutMs: timeoutMsFromSeconds(Number(timeoutSeconds)),
    };
    if (apiKey.trim()) body.apiKey = apiKey.trim();

    const response = await callJson<LlmSettingsView>("/api/settings/llm", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    setPending(null);

    if (!response.ok) {
      if (response.unavailable) {
        setFormError("后端未就绪，配置没有保存。");
        return;
      }
      const field = typeof response.details?.field === "string" ? response.details.field : null;
      if (field) setFieldErrors({ [field]: response.message });
      else setFormError(response.message);
      return;
    }

    setSaved(response.data);
    hydrate(response.data);
    setToast("已保存。点「应用并重启」后才会用于图谱抽取。");
  }

  async function test() {
    if (!editable) return;

    const errors: Record<string, string> = {};
    const urlError = validateBaseUrl(baseUrl);
    if (urlError) errors.baseUrl = urlError;
    const modelError = validateModel(model);
    if (modelError) errors.model = modelError;
    const timeoutError = validateTimeoutSeconds(timeoutSeconds);
    if (timeoutError) errors.timeoutMs = timeoutError;
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setPending("test");
    setFormError(null);

    const body: Record<string, unknown> = {
      provider,
      baseUrl: testBaseUrl(provider, baseUrl),
      model: model.trim(),
      timeoutMs: timeoutMsFromSeconds(Number(timeoutSeconds)),
    };
    // 只有「刚输入的」密钥才带上；留空表示沿用已保存的那把（服务端按缺省字段处理）。
    const typedKey = apiKey.trim();
    if (typedKey) body.apiKey = typedKey;
    else if (provider === "ollama") body.apiKey = "ollama";

    const response = await callJson<LlmTestResult>("/api/settings/llm/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    setPending(null);

    if (!response.ok) {
      setTestResult({
        result: {
          ok: false,
          latencyMs: 0,
          status: response.status || null,
          error: response.message,
        },
        at: new Date(),
      });
      return;
    }

    setTestResult({ result: response.data, at: new Date() });
  }

  async function apply() {
    if (!editable || phase !== "ready") return;
    setConfirming(false);
    setPending("apply");
    setFormError(null);
    setApplyState({
      steps: ["done", "running", "idle", "idle", "idle"],
      message: null,
      rolledBack: false,
      backup: null,
      healthMs: null,
    });

    const response = await callJson<LlmApplyResult>("/api/settings/llm/apply", {
      method: "POST",
    });

    setPending(null);

    if (response.ok) {
      setApplyState({
        steps: ["done", "done", "done", "done", "done"],
        message: null,
        rolledBack: false,
        backup: response.data.backup ?? null,
        healthMs: response.data.healthLatencyMs,
      });
      setToast("已应用，图谱抽取将使用新模型");
      void load();
      return;
    }

    const details = (response.details ?? {}) as LlmApplyFailureDetails;
    setApplyState({
      steps: ["done", "failed", "idle", "idle", "idle"],
      message: details.reason || response.message,
      rolledBack: details.rolledBack === true,
      backup: typeof details.backup === "string" ? details.backup : null,
      healthMs: null,
    });
  }

  function scrollToApply() {
    applySectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  if (phase === "loading" && !saved) {
    return (
      <div className="llm-grid" aria-busy="true">
        <section className="panel llm-skeleton">
          <span className="skeleton skeleton-line" />
          <span className="skeleton skeleton-line" />
          <span className="skeleton skeleton-line" />
        </section>
        <section className="panel llm-skeleton">
          <span className="skeleton skeleton-line" />
          <span className="skeleton skeleton-line" />
        </section>
      </div>
    );
  }

  if (phase === "unavailable" || phase === "error") {
    return (
      <div className="llm-grid">
        <section className="panel empty-state" role="alert">
          <span className="empty-icon"><Icon name="alert" size={26} /></span>
          <div className="empty-copy">
            <strong>{phase === "unavailable" ? "后端未就绪" : "读取配置失败"}</strong>
            <p>{phaseMessage}</p>
          </div>
          <button className="btn btn-secondary empty-action" type="button" onClick={reload}>
            <Icon name="refresh" size={15} />
            重新加载
          </button>
        </section>
      </div>
    );
  }

  const badgeTone = !saved || !saved.updatedAt
    ? "admin-badge is-muted"
    : saved.appliedToLightrag
      ? "admin-badge is-ok"
      : "admin-badge is-warn";
  const badgeLabel = !saved || !saved.updatedAt
    ? "未在页面保存"
    : saved.appliedToLightrag
      ? "已应用"
      : "待应用";

  const testTone = !testResult
    ? "is-idle"
    : testResult.result.ok
      ? "is-ok"
      : "is-error";

  const testText = !testResult
    ? "还没测试过。保存前建议先测一次。"
    : testResult.result.ok
      ? `连接成功 · ${testResult.result.latencyMs}ms${testResult.result.status ? ` · HTTP ${testResult.result.status}` : ""}`
      : describeTestFailure(testResult.result);

  return (
    <>
      <div className="llm-grid">
        <section className="panel" aria-labelledby="llm-current">
          <div className="panel-heading">
            <div>
              <h2 id="llm-current">当前生效</h2>
              <p>图谱抽取用的模型来自这里；保存不会立刻生效，要应用并重启。</p>
            </div>
            <span className={badgeTone}>{badgeLabel}</span>
          </div>

          {saved && saved.updatedAt && !saved.appliedToLightrag ? (
            <div className="llm-diff" role="status">
              <Icon name="alert" size={15} />
              <p>数据库里的配置还没应用到 LightRAG，当前仍在使用原来的模型。</p>
              <button className="text-button" type="button" onClick={scrollToApply}>
                去应用
              </button>
            </div>
          ) : null}

          <dl className="admin-kv">
            <div>
              <dt>供应商</dt>
              <dd>{providerLabel(saved?.provider ?? provider)}</dd>
            </div>
            <div>
              <dt>模型</dt>
              <dd className="llm-mono">{saved?.model ?? model ?? "—"}</dd>
            </div>
            <div>
              <dt>服务地址</dt>
              <dd className="admin-path" title={saved?.baseUrl ?? baseUrl}>
                {saved?.baseUrl ?? baseUrl ?? "—"}
              </dd>
            </div>
            <div>
              <dt>超时</dt>
              <dd>{saved ? `${timeoutSecondsFromMs(saved.timeoutMs)} 秒` : "—"}</dd>
            </div>
            <div>
              <dt>API Key</dt>
              <dd>
                {saved?.hasKey ? (
                  <span className="llm-key-mask">
                    <span className="llm-mono">{saved.keyMasked}</span>
                    <span className="llm-note">保存后不可查看，只能替换</span>
                  </span>
                ) : provider === "ollama" ? (
                  <span className="llm-note">本机 Ollama 不需要</span>
                ) : (
                  <span className="llm-note">未设置</span>
                )}
              </dd>
            </div>
            <div>
              <dt>最近保存</dt>
              <dd>
                {saved?.updatedAt
                  ? formatDateTime(saved.updatedAt)
                  : "来自环境文件，尚未在页面保存过"}
              </dd>
            </div>
          </dl>
        </section>

        <section className="panel" aria-labelledby="llm-service">
          <div className="panel-heading">
            <div>
              <h2 id="llm-service">模型服务</h2>
              <p>保存只改数据库，不影响正在跑的抽取；确认无误后再应用并重启。</p>
            </div>
          </div>

          <fieldset className="llm-fieldset" disabled={!editable}>
            <div className="llm-body">
              <div className="llm-presets" role="group" aria-label="供应商预设">
                {llmPresets.map((preset) => {
                  const active = preset.id === provider;
                  return (
                    <button
                      className={`llm-preset${active ? " is-active" : ""}`}
                      key={preset.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => pickPreset(preset.id)}
                    >
                      <span className="llm-preset-name">
                        {preset.name}
                        {active ? <Icon name="check" size={14} /> : null}
                      </span>
                      <span className="llm-preset-hint">{preset.hint}</span>
                    </button>
                  );
                })}
              </div>

              <div className="llm-fields">
                <label className="field">
                  <span className="field-label">服务地址</span>
                  <input
                    className="text-input llm-mono"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    placeholder="https://api.deepseek.com/v1"
                    aria-invalid={Boolean(fieldErrors.baseUrl)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <span className={fieldErrors.baseUrl ? "field-error" : "field-note"}>
                    {fieldErrors.baseUrl ?? "要带版本前缀，例如 /v1；只填到域名会 404。"}
                  </span>
                </label>

                <label className="field">
                  <span className="field-label">模型名</span>
                  <input
                    className="text-input llm-mono"
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder="deepseek-chat"
                    aria-invalid={Boolean(fieldErrors.model)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <span className={fieldErrors.model ? "field-error" : "field-note"}>
                    {fieldErrors.model ?? "填服务商文档里的模型 id，不是显示名。"}
                  </span>
                </label>
              </div>

              <div className="llm-fields">
                <label className="field">
                  <span className="field-label">API Key</span>
                  {saved && savedKeyUsable && !keyEditing && provider !== "ollama" ? (
                    <span className="llm-key-row">
                      <span className="llm-key-saved">
                        <span className="llm-mono">{saved.keyMasked}</span>
                        <span className="admin-badge is-ok">已保存</span>
                      </span>
                      <button
                        className="btn btn-ghost"
                        type="button"
                        onClick={() => setKeyEditing(true)}
                      >
                        替换
                      </button>
                    </span>
                  ) : (
                    <input
                      className="text-input llm-mono"
                      type="password"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder={provider === "ollama" ? "本机不用填" : "sk-…"}
                      aria-invalid={Boolean(fieldErrors.apiKey)}
                      autoComplete="new-password"
                      spellCheck={false}
                    />
                  )}
                  <span className={fieldErrors.apiKey ? "field-error" : "field-note"}>
                    {fieldErrors.apiKey
                      ?? (keyEditing && saved?.hasKey
                        ? "输入新密钥后保存，旧密钥会被覆盖。"
                        : "只写不回显。保存后这里只显示掩码，忘了就替换一把新的。")}
                  </span>
                </label>

                <label className="field">
                  <span className="field-label">超时</span>
                  <span className="llm-suffix-field">
                    <input
                      className="text-input llm-mono"
                      value={timeoutSeconds}
                      onChange={(event) => setTimeoutSeconds(event.target.value)}
                      inputMode="numeric"
                      aria-invalid={Boolean(fieldErrors.timeoutMs)}
                    />
                    <span className="llm-suffix" aria-hidden="true">秒</span>
                  </span>
                  <span className={fieldErrors.timeoutMs ? "field-error" : "field-note"}>
                    {fieldErrors.timeoutMs ?? "本机 7B 建议 600 秒以上；外部服务 60–120 秒通常够。"}
                  </span>
                </label>
              </div>

              {formError ? (
                <div className="form-alert" role="alert">
                  <Icon name="alert" size={16} />
                  <p>{formError}</p>
                </div>
              ) : null}
            </div>
          </fieldset>

          <div className="panel-actions">
            <button
              className="btn btn-secondary"
              type="button"
              disabled={!editable}
              onClick={() => void test()}
            >
              {pending === "test" ? <span className="spinner" aria-hidden="true" /> : null}
              {pending === "test" ? "测试中…" : "测试连接"}
            </button>
            <button
              className="btn btn-primary"
              type="button"
              disabled={!editable || !dirty}
              onClick={() => void save()}
            >
              {pending === "save" ? <span className="spinner" aria-hidden="true" /> : null}
              {pending === "save" ? "保存中…" : "保存"}
            </button>
          </div>
        </section>

        <section className="panel" aria-labelledby="llm-test">
          <div className="panel-heading">
            <div>
              <h2 id="llm-test">连接测试</h2>
              <p>测的是当前表单里的值，未保存也会测。</p>
            </div>
            {testResult ? (
              <span className="llm-note">
                {testResult.at.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 测过
              </span>
            ) : null}
          </div>

          <div className={`llm-result ${testTone}`} role={testResult && !testResult.result.ok ? "alert" : "status"}>
            {!testResult ? <Icon name="sparkles" size={15} /> : null}
            {testResult?.result.ok ? <Icon name="check" size={15} /> : null}
            {testResult && !testResult.result.ok ? <Icon name="alert" size={15} /> : null}
            <span>{testText}</span>
          </div>

          {testResult && !testResult.result.ok && testResult.result.error ? (
            <p className="llm-result-raw">{testResult.result.error}</p>
          ) : null}
        </section>

        <section className="panel" id="llm-apply" ref={applySectionRef} aria-labelledby="llm-apply-heading">
          <div className="panel-heading">
            <div>
              <h2 id="llm-apply-heading">应用到图谱抽取</h2>
              <p>
                应用会把当前保存的配置写入 LightRAG 并重启抽取服务：通常 10–30 秒不可用，
                最长等 60 秒，正在抽取的内容会中断；失败自动回滚。
              </p>
            </div>
          </div>

          <div className="llm-body">
            {applyState ? (
              <ol className="llm-steps">
                {applyState.steps.map((state, index) => (
                  <li className={`llm-step is-${state}`} key={applyStepLabels[index]}>
                    <span className="llm-step-mark"><StepMark state={state} /></span>
                    <span className="llm-step-text">
                      {state === "done"
                        ? `${applyStepLabels[index]} · 完成`
                        : state === "running"
                          ? `${applyStepLabels[index]}…`
                          : applyStepLabels[index]}
                      {index === 4 && applyState.healthMs !== null
                        ? ` · 用时 ${Math.round(applyState.healthMs / 1000)} 秒`
                        : ""}
                    </span>
                  </li>
                ))}
              </ol>
            ) : null}

            {pending === "apply" ? (
              <p className="llm-note" role="status">
                正在写入配置并重启服务，最多等 60 秒，期间请不要关闭页面。
              </p>
            ) : null}

            {applyState?.message ? (
              <div className="llm-result is-error" role="alert">
                <Icon name="alert" size={15} />
                <span>
                  {applyState.rolledBack
                    ? `应用失败：${applyState.message}。已回滚到原配置，LightRAG 仍按原模型运行。`
                    : `应用失败且回滚未完成：${applyState.message}。请检查 infra/lightrag/.env 后手动重启服务。`}
                </span>
              </div>
            ) : null}

            {applyState?.backup ? (
              <p className="llm-note">
                备份文件：<code className="llm-mono">{applyState.backup}</code>
              </p>
            ) : null}
          </div>

          <div className="panel-actions">
            <button
              className="btn btn-primary"
              type="button"
              disabled={!editable || !saved || saved.appliedToLightrag || pending === "apply"}
              onClick={() => setConfirming(true)}
            >
              {pending === "apply" ? <span className="spinner" aria-hidden="true" /> : null}
              {pending === "apply" ? "正在应用…" : "应用并重启"}
            </button>
          </div>
        </section>

        {!canWrite ? (
          <p className="llm-readonly">只读：你没有修改大模型配置的权限。</p>
        ) : null}
      </div>

      <dialog
        ref={confirmRef}
        className="dialog dialog-sm"
        aria-labelledby="llm-apply-confirm"
        onClose={() => setConfirming(false)}
        onClick={(event) => {
          if (event.target === confirmRef.current) setConfirming(false);
        }}
      >
        <div className="dialog-form">
          <header className="dialog-head">
            <div>
              <h2 id="llm-apply-confirm">应用并重启 LightRAG？</h2>
              <p>抽取服务会重启，通常 10–30 秒；正在抽取的内容会中断。</p>
            </div>
            <button
              className="icon-button"
              type="button"
              aria-label="关闭"
              onClick={() => setConfirming(false)}
            >
              <Icon name="x" size={18} />
            </button>
          </header>
          <div className="dialog-body">
            <p className="dialog-text">
              即将应用：{providerLabel(saved?.provider ?? provider)} · {saved?.model ?? model} · 超时{" "}
              {saved ? timeoutSecondsFromMs(saved.timeoutMs) : timeoutSeconds} 秒
            </p>
            {dirty ? (
              <p className="llm-note">表单里还有未保存的修改，这次应用不会包含它们。</p>
            ) : null}
            <p className="dialog-warning">
              <Icon name="alert" size={14} />
              在途任务会中断，需要重新抽取；应用失败会自动回滚到原配置。
            </p>
          </div>
          <footer className="dialog-actions">
            <button className="btn btn-ghost" type="button" onClick={() => setConfirming(false)}>
              取消
            </button>
            <button className="btn btn-primary" type="button" onClick={() => void apply()}>
              应用并重启
            </button>
          </footer>
        </div>
      </dialog>

      {toast ? (
        <div className="toast" role="status">
          <Icon name="check" size={16} />
          {toast}
        </div>
      ) : null}
    </>
  );
}

/** 测试失败的文案：能行动的建议在前，服务端原文留给下方小字。 */
function describeTestFailure(result: LlmTestResult): string {
  const status = result.status ?? 0;

  if (status === 401 || status === 403) {
    return "密钥被拒绝（401）。检查 Key 是否复制完整、是否属于这个服务。";
  }
  if (status === 404) {
    return "地址或模型名不对（404）。确认服务地址带 /v1，模型 id 与服务商一致。";
  }
  if (status === 0 || result.error === "请求超时") {
    return result.error === "请求超时"
      ? "等了一段时间没有响应。换外部服务，或把超时调大后重试。"
      : "连不上这个地址。若填的是本机地址，确认 Ollama 已启动。";
  }
  return `测试失败（HTTP ${status}）。检查地址、模型名与密钥后重试。`;
}
