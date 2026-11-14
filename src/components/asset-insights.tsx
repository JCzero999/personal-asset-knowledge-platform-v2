"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type { BusinessObject } from "@/domain/objects";
import { apiErrorMessage, apiRequest, jsonBodyInit } from "@/lib/api-client";
import { formatDateTime } from "@/lib/content-format";
import { Icon } from "./icon";
import {
  aiBadge,
  dimensionLabel,
  formatScore,
  readAiScore,
  readAiStatus,
  readValueLevel,
  scorePercent,
  valueBadge,
  valueLevelDescriptions,
  valueTriggerLabels,
  weightPercent,
  type DimensionLike,
  type LifecycleBadge,
} from "./lifecycle";

/** GET /api/objects/{id}/value-history 的一行（与服务端口类型同形）。 */
interface ValueHistoryItem {
  id: string;
  assessedAt: string;
  assessedBy: string;
  trigger: string;
  valueLevel: string;
  prevLevel: string | null;
  reason: string | null;
}

/**
 * 资产详情里的评分与价值面板（规格 v2.0 第 5、6 节）。
 *
 * 外库资产：AI 综合分 + 六维明细 + 人工复核（通过 / 拒绝）。
 * 内库资产：S/A/B/C 价值等级 + 五维明细 + 重新评估。
 * 字段未落地时按「未打分 / 未评估」展示，按钮照常可用，后端接入后自然生效。
 */

function Badge({ badge }: { badge: LifecycleBadge }) {
  return <span className={`lifecycle-badge is-${badge.tone}`}>{badge.label}</span>;
}

function DimensionList({
  id,
  dimensions,
  kind,
  max,
}: {
  id: string;
  dimensions: DimensionLike[];
  kind: "ai" | "value";
  max: number;
}) {
  return (
    <ol className="dim-list" id={id}>
      {dimensions.map((dimension, index) => {
        const label = dimensionLabel(dimension, kind);
        const weight = kind === "ai" ? weightPercent(dimension.weight) : null;
        const percent = scorePercent(dimension.score, max);
        const fill = percent < 40 ? " is-danger" : percent < 60 ? " is-warn" : "";

        return (
          <li className="dim-row" key={`${dimension.key}-${index}`}>
            <div className="dim-head">
              <span className="dim-title">
                <span className="dim-label">{label}</span>
                {weight !== null ? <span className="dim-weight">{weight}%</span> : null}
              </span>
              <span className="dim-score">
                {typeof dimension.score === "number"
                  ? `${formatScore(dimension.score)} / ${max}`
                  : "—"}
              </span>
            </div>
            <div className="dim-bar" aria-hidden="true">
              <span className={`dim-fill${fill}`} style={{ width: `${percent}%` }} />
            </div>
            {dimension.reason ? <p className="dim-reason">{dimension.reason}</p> : null}
          </li>
        );
      })}
    </ol>
  );
}

