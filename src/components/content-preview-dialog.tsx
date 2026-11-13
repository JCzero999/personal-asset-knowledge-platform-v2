"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type MouseEvent, type RefObject } from "react";

import type { ContentRef } from "@/domain/content-ref";
import type { BusinessObject } from "@/domain/objects";
import { callJson } from "@/lib/api-fetch";
import {
  formatDateTime,
  formatFileSize,
  isParsePending,
  parseStatusLabels,
  parseStatusTones,
} from "@/lib/content-format";
import {
  contentUrl,
  describeParseError,
  PREVIEW_TEXT_LIMIT_BYTES,
  previewKind,
  sortPreviewRefs,
  type PreviewKind,
} from "@/lib/content-preview";
import { libraryLabels, objectTypeLabels } from "@/lib/object-labels";
import { Icon } from "./icon";
import { MarkdownPreview } from "./markdown-preview";

/**
 * 作品 / 资产内容预览弹窗（ADR-026 / 19_DESIGN_LLM_PREVIEW §3）。
 *
 * 原生 `<dialog>` 负责焦点圈定、Esc 关闭与滚动锁定；本组件只决定「渲染什么」。
 * PDF 走 `?inline=1`，后端还没支持时先探一次响应头再降级为下载卡片，
 * 避免用户对着空白 iframe 猜发生了什么。
 */

export interface PreviewTarget {
  objectId: string;
  refId: string | null;
  /** 来源行的详情链接（带当前筛选）；深链打开时没有。 */
  detailHref?: string;
}

interface TextState {
  status: "loading" | "ready" | "error";
  content: string;
  truncated: boolean;
  message: string | null;
}

interface PdfState {
  status: "probing" | "inline" | "download" | "error";
  message: string | null;
}

const LOADING_TEXT: TextState = { status: "loading", content: "", truncated: false, message: null };
const PROBING_PDF: PdfState = { status: "probing", message: null };

/**
 * 正文与 PDF 的状态跟「哪个文件」绑定：换文件时按 refId 判定为「还没读」，
 * 不在 effect 里手工清空，渲染期推导即可。
 */
interface RefSlice<T> {
  id: string;
  state: T;
}

function chooseInitialRef(refs: ContentRef[], wanted: string | null): ContentRef | null {
  if (wanted) {
    const match = refs.find((ref) => ref.id === wanted);
    if (match) return match;
  }
  return (
    refs.find((ref) => ref.role === "primary")
    ?? refs[0]
    ?? null
  );
}

function StatusDot({ refItem }: { refItem: ContentRef }) {
  return (
    <span
      className={`preview-dot is-${parseStatusTones[refItem.parseStatus]}`}
      title={parseStatusLabels[refItem.parseStatus]}
      aria-hidden="true"
    />
  );
}

export function ContentPreviewDialog({
  target,
  onClose,
  onDismiss,
}: {
  target: PreviewTarget | null;
  /** 关闭弹窗（Esc / 关闭按钮）：由父级决定是否回退历史。 */
  onClose: () => void;
  /** 去详情等导航动作前的收尾：只清参数，不回退。 */
  onDismiss: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  /** 由 props 变化（去详情）关掉的弹窗，不再回报 onClose——否则会触发一次多余的历史回退。 */
  const suppressCloseRef = useRef(false);

  // 打开 / 关闭：dialog 元素只挂一个实例；内容按对象重新挂载，
  // 换对象时不会残留上一条的正文或解析状态。
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (target && !dialog.open) {
      restoreFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    } else if (!target && dialog.open) {
      suppressCloseRef.current = true;
      dialog.close();
    }
  }, [target]);

  return (
    <dialog
      ref={dialogRef}
      className="dialog dialog-preview"
      aria-labelledby="preview-title"
      onClose={() => {
        // 程序性关闭（去详情）：焦点交给即将到达的页面，也不回报 onClose。
        if (suppressCloseRef.current) {
          suppressCloseRef.current = false;
          return;
        }
        restoreFocusRef.current?.focus();
        onClose();
      }}
    >
      {target ? (
        <PreviewSheet
          key={`${target.objectId}:${target.refId ?? ""}`}
          target={target}
          onClose={onClose}
          onDismiss={onDismiss}
          closeButtonRef={closeButtonRef}
        />
      ) : null}
    </dialog>
  );
}

