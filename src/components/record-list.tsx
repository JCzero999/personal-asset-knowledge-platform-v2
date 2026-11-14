"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { ContentRef } from "@/domain/content-ref";
import { type BusinessObject } from "@/domain/objects";
import { apiErrorMessage, apiRequest, jsonBodyInit } from "@/lib/api-client";
import { isEditableTextContent } from "@/lib/content-format";
import { buildExportMarkdown, exportFileName, type ExportItem } from "@/lib/export-markdown";
import { categoryLabel, type CategoryLabelMap } from "@/lib/category-labels";
import { libraryLabels, statusLabels } from "@/lib/object-labels";
import { Icon } from "./icon";
import { lifecycleBadges } from "./lifecycle";
import { usePreview } from "./preview-provider";

/**
 * 第三列内容列表：行内多选 + 批量归档 / 导出 / 删除。
 *
 * 批量动作复用单条接口（每一项一次请求），不新增批量路由；导出在浏览器里
 * 拼成一份 Markdown，纯文本主内容带上正文，二进制只记文件名。
 */

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatUpdatedAt(iso: string, now: Date): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return iso.slice(0, 10);
  }

  const days = Math.round(
    (startOfDay(now).getTime() - startOfDay(date).getTime()) / 86_400_000,
  );

  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 7) return `${days} 天前`;
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }

  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function downloadTextFile(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type Pending = "archive" | "export" | "delete";

export function RecordList({
  objects,
  selectedId,
  listQuery,
  now,
  empty,
  footnote,
  categoryLabels,
  children,
}: {
  objects: BusinessObject[];
  selectedId: string | null;
  listQuery: string;
  now: Date;
  empty: ReactNode;
  footnote: ReactNode;
  /** 分类 code → 名称，由服务端读词表后传入（ADR-016 / ADR-023：不再有代码常量）。 */
  categoryLabels: CategoryLabelMap;
  /** 筛选条：放在批量操作栏上方，保持「标题 → 筛选 → 批量 → 列表」的顺序。 */
  children: ReactNode;
}) {
  const router = useRouter();
  const preview = usePreview();
  const selectAllRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const [pickedIds, setPickedIds] = useState<string[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  // 刷新后可能少了已删除 / 已归档的条目；直接从当前列表里取交集，
  // 不靠 effect 回写状态，避免多一次渲染。
  const selectedIds = pickedIds.filter((id) => objects.some((object) => object.id === id));
  const hasSelection = selectedIds.length > 0;
  const allSelected = objects.length > 0 && selectedIds.length === objects.length;
  const busy = pending !== null;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = hasSelection && !allSelected;
    }
  }, [hasSelection, allSelected]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (confirming && !dialog.open) dialog.showModal();
    if (!confirming && dialog.open) dialog.close();
  }, [confirming]);

  function toggleOne(id: string) {
    setPickedIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  function toggleAll() {
    setPickedIds(allSelected ? [] : objects.map((object) => object.id));
  }

  async function archiveSelected() {
    if (!hasSelection || busy) return;
    const ids = [...selectedIds];
    setPending("archive");
    setError(null);

    const results = await Promise.allSettled(
      ids.map((id) => apiRequest(`/api/objects/${id}/archive`, jsonBodyInit({ archived: true }))),
    );
    const failed = results.filter((result) => result.status === "rejected").length;

    setPending(null);
    setPickedIds([]);
    if (failed === 0) {
      setToast(`已归档 ${ids.length} 项`);
    } else if (failed === ids.length) {
      const first = results.find((result) => result.status === "rejected");
      setError(first?.status === "rejected" ? apiErrorMessage(first.reason) : "归档失败，请稍后再试。");
    } else {
      setError(`已归档 ${ids.length - failed} 项，${failed} 项失败。`);
    }
    router.refresh();
  }

  async function deleteSelected() {
    if (!hasSelection || busy) return;
    const ids = [...selectedIds];
    setConfirming(false);
    setPending("delete");
    setError(null);

    const results = await Promise.allSettled(
      ids.map((id) => apiRequest(`/api/objects/${id}`, { method: "DELETE" })),
    );
    const failed = results.filter((result) => result.status === "rejected").length;

    setPending(null);
    setPickedIds([]);
    if (failed === 0) {
      setToast(`已删除 ${ids.length} 项`);
    } else if (failed === ids.length) {
      const first = results.find((result) => result.status === "rejected");
      setError(first?.status === "rejected" ? apiErrorMessage(first.reason) : "删除失败，请稍后再试。");
    } else {
      setError(`已删除 ${ids.length - failed} 项，${failed} 项失败。`);
    }

    // 删掉的正好是右栏正在看的那条时，留在原地址会变成「对象不存在」。
    const selectedRemoved =
      selectedId !== null
      && ids.includes(selectedId)
      && results[ids.indexOf(selectedId)]?.status === "fulfilled";
    if (selectedRemoved) {
      router.push(`/workspace${listQuery}`);
    } else {
      router.refresh();
    }
  }

  async function exportSelected() {
    if (!hasSelection || busy) return;
    const ids = [...selectedIds];
    setPending("export");
    setError(null);

    try {
      const items: ExportItem[] = [];

      for (const id of ids) {
        const object = objects.find((item) => item.id === id);
        if (!object) continue;

        const refs = await apiRequest<ContentRef[]>(`/api/objects/${id}/content`, {
          method: "GET",
        }).catch(() => [] as ContentRef[]);
        const primary = refs.find((ref) => ref.role === "primary");
        let content: string | null = null;

        if (primary && isEditableTextContent(primary)) {
          try {
            const response = await fetch(`/api/objects/${id}/content/${primary.id}`, {
              cache: "no-store",
            });
            if (response.ok) content = await response.text();
          } catch {
            content = null;
          }
        }

        items.push({
          object,
          content,
          attachments: refs.filter((ref) => ref.role === "attachment"),
        });
      }

      const exportedAt = new Date();
      downloadTextFile(exportFileName(exportedAt), buildExportMarkdown(items, exportedAt, categoryLabels));
      setToast(`已导出 ${items.length} 项`);
    } catch (cause) {
      setError(apiErrorMessage(cause));
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      {children}

      <div className="record-bulk" aria-label="批量操作">
        <div className="record-bulk-head">
          <label className="bulk-select">
            <input
              ref={selectAllRef}
              type="checkbox"
              checked={allSelected}
              disabled={objects.length === 0 || busy}
              onChange={toggleAll}
            />
            <span>全选</span>
          </label>
          <span className="record-bulk-count" role="status">
            {hasSelection ? `已选 ${selectedIds.length} 项` : "勾选后可批量处理"}
          </span>
        </div>

        <div className="record-bulk-actions">
          <button
            className="btn btn-secondary"
            type="button"
            disabled={!hasSelection || busy}
            onClick={() => void archiveSelected()}
          >
            批量归档
          </button>
          <button
            className="btn btn-secondary"
            type="button"
            disabled={!hasSelection || busy}
            onClick={() => void exportSelected()}
          >
            批量导出
          </button>
          <button
            className="btn btn-ghost is-danger"
            type="button"
            disabled={!hasSelection || busy}
            onClick={() => setConfirming(true)}
          >
            批量删除
          </button>
        </div>

        {error ? (
          <p className="record-bulk-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <div className="record-scroll">
        {objects.length === 0 ? (
          empty
        ) : (
          <ul className="record-rows">
            {objects.map((object) => {
              const isActive = selectedId === object.id;
              const meta = object.type === "work"
                ? `${categoryLabel(categoryLabels, object.category)} · ${statusLabels[object.status]}`
                : libraryLabels[object.library];

              const href = `/workspace/${object.id}${listQuery}`;
              const badges = lifecycleBadges(object);

              return (
                <li className={`record-row-item${isActive ? " is-active" : ""}`} key={object.id}>
                  <span className="record-check">
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(object.id)}
                      aria-label={`选择「${object.title}」`}
                      onChange={() => toggleOne(object.id)}
                    />
                  </span>

                  {/*
                    点击口径：名称 → 预览弹窗；行内其余位置 → 详情页。
                    铺满整行的绝对定位链接负责「其余位置」，名称按钮叠在它上面（z-index 更高）。
                    两者并列而非嵌套，保持 <a> 里不出现交互控件；修饰键点击仍由浏览器
                    按链接默认行为处理（新标签打开详情）。
                  */}
                  <Link
                    className="record-row-link"
                    href={href}
                    scroll={false}
                    aria-current={isActive ? "page" : undefined}
                    aria-label={`打开「${object.title}」详情`}
                  />

                  <div className="record-row">
                    <span className="record-row-title">
                      <span className={`record-dot ${object.type}`} aria-hidden="true" />
                      {preview ? (
                        <button
                          type="button"
                          className="record-title-button"
                          aria-label={`预览「${object.title}」`}
                          title="打开预览"
                          onClick={(event) => {
                            // ⌘/Ctrl + 点标题跳过预览，直接进详情（与行内其余位置一致）。
                            if (event.metaKey || event.ctrlKey) {
                              event.preventDefault();
                              router.push(href);
                              return;
                            }
                            preview.open(object.id, null, href);
                          }}
                        >
                          {object.title}
                        </button>
                      ) : (
                        <span className="record-title-text">{object.title}</span>
                      )}
                    </span>
                    <span className="record-row-meta">
                      <span className="record-meta-line">
                        {badges.map((badge) => (
                          <span className={`record-badge is-${badge.tone}`} key={badge.key}>
                            {badge.label}
                          </span>
                        ))}
                        <span className="record-meta-text">{meta}</span>
                      </span>
                      <time dateTime={object.updatedAt}>
                        {formatUpdatedAt(object.updatedAt, now)}
                      </time>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {footnote}
      </div>

      <dialog
        ref={dialogRef}
        className="dialog dialog-sm"
        aria-labelledby="bulk-delete-heading"
        onClose={() => setConfirming(false)}
        onClick={(event) => {
          if (event.target === dialogRef.current) setConfirming(false);
        }}
      >
        <form
          className="dialog-form"
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            void deleteSelected();
          }}
        >
          <header className="dialog-head">
            <div>
              <h2 id="bulk-delete-heading">批量删除</h2>
              <p>删除后不能恢复。</p>
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
              选中的 {selectedIds.length} 项内容将从工作台移除。
            </p>
          </div>
          <footer className="dialog-actions">
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => setConfirming(false)}
            >
              取消
            </button>
            <button className="btn btn-danger" type="submit">
              删除 {selectedIds.length} 项
            </button>
          </footer>
        </form>
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