function ReviewDialog({
  object,
  mode,
  onClose,
  onDone,
}: {
  object: BusinessObject;
  mode: "approve" | "reject";
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    noteRef.current?.focus();
  }, []);

  async function submit() {
    if (pending) return;
    setPending(true);
    setError(null);

    try {
      const trimmed = note.trim();
      await apiRequest(`/api/objects/${object.id}/review`, jsonBodyInit({
        decision: mode,
        ...(trimmed ? { note: trimmed } : {}),
      }));
      onDone(mode === "approve" ? "已通过复核，资产已沉淀到内库" : "已拒绝，资产留在外库观察");
    } catch (cause) {
      setError(apiErrorMessage(cause));
      setPending(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="dialog dialog-sm"
      aria-labelledby={headingId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current && !pending) onClose();
      }}
    >
      <form
        className="dialog-form"
        aria-busy={pending}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <header className="dialog-head">
          <div>
            <h2 id={headingId}>{mode === "approve" ? "通过这条资产？" : "拒绝这条资产？"}</h2>
            <p>
              {mode === "approve"
                ? "通过后进入内库，并立即进行五维价值评估。"
                : "拒绝后标记为低价值，留在外库等待清理。"}
            </p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭"
            disabled={pending}
            onClick={onClose}
          >
            <Icon name="x" size={18} />
          </button>
        </header>

        <div className="dialog-body">
          <div className="field">
            <label className="field-label" htmlFor={`${headingId}-note`}>
              备注 <span className="field-note">选填</span>
            </label>
            <textarea
              ref={noteRef}
              id={`${headingId}-note`}
              className="textarea"
              rows={3}
              maxLength={500}
              value={note}
              placeholder={
                mode === "approve"
                  ? "例如：方法可复用，补充到内库。"
                  : "例如：与已有资产重复，暂不沉淀。"
              }
              onChange={(event) => setNote(event.target.value)}
            />
          </div>

          {error ? (
            <div className="form-alert" role="alert">
              <Icon name="alert" size={17} />
              <p>{error}</p>
            </div>
          ) : null}
        </div>

        <footer className="dialog-actions">
          <button className="btn btn-ghost" type="button" disabled={pending} onClick={onClose}>
            取消
          </button>
          <button
            className={`btn ${mode === "approve" ? "btn-primary" : "btn-danger"}`}
            type="submit"
            disabled={pending}
          >
            {pending && <span className="spinner" aria-hidden="true" />}
            {pending ? "处理中…" : mode === "approve" ? "通过并进入内库" : "拒绝"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

function useToast() {
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  return [toast, setToast] as const;
}

function AiScorePanel({
  object,
  onNotify,
}: {
  object: BusinessObject;
  onNotify: (message: string) => void;
}) {
  const router = useRouter();
  const idPrefix = useId();
  const listId = `${idPrefix}-dimensions`;

  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewMode, setReviewMode] = useState<"approve" | "reject" | null>(null);

  const status = readAiStatus(object);
  const score = readAiScore(object);
  const detail = object.aiScoreDetail;
  const dimensions = Array.isArray(detail?.dimensions) ? detail.dimensions : [];
  const badge = aiBadge(object);
  const busy = pending !== null;

  const verdict =
    status === "auto_pass" ? "AI 推荐沉淀，可直接进入内库"
    : status === "needs_review" ? "分数落在 60–74，进入人工复核池"
    : status === "low_value" ? "低于 60 分，留在外库观察或清理"
    : status === "approved" ? "已人工通过，等待进入内库"
    : status === "rejected" ? "已人工拒绝，留在外库"
    : "还没有评分，先运行一次 AI 打分";

  async function rescore() {
    if (busy) return;
    setPending("score");
    setError(null);

    try {
      await apiRequest(`/api/objects/${object.id}/score`, jsonBodyInit({}));
      onNotify("已重新打分");
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause));
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="panel lifecycle-panel" aria-labelledby={`${idPrefix}-heading`}>
      <header className="lifecycle-head">
        <div className="lifecycle-head-copy">
          <h2 id={`${idPrefix}-heading`}>AI 评分</h2>
          <p>≥75 分自动进内库，60–74 分待人工复核，低于 60 分留在外库。</p>
        </div>
        <div className="lifecycle-toolbar">
          {badge ? <Badge badge={badge} /> : null}
          <button
            className="chip-button"
            type="button"
            disabled={busy}
            onClick={() => void rescore()}
          >
            {pending === "score" ? "打分中…" : status === "unscored" ? "开始打分" : "重新打分"}
          </button>
        </div>
      </header>

      <div className="lifecycle-body">
        {error ? (
          <div className="form-alert" role="alert">
            <Icon name="alert" size={16} />
            <p>{error}</p>
          </div>
        ) : null}

        <div className="lifecycle-summary">
          <span className="lifecycle-score">
            {score === null ? "—" : formatScore(score)}
            <small>分</small>
          </span>
          <span className="lifecycle-verdict">{verdict}</span>
        </div>

        {detail?.model || detail?.scoredAt ? (
          <p className="lifecycle-meta">
            {detail?.model ?? "AI"}
            {detail?.scoredAt ? ` · ${formatDateTime(detail.scoredAt)}` : ""}
          </p>
        ) : null}

        {dimensions.length > 0 ? (
          <>
            <button
              className="text-button lifecycle-toggle"
              type="button"
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setExpanded((value) => !value)}
            >
              <Icon name="arrow-right" size={13} />
              {expanded ? "收起六维得分" : "查看六维得分与理由"}
            </button>
            {expanded ? (
              <DimensionList id={listId} dimensions={dimensions} kind="ai" max={100} />
            ) : null}
          </>
        ) : (
          <p className="lifecycle-hint">打分后会列出六个维度的得分与理由，方便复核时快速判断。</p>
        )}

        {status === "needs_review" ? (
          <div className="lifecycle-toolbar lifecycle-review">
            <button
              className="chip-button chip-primary"
              type="button"
              disabled={busy}
              onClick={() => setReviewMode("approve")}
            >
              <Icon name="check" size={13} />
              通过
            </button>
            <button
              className="chip-button"
              type="button"
              disabled={busy}
              onClick={() => setReviewMode("reject")}
            >
              <Icon name="x" size={13} />
              拒绝
            </button>
          </div>
        ) : null}
      </div>

      {reviewMode ? (
        <ReviewDialog
          object={object}
          mode={reviewMode}
          onClose={() => setReviewMode(null)}
          onDone={(message) => {
            setReviewMode(null);
            onNotify(message);
            router.refresh();
          }}
        />
      ) : null}
    </section>
  );
}