function PreviewSheet({
  target,
  onClose,
  onDismiss,
  closeButtonRef,
}: {
  target: PreviewTarget;
  onClose: () => void;
  onDismiss: () => void;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const router = useRouter();
  const [object, setObject] = useState<BusinessObject | null>(null);
  const [refs, setRefs] = useState<ContentRef[] | null>(null);
  const [selected, setSelected] = useState<ContentRef | null>(null);
  const [loadError, setLoadError] = useState<{ message: string; notFound: boolean } | null>(null);
  const [textSlice, setTextSlice] = useState<RefSlice<TextState>>({ id: "", state: LOADING_TEXT });
  const [pdfSlice, setPdfSlice] = useState<RefSlice<PdfState>>({ id: "", state: PROBING_PDF });

  // 读对象与文件列表。
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const [objectResult, refsResult] = await Promise.all([
        callJson<BusinessObject>(`/api/objects/${encodeURIComponent(target.objectId)}`),
        callJson<ContentRef[]>(`/api/objects/${encodeURIComponent(target.objectId)}/content`),
      ]);
      if (cancelled) return;

      if (!objectResult.ok) {
        setLoadError({
          message:
            objectResult.status === 404
              ? "这个作品已经不在内容库里了。"
              : objectResult.unavailable
                ? "内容服务暂时没有响应。"
                : objectResult.message,
          notFound: objectResult.status === 404,
        });
        return;
      }

      const list = refsResult.ok ? sortPreviewRefs(refsResult.data) : [];
      setObject(objectResult.data);
      setRefs(list);
      setSelected(chooseInitialRef(list, target.refId));
    })();

    return () => {
      cancelled = true;
    };
  }, [target.objectId, target.refId]);

  // 解析状态轮询：只刷新文件列表，不重挂 PDF iframe、不丢滚动位置。
  const parsePending = (refs ?? []).some((ref) => isParsePending(ref.parseStatus));

  useEffect(() => {
    if (!parsePending) return;

    let ticks = 0;
    const timer = window.setInterval(() => {
      ticks += 1;
      if (ticks > 60) {
        window.clearInterval(timer);
        return;
      }
      void (async () => {
        const result = await callJson<ContentRef[]>(
          `/api/objects/${encodeURIComponent(target.objectId)}/content`,
        );
        if (result.ok) setRefs(sortPreviewRefs(result.data));
      })();
    }, 5000);

    return () => window.clearInterval(timer);
  }, [target.objectId, parsePending]);

  // 文本 / Markdown：截断在 512 KB，超限时带 Range 只取头部。
  useEffect(() => {
    if (!object || !selected) return;

    const kind = previewKind(selected);
    if (kind !== "text" && kind !== "markdown") return;

    let cancelled = false;
    const refId = selected.id;
    const limited = (selected.sizeBytes ?? 0) > PREVIEW_TEXT_LIMIT_BYTES;

    void (async () => {
      try {
        const response = await fetch(contentUrl(object.id, refId), {
          cache: "no-store",
          headers: limited ? { Range: `bytes=0-${PREVIEW_TEXT_LIMIT_BYTES - 1}` } : {},
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const raw = await response.text();
        if (cancelled) return;
        setTextSlice({
          id: refId,
          state: {
            status: "ready",
            content: raw.slice(0, PREVIEW_TEXT_LIMIT_BYTES),
            truncated: limited,
            message: null,
          },
        });
      } catch {
        if (cancelled) return;
        setTextSlice({
          id: refId,
          state: {
            status: "error",
            content: "",
            truncated: false,
            message: "正文读取失败。可以先下载原文查看。",
          },
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [object, selected]);

  // PDF：先探一次响应头，`attachment` 说明后端还没支持内嵌。
  useEffect(() => {
    if (!object || !selected) return;
    if (previewKind(selected) !== "pdf") return;

    let cancelled = false;
    const refId = selected.id;

    void (async () => {
      try {
        const response = await fetch(contentUrl(object.id, refId, true), {
          cache: "no-store",
          headers: { Range: "bytes=0-0" },
        });
        await response.body?.cancel();

        if (cancelled) return;
        if (!response.ok) {
          setPdfSlice({
            id: refId,
            state: {
              status: "error",
              message:
                response.status === 404
                  ? "这个文件已经不在内容库里了。"
                  : `读取文件失败（HTTP ${response.status}）。`,
            },
          });
          return;
        }

        const disposition = (response.headers.get("content-disposition") ?? "").toLowerCase();
        setPdfSlice({
          id: refId,
          state: {
            status: disposition.startsWith("attachment") ? "download" : "inline",
            message: null,
          },
        });
      } catch {
        if (!cancelled) {
          setPdfSlice({ id: refId, state: { status: "download", message: null } });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [object, selected]);

  function moveSelection(delta: number) {
    if (!refs || refs.length < 2 || !selected) return;
    const index = refs.findIndex((ref) => ref.id === selected.id);
    if (index < 0) return;
    const next = refs[Math.min(refs.length - 1, Math.max(0, index + delta))];
    if (next && next.id !== selected.id) setSelected(next);
  }

  const liveRef = refs?.find((ref) => ref.id === selected?.id) ?? selected;
  const parseError = liveRef ? describeParseError(liveRef.parseError) : null;
  const showToolbar = (refs?.length ?? 0) > 1;
  const detailHref = object ? target.detailHref ?? `/workspace/${object.id}` : "#";

  // 换文件后、正文/探测结果回来之前，一律按「加载中」显示。
  const text: TextState = selected && textSlice.id === selected.id ? textSlice.state : LOADING_TEXT;
  const pdf: PdfState = selected && pdfSlice.id === selected.id ? pdfSlice.state : PROBING_PDF;

  /**
   * 「打开详情」：先清掉 `?preview`，再交给 router 导航。
   *
   * 不能只用 <Link> 加 onClick 收尾——收尾会同步卸载弹窗，锚点从 DOM 移除后
   * 浏览器会取消默认导航，表现就是「点了没反应」。修饰键点击仍走链接默认行为
   * （新标签打开详情），此时不需要收尾。
   */
  const openDetail = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onDismiss();
    router.push(detailHref);
  };

  return (
    <div
      className="preview-shell"
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        const tag = (event.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        event.preventDefault();
        moveSelection(event.key === "ArrowRight" ? 1 : -1);
      }}
    >
      <header className="preview-head">
        <div className="preview-title-block">
          {object ? (
            <span
              className={`object-type-icon preview-type-icon ${object.type}`}
              aria-hidden="true"
            >
              <Icon name={object.type === "work" ? "workflow" : "archive"} size={18} />
            </span>
          ) : null}

          <div className="preview-title-text">
            {object ? (
              <>
                <h2 id="preview-title" title={object.title}>{object.title}</h2>
                <p className="preview-meta">
                  {objectTypeLabels[object.type]} · {libraryLabels[object.library]} ·{" "}
                  {formatDateTime(object.updatedAt)} · {refs?.length ?? 0} 个文件
                  {object.archivedAt ? <span className="badge badge-archived">已归档</span> : null}
                </p>
              </>
            ) : (
              <>
                <h2 id="preview-title" className="sr-only">内容预览</h2>
                <span className="skeleton skeleton-line preview-skeleton-title" />
                <span className="skeleton skeleton-line preview-skeleton-meta" />
              </>
            )}
          </div>
        </div>

        <div className="preview-head-actions">
          {liveRef ? (
            <a
              className="btn btn-ghost preview-action"
              href={contentUrl(target.objectId, liveRef.id)}
              title={`下载 ${liveRef.documentName ?? "内容文件"}`}
              aria-label={`下载 ${liveRef.documentName ?? "内容文件"}`}
            >
              <Icon name="download" size={15} />
              <span className="preview-action-label">下载</span>
            </a>
          ) : null}
          {object ? (
            <Link
              className="btn btn-secondary preview-action"
              href={detailHref}
              onClick={openDetail}
              aria-label="打开详情"
            >
              <span className="preview-action-label">打开详情</span>
              <Icon name="arrow-right" size={15} />
            </Link>
          ) : null}
          <button
            ref={closeButtonRef}
            className="icon-button preview-close"
            type="button"
            aria-label="关闭预览"
            onClick={onClose}
          >
            <Icon name="x" size={18} />
          </button>
        </div>
      </header>

      {showToolbar ? (
        <div className="preview-toolbar" role="tablist" aria-label="内容文件">
          {refs?.map((ref) => {
            const active = ref.id === selected?.id;
            return (
              <button
                className={`preview-file${active ? " is-active" : ""}`}
                key={ref.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setSelected(ref)}
              >
                <StatusDot refItem={ref} />
                <span className="preview-file-name">
                  {ref.role === "primary" ? "主内容" : ref.documentName ?? "附件"}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {liveRef && isParsePending(liveRef.parseStatus) ? (
        <p className="preview-banner is-info" role="status">
          <span className="spinner" aria-hidden="true" />
          正在解析，完成后可在检索与图谱里找到。正文现在也能看。
        </p>
      ) : null}

      {liveRef && liveRef.parseStatus === "failed" ? (
        <p className="preview-banner is-error" role="alert">
          <Icon name="alert" size={14} />
          <span>
            解析失败：{parseError?.headline}
            {parseError?.detail ? <em>{parseError.detail}</em> : null}
          </span>
        </p>
      ) : null}

      <div className="preview-body">
        <div className="preview-stage">
          <PreviewStage
            objectId={target.objectId}
            objectLoaded={object !== null}
            refsLoaded={refs !== null}
            loadError={loadError}
            selected={selected}
            text={text}
            pdf={pdf}
            detailHref={detailHref}
            onOpenDetail={openDetail}
          />
        </div>

        {refs && refs.length > 0 ? (
          <aside className="preview-rail" aria-label="全部文件">
            <p className="preview-rail-title">全部文件</p>
            <ul className="preview-rail-list">
              {refs.map((ref) => {
                const active = ref.id === selected?.id;
                return (
                  <li key={ref.id}>
                    <button
                      className={`preview-rail-item${active ? " is-active" : ""}`}
                      type="button"
                      onClick={() => setSelected(ref)}
                      aria-current={active ? "true" : undefined}
                    >
                      <span className="preview-rail-name">
                        <StatusDot refItem={ref} />
                        <span>{ref.documentName ?? (ref.role === "primary" ? "主内容" : "附件")}</span>
                      </span>
                      <span className="preview-rail-meta">
                        {parseStatusLabels[ref.parseStatus]} · {formatFileSize(ref.sizeBytes)}
                      </span>
                    </button>
                    <a
                      className="preview-rail-download"
                      href={contentUrl(target.objectId, ref.id)}
                      aria-label={`下载 ${ref.documentName ?? "内容文件"}`}
                      title={`下载 ${ref.documentName ?? "内容文件"}`}
                    >
                      <Icon name="download" size={14} />
                    </a>
                  </li>
                );
              })}
            </ul>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function PreviewStage({
  objectId,
  objectLoaded,
  refsLoaded,
  loadError,
  selected,
  text,
  pdf,
  detailHref,
  onOpenDetail,
}: {
  objectId: string;
  objectLoaded: boolean;
  refsLoaded: boolean;
  loadError: { message: string; notFound: boolean } | null;
  selected: ContentRef | null;
  text: TextState;
  pdf: PdfState;
  detailHref: string;
  onOpenDetail: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  if (loadError) {
    return (
      <div className="preview-error" role="alert">
        <Icon name="alert" size={22} />
        <strong>{loadError.message}</strong>
        <p>
          {loadError.notFound
            ? "可能是链接失效，或这条内容已被删除。"
            : "网络或服务端暂时不可用，稍后再试一次。"}
        </p>
        <div className="preview-error-actions">
          <Link className="btn btn-secondary" href={detailHref} onClick={onOpenDetail}>
            打开详情
          </Link>
          <button className="btn btn-ghost" type="button" onClick={() => window.location.reload()}>
            <Icon name="refresh" size={15} />
            重新加载
          </button>
        </div>
      </div>
    );
  }

  if (!objectLoaded || !refsLoaded) {
    return (
      <div className="preview-loading" aria-busy="true">
        <span className="spinner" aria-hidden="true" />
        正在打开…
      </div>
    );
  }

  if (!selected) {
    return (
      <div className="empty-state preview-empty">
        <span className="empty-icon"><Icon name="file" size={26} /></span>
        <div className="empty-copy">
          <strong>这个作品还没有内容文件</strong>
          <p>上传原文后，这里会直接显示正文。</p>
        </div>
        <Link className="btn btn-primary empty-action" href={detailHref} onClick={onOpenDetail}>
          去详情上传
        </Link>
      </div>
    );
  }

  const kind: PreviewKind = previewKind(selected);
  const name = selected.documentName ?? "内容文件";

  if (kind === "pdf") {
    if (pdf.status === "probing") {
      return (
        <div className="preview-loading" aria-busy="true">
          <span className="spinner" aria-hidden="true" />
          正在载入 PDF…
        </div>
      );
    }
    if (pdf.status === "inline") {
      return (
        <iframe
          className="preview-frame"
          src={contentUrl(objectId, selected.id, true)}
          title={name}
        />
      );
    }
    if (pdf.status === "error") {
      return (
        <div className="preview-error" role="alert">
          <Icon name="alert" size={22} />
          <strong>{pdf.message}</strong>
          <a className="btn btn-secondary" href={contentUrl(objectId, selected.id)}>
            下载原文
          </a>
        </div>
      );
    }
    return (
      <div className="preview-filecard">
        <span className="preview-filecard-icon"><Icon name="file" size={26} /></span>
        <strong>{name}</strong>
        <p>这个浏览器里暂时不能内嵌 PDF。下载后用本地阅读器打开，阅读体验更好。</p>
        <a className="btn btn-secondary" href={contentUrl(objectId, selected.id)}>
          <Icon name="download" size={15} />
          下载原文
        </a>
      </div>
    );
  }

  if (kind === "image") {
    return (
      // 图片自带的白底在深色主题下是预期行为，不套滤镜。
      // 走同源内容接口的原图，不接 next/image 的优化服务。
      // eslint-disable-next-line @next/next/no-img-element
      <img
        className="preview-media"
        src={contentUrl(objectId, selected.id)}
        alt={name}
        loading="lazy"
      />
    );
  }

  if (kind === "markdown" || kind === "text") {
    if (text.status === "loading") {
      return (
        <div className="preview-loading" aria-busy="true">
          <span className="spinner" aria-hidden="true" />
          正在读取正文…
        </div>
      );
    }
    if (text.status === "error") {
      return (
        <div className="preview-error" role="alert">
          <Icon name="alert" size={22} />
          <strong>{text.message}</strong>
          <a className="btn btn-secondary" href={contentUrl(objectId, selected.id)}>
            下载原文
          </a>
        </div>
      );
    }

    return (
      <div className="preview-doc">
        {kind === "markdown" ? (
          <div className="preview-markdown">
            <MarkdownPreview text={text.content} />
          </div>
        ) : (
          <pre className="preview-text">{text.content}</pre>
        )}
        {text.truncated ? (
          <p className="preview-truncated">
            文件较大，预览已截断（显示前 512 KB）。
            <a className="text-button" href={contentUrl(objectId, selected.id)}>下载全文</a>
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="preview-filecard">
      <span className="preview-filecard-icon"><Icon name="file" size={26} /></span>
      <strong>{name}</strong>
      <p>这类文件不能在页面里直接看，下载后用对应软件打开。</p>
      <a className="btn btn-secondary" href={contentUrl(objectId, selected.id)}>
        <Icon name="download" size={15} />
        下载原文
      </a>
    </div>
  );
}
