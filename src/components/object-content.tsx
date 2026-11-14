"use client";

import { useEffect, useId, useRef, useState, useTransition, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";

import type { ContentRef, ContentRole } from "@/domain/content-ref";
import { apiErrorMessage, apiRequest } from "@/lib/api-client";
import {
  formatDateTime,
  formatFileSize,
  isEditableTextContent,
  isParsePending,
  MAX_UPLOAD_BYTES,
  parseStatusLabels,
  parseStatusTones,
} from "@/lib/content-format";
import { contentRoleLabels } from "@/lib/object-labels";
import { reportAssetUsage } from "./asset-usage";
import { ContentEditor } from "./content-editor";
import { Icon } from "./icon";

/**
 * 对象的内容区：列出内容引用、下载原文、上传主内容 / 附件，以及直接编写正文。
 *
 * 上传成功后只刷新服务端数据；解析状态停在 pending / running 时
 * 每 5 秒自动 `router.refresh()`，让「解析中」最终能变成「已解析」。
 */
export function ObjectContent({
  objectId,
  objectTitle,
  refs,
  usageObjectId = null,
}: {
  objectId: string;
  objectTitle: string;
  refs: ContentRef[];
  /** 资产的 id：打开原文 / 复制正文时上报有效调用；作品传 null。 */
  usageObjectId?: string | null;
}) {
  const router = useRouter();
  const idPrefix = useId();
  const primaryInputRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);

  const [uploading, setUploading] = useState<ContentRole | null>(null);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const [editor, setEditor] = useState<{
    existing: ContentRef | null;
    replacing: boolean;
  } | null>(null);

  const primaryRef = refs.find((ref) => ref.role === "primary") ?? null;
  const hasPrimary = primaryRef !== null;
  const parsing = refs.some((ref) => isParsePending(ref.parseStatus));
  const busy = uploading !== null;

  useEffect(() => {
    if (!parsing) return;

    let ticks = 0;
    const timer = window.setInterval(() => {
      ticks += 1;
      if (ticks > 60) {
        window.clearInterval(timer);
        return;
      }
      router.refresh();
    }, 5000);

    return () => window.clearInterval(timer);
  }, [parsing, router]);

  useEffect(() => {
    if (!toast) return;

    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function upload(file: File, role: ContentRole) {
    if (busy) return;

    if (file.size === 0) {
      setError("文件是空的，换一个再试。");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`文件不能超过 ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB。`);
      return;
    }

    setUploading(role);
    setError(null);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("role", role);

    try {
      await apiRequest<ContentRef>(`/api/objects/${objectId}/content`, {
        method: "POST",
        body: formData,
      });
      setToast(
        role === "primary"
          ? "主内容已上传，解析完成后就可以被检索。"
          : "附件已上传，解析完成后就可以被检索。",
      );
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause));
    } finally {
      setUploading(null);
      if (primaryInputRef.current) primaryInputRef.current.value = "";
      if (attachmentInputRef.current) attachmentInputRef.current.value = "";
    }
  }

  function pick(event: ChangeEvent<HTMLInputElement>, role: ContentRole) {
    const file = event.target.files?.[0];
    if (file) void upload(file, role);
  }

  /**
   * 「编写正文」入口：已有文本主内容时直接编辑原文（避免空白编辑区
   * 一保存就把旧正文冲掉）；主内容是二进制时只能新建，保存即替换。
   */
  function openEditor() {
    setEditor({
      existing: primaryRef && isEditableTextContent(primaryRef) ? primaryRef : null,
      replacing: hasPrimary,
    });
  }

  /** 复制主内容全文：成功即算一次有效调用（`copy`）。 */
  async function copyPrimary(ref: ContentRef) {
    if (copying) return;
    setCopying(true);
    setError(null);

    try {
      const response = await fetch(`/api/objects/${objectId}/content/${ref.id}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("读取失败");
      await navigator.clipboard.writeText(await response.text());
      setToast("已复制全文，可以直接粘贴使用。");
      if (usageObjectId) void reportAssetUsage(usageObjectId, "copy");
    } catch {
      setError("复制失败，可以点「查看原文」在新标签里手动选择。");
    } finally {
      setCopying(false);
    }
  }

  return (
    <>
      <div className="content-toolbar">
        <p className="content-hint">
          主内容用于检索，同类型再次上传会替换旧文件，也可以直接编写正文；附件会一直挂在这个对象下。
        </p>
        <div className="upload-actions">
          <button
            className="btn btn-secondary"
            type="button"
            disabled={busy}
            onClick={openEditor}
          >
            <Icon name="edit" size={16} />
            编写正文
          </button>
          <button
            className="btn btn-primary"
            type="button"
            disabled={busy}
            onClick={() => primaryInputRef.current?.click()}
          >
            {uploading === "primary" ? (
              <span className="spinner" aria-hidden="true" />
            ) : (
              <Icon name="upload" size={16} />
            )}
            {uploading === "primary"
              ? "上传中…"
              : hasPrimary ? "替换主内容" : "上传主内容"}
          </button>
          <button
            className="btn btn-secondary"
            type="button"
            disabled={busy}
            onClick={() => attachmentInputRef.current?.click()}
          >
            {uploading === "attachment" ? (
              <span className="spinner spinner-dark" aria-hidden="true" />
            ) : (
              <Icon name="plus" size={16} />
            )}
            {uploading === "attachment" ? "上传中…" : "添加附件"}
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            disabled={refreshing}
            onClick={() => startRefresh(() => router.refresh())}
          >
            <Icon name="refresh" size={15} />
            {refreshing ? "刷新中…" : "刷新状态"}
          </button>
        </div>

        <input
          ref={primaryInputRef}
          id={`${idPrefix}-primary`}
          type="file"
          hidden
          aria-label="选择主内容文件"
          onChange={(event) => pick(event, "primary")}
        />
        <input
          ref={attachmentInputRef}
          id={`${idPrefix}-attachment`}
          type="file"
          hidden
          aria-label="选择附件文件"
          onChange={(event) => pick(event, "attachment")}
        />
      </div>

      {error ? (
        <div className="form-alert content-alert" role="alert">
          <Icon name="alert" size={16} />
          <p>{error}</p>
        </div>
      ) : null}

      {parsing ? (
        <div className="content-notice" role="status">
          <span className="spinner spinner-dark" aria-hidden="true" />
          有文件正在解析，页面会每 5 秒自动刷新状态。
        </div>
      ) : null}

      {refs.length === 0 ? (
        <div className="empty-state content-empty">
          <span className="empty-icon"><Icon name="file" size={26} /></span>
          <div className="empty-copy">
            <strong>还没有内容文件</strong>
            <p>上传主内容后，解析完成就能被检索；附件也会随对象一起保存。</p>
          </div>
          <button
            className="btn btn-primary empty-action"
            type="button"
            disabled={busy}
            onClick={() => primaryInputRef.current?.click()}
          >
            上传第一条
          </button>
        </div>
      ) : (
        <ul className="content-list">
          {refs.map((ref) => {
            const tone = parseStatusTones[ref.parseStatus];
            const pending = isParsePending(ref.parseStatus);

            return (
              <li className="content-row" key={ref.id}>
                <span className="content-icon" aria-hidden="true">
                  <Icon name="file" size={18} />
                </span>

                <div className="content-main">
                  <div className="content-name-row">
                    <strong className="content-name">
                      {ref.documentName ?? "未命名内容"}
                    </strong>
                    <span className={`status-badge ${tone}`}>
                      {parseStatusLabels[ref.parseStatus]}
                    </span>
                    <span className="badge">{contentRoleLabels[ref.role]}</span>
                  </div>

                  <small className="content-meta">
                    {formatFileSize(ref.sizeBytes)}
                    {" · "}
                    {ref.mime ?? "未知类型"}
                    {" · 更新于 "}
                    {formatDateTime(ref.updatedAt)}
                  </small>

                  {pending ? (
                    <small className="content-parse-note">
                      解析完成后这段内容就能被检索，通常只需要几十秒。
                    </small>
                  ) : null}

                  {ref.parseError ? (
                    <p className="content-error">
                      <Icon name="alert" size={14} />
                      <span>{ref.parseError}</span>
                    </p>
                  ) : null}
                </div>

                <div className="content-actions">
                  {ref.role === "primary" ? (
                    <a
                      className="btn btn-ghost content-download"
                      href={`/api/objects/${objectId}/content/${ref.id}`}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`在新标签查看 ${ref.documentName ?? "主内容"}`}
                      onClick={() => {
                        if (usageObjectId) void reportAssetUsage(usageObjectId, "open_source");
                      }}
                    >
                      <Icon name="eye" size={15} />
                      查看原文
                    </a>
                  ) : null}

                  {ref.role === "primary" && isEditableTextContent(ref) ? (
                    <button
                      className="btn btn-ghost content-download"
                      type="button"
                      disabled={busy || copying}
                      onClick={() => void copyPrimary(ref)}
                    >
                      <Icon name="copy" size={15} />
                      {copying ? "复制中…" : "复制"}
                    </button>
                  ) : null}

                  {ref.role === "primary" && isEditableTextContent(ref) ? (
                    <button
                      className="btn btn-ghost content-download"
                      type="button"
                      disabled={busy}
                      onClick={() => setEditor({ existing: ref, replacing: true })}
                      aria-label={`编辑 ${ref.documentName ?? "主内容"} 的正文`}
                    >
                      <Icon name="edit" size={15} />
                      编辑
                    </button>
                  ) : null}

                  <a
                    className="btn btn-secondary content-download"
                    href={`/api/objects/${objectId}/content/${ref.id}`}
                    aria-label={`下载 ${ref.documentName ?? "内容文件"}`}
                  >
                    <Icon name="download" size={15} />
                    下载
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {toast ? (
        <div className="toast" role="status">
          <Icon name="check" size={16} />
          {toast}
        </div>
      ) : null}

      {editor ? (
        <ContentEditor
          objectId={objectId}
          objectTitle={objectTitle}
          existing={editor.existing}
          replacing={editor.replacing}
          onClose={() => setEditor(null)}
          onSaved={(message) => {
            setEditor(null);
            setToast(message);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}