function ValuePanel({
  object,
  onNotify,
}: {
  object: BusinessObject;
  onNotify: (message: string) => void;
}) {
  const router = useRouter();
  const idPrefix = useId();
  const listId = `${idPrefix}-dimensions`;

  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockPending, setLockPending] = useState(false);
  const [history, setHistory] = useState<ValueHistoryItem[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyId = `${idPrefix}-history`;

  const level = readValueLevel(object);
  const badge = valueBadge(object);
  const scores = object.valueScores;
  const dimensions = Array.isArray(scores?.dimensions) ? scores.dimensions : [];
  const locked = object.valueLevelLocked;

  // 评估历史只在面板挂载时取一次；数量要显示在折叠按钮上，所以不等展开再请求。
  useEffect(() => {
    let alive = true;

    fetch(`/api/objects/${object.id}/value-history?limit=20`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { items?: ValueHistoryItem[] } | null) => {
        if (!alive || !Array.isArray(data?.items)) return;
        setHistory(data.items);
      })
      .catch(() => {
        // 历史取不到不影响面板其它信息，静默留白。
      });

    return () => {
      alive = false;
    };
  }, [object.id]);

  async function reassess() {
    if (pending) return;
    setPending(true);
    setError(null);

    try {
      await apiRequest(`/api/objects/${object.id}/value-assess`, jsonBodyInit({}));
      onNotify("已重新评估");
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  /** 锁定后自动升降级跳过这条资产；解锁立即恢复。 */
  async function toggleLock() {
    if (lockPending) return;
    setLockPending(true);
    setError(null);

    try {
      const result = await apiRequest<{ object: BusinessObject }>(
        `/api/objects/${object.id}/value-lock`,
        jsonBodyInit({ locked: !locked }),
      );
      onNotify(
        result.object.valueLevelLocked
          ? "已锁定等级，自动升降级会跳过这条资产"
          : "已解锁，自动升降级恢复",
      );
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause));
    } finally {
      setLockPending(false);
    }
  }

  return (
    <section className="panel lifecycle-panel" aria-labelledby={`${idPrefix}-heading`}>
      <header className="lifecycle-head">
        <div className="lifecycle-head-copy">
          <h2 id={`${idPrefix}-heading`}>价值评估</h2>
          <p>进入内库后按五个维度评估，划分为 S / A / B / C 四级。</p>
        </div>
        <div className="lifecycle-toolbar">
          {badge ? <Badge badge={badge} /> : <span className="lifecycle-badge is-muted">未评估</span>}
          {locked ? <span className="lifecycle-badge is-info">已锁定</span> : null}
          <button
            className="chip-button"
            type="button"
            disabled={pending || lockPending}
            onClick={() => void toggleLock()}
            aria-pressed={locked}
          >
            <Icon name="lock" size={13} />
            {lockPending ? "处理中…" : locked ? "解锁等级" : "锁定等级"}
          </button>
          <button
            className="chip-button"
            type="button"
            disabled={pending || lockPending}
            onClick={() => void reassess()}
          >
            {pending ? "评估中…" : "重新评估"}
          </button>
        </div>
      </header>

      <div className="lifecycle-body">
        {error ? (
          <div className="form-alert" role="alert">
            <Icon name="alert" size={16} />
            <p>{error}</p>
          </div>
        ) : null}

        <div className="lifecycle-summary">
          <span className={`lifecycle-level is-${level ? level.toLowerCase() : "none"}`}>
            {level ?? "—"}
          </span>
          <span className="lifecycle-verdict">
            {level ? valueLevelDescriptions[level] : "还没有价值等级，运行一次评估即可生成"}
            {locked ? "（已锁定，自动升降级不会改动）" : ""}
          </span>
        </div>

        <p className="lifecycle-meta">
          {object.useCount > 0 ? `使用 ${object.useCount} 次` : "尚未使用"}
          {object.lastUsedAt ? ` · 最近 ${formatDateTime(object.lastUsedAt)}` : ""}
          {scores?.assessedAt ? ` · 评估于 ${formatDateTime(scores.assessedAt)}` : ""}
        </p>

        {dimensions.length > 0 ? (
          <>
            <button
              className="text-button lifecycle-toggle"
              type="button"
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setExpanded((value) => !value)}
            >
              <Icon name="arrow-right" size={13} />
              {expanded ? "收起五维得分" : "查看五维得分与理由"}
            </button>
            {expanded ? (
              <DimensionList id={listId} dimensions={dimensions} kind="value" max={5} />
            ) : null}
          </>
        ) : (
          <p className="lifecycle-hint">评估后会列出五个维度的得分与理由，作为升降级依据。</p>
        )}

        {history && history.length > 0 ? (
          <div className="value-history">
            <button
              className="text-button lifecycle-toggle"
              type="button"
              aria-expanded={historyOpen}
              aria-controls={historyId}
              onClick={() => setHistoryOpen((value) => !value)}
            >
              <Icon name="arrow-right" size={13} />
              {historyOpen ? "收起评估历史" : `评估历史（${history.length}）`}
            </button>
            {historyOpen ? (
              <ol className="value-timeline" id={historyId}>
                {history.map((item) => (
                  <li className="value-timeline-item" key={item.id}>
                    <span className="value-timeline-dot" aria-hidden="true" />
                    <div className="value-timeline-body">
                      <div className="value-timeline-head">
                        <span className="value-timeline-trigger">
                          {valueTriggerLabels[item.trigger] ?? item.trigger}
                        </span>
                        <span className="value-timeline-level">
                          {item.prevLevel ? `${item.prevLevel} → ` : ""}
                          {item.valueLevel}
                        </span>
                        <time className="value-timeline-time" dateTime={item.assessedAt}>
                          {formatDateTime(item.assessedAt)}
                        </time>
                      </div>
                      {item.reason ? (
                        <p className="value-timeline-reason">{item.reason}</p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * 提示条挂在两种面板之上：通过复核会让外库资产变成内库资产，
 * 面板本身会被替换，提示条留在外层才不会跟着消失。
 */
export function AssetInsights({ object }: { object: BusinessObject }) {
  const [toast, setToast] = useToast();

  if (object.type !== "asset") return null;

  return (
    <>
      {object.library === "external" ? (
        <AiScorePanel object={object} onNotify={setToast} />
      ) : (
        <ValuePanel object={object} onNotify={setToast} />
      )}
      {toast ? (
        <div className="toast" role="status">
          <Icon name="check" size={16} />
          {toast}
        </div>
      ) : null}
    </>
  );
}
