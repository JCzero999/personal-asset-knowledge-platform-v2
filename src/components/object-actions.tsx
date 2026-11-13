"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  priorities,
  type BusinessObject,
  type Library,
  type Priority,
  type WorkStatus,
} from "@/domain/objects";
import type { VocabularyCategory, VocabularyTag } from "@/domain/vocabulary";
import { allowedTransitions } from "@/domain/workflow";
import {
  apiErrorMessage,
  apiRequest,
  jsonBodyInit,
} from "@/lib/api-client";
import { libraryLabels, priorityLabels, statusLabels } from "@/lib/object-labels";
import { CategoryPicker } from "./category-picker";
import { Icon } from "./icon";
import { TagField } from "./tag-field";

type DialogMode = "edit" | "library" | "delete";

/**
 * 单条内容的操作区：状态推进、跨库迁移、归档、编辑、删除。
 *
 * 收起时只露出「下一步」与「更多」两个入口，展开后在行内铺开所有操作，
 * 这样五条列表仍然可以一眼扫读，不变成一排按钮。
 */
export function ObjectActions({
  object,
  categories,
  tagSuggestions,
  canManageVocabulary = false,
}: {
  object: BusinessObject;
  /** 全站分类词表，编辑弹窗与新建弹窗共用。 */
  categories: VocabularyCategory[];
  /** 全站标签词表（按使用次数排序），编辑弹窗与新建弹窗共用。 */
  tagSuggestions: VocabularyTag[];
  /** 管理员可见「管理」入口，是否显示由服务端权限决定。 */
  canManageVocabulary?: boolean;
}) {
  const router = useRouter();
  const idPrefix = useId();
  const panelId = `${idPrefix}-panel`;
  const headingId = `${idPrefix}-dialog-heading`;
  const dialogErrorId = `${idPrefix}-dialog-error`;

  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const [expanded, setExpanded] = useState(false);
  const [dialogMode, setDialogMode] = useState<DialogMode | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [priority, setPriority] = useState<Priority>("medium");
  const [reason, setReason] = useState("");

  const nextStatuses =
    object.type === "work"
      ? allowedTransitions(object.status, { library: object.library })
      : [];
  const nextStatus = nextStatuses[0] ?? null;
  const targetLibrary: Library = object.library === "internal" ? "external" : "internal";
  const busy = pending !== null;

  useEffect(() => {
    if (!dialogMode) return;

    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }

    const target =
      dialogMode === "edit" ? titleRef.current
      : dialogMode === "library" ? reasonRef.current
      : cancelRef.current;
    target?.focus();
  }, [dialogMode]);

  useEffect(() => {
    if (!toast) return;

    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function closeDialog() {
    if (busy) return;
    setDialogMode(null);
    setDialogError(null);
  }

  function openDialog(mode: DialogMode) {
    setDialogError(null);

    if (mode === "edit") {
      setTitle(object.title);
      setDescription(object.description ?? "");
      setCategory(object.category);
      setTags(object.tags);
      setPriority(object.priority);
    }
    if (mode === "library") {
      setReason("");
    }

    setDialogMode(mode);
  }

  async function advance(to: WorkStatus) {
    if (busy) return;
    setPending(`status:${to}`);
    setError(null);

    try {
      await apiRequest(`/api/objects/${object.id}/status`, jsonBodyInit({
        to,
        expectedRevision: object.revision,
      }));
      setExpanded(false);
      setToast(`已推进到「${statusLabels[to]}」`);
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause));
    } finally {
      setPending(null);
    }
  }

  async function toggleArchive() {
    if (busy) return;
    const archived = object.archivedAt !== null;
    setPending("archive");
    setError(null);

    try {
      await apiRequest(`/api/objects/${object.id}/archive`, jsonBodyInit({ archived: !archived }));
      setExpanded(false);
      setToast(archived ? "已取消归档" : "已归档");
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause));
    } finally {
      setPending(null);
    }
  }

  async function submitEdit() {
    if (busy) return;

    if (!title.trim()) {
      setDialogError("标题不能为空。");
      titleRef.current?.focus();
      return;
    }

    if (object.type === "work" && !category) {
      setDialogError("请选择一个分类。");
      return;
    }

    setPending("edit");
    setDialogError(null);

    try {
      await apiRequest(`/api/objects/${object.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() ? description.trim() : null,
          category,
          tags,
          priority,
          expectedRevision: object.revision,
        }),
      });
      setDialogMode(null);
      setToast("已保存修改");
      router.refresh();
    } catch (cause) {
      setDialogError(apiErrorMessage(cause));
    } finally {
      setPending(null);
    }
  }

  async function submitLibrary() {
    if (busy) return;

    if (!reason.trim()) {
      setDialogError("请填写迁移理由，它会随这次变更一起记录。");
      reasonRef.current?.focus();
      return;
    }

    setPending("library");
    setDialogError(null);

    try {
      await apiRequest(`/api/objects/${object.id}/library`, jsonBodyInit({
        to: targetLibrary,
        reason: reason.trim(),
        expectedRevision: object.revision,
      }));
      setDialogMode(null);
      setExpanded(false);
      setToast(`已迁移到${libraryLabels[targetLibrary]}`);
      router.refresh();
    } catch (cause) {
      setDialogError(apiErrorMessage(cause));
    } finally {
      setPending(null);
    }
  }

  async function confirmDelete() {
    if (busy) return;
    setPending("delete");
    setDialogError(null);

    try {
      await apiRequest(`/api/objects/${object.id}`, { method: "DELETE" });
      setDialogMode(null);
      router.refresh();
    } catch (cause) {
      setDialogError(apiErrorMessage(cause));
    } finally {
      setPending(null);
    }
  }

  const heading =
    dialogMode === "edit" ? "编辑内容"
    : dialogMode === "library" ? `迁移到${libraryLabels[targetLibrary]}`
    : "删除这条内容？";

  const subtitle =
    dialogMode === "edit" ? "只改这条内容本身，类型与归属保持不变。"
    : dialogMode === "library"
      ? `当前在${libraryLabels[object.library]}，理由会记录在这次迁移里。`
      : "删除后无法恢复。";

  const submitLabel =
    dialogMode === "edit" ? (busy ? "保存中…" : "保存")
    : dialogMode === "library" ? (busy ? "迁移中…" : "确认迁移")
    : busy ? "删除中…" : "删除";

  return (
    <>
      <div className="object-side">
        {object.archivedAt ? (
          <button
            className="object-step object-undo"
            type="button"
            aria-label={`取消归档「${object.title}」`}
            disabled={busy}
            onClick={toggleArchive}
          >
            {pending === "archive" ? "处理中…" : "取消归档"}
          </button>
        ) : nextStatus ? (
          <button
            className="object-step"
            type="button"
            aria-label={`推进到${statusLabels[nextStatus]}`}
            disabled={busy}
            onClick={() => advance(nextStatus)}
          >
            {pending === `status:${nextStatus}` ? (
              <span>处理中…</span>
            ) : (
              <>
                <Icon name="arrow-right" size={13} />
                <span>{statusLabels[nextStatus]}</span>
              </>
            )}
          </button>
        ) : null}

        <button
          className="icon-button object-more"
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          aria-label={expanded ? "收起操作" : "更多操作"}
          onClick={() => {
            setExpanded((value) => !value);
            setError(null);
          }}
        >
          <Icon name="more" size={18} />
        </button>
      </div>

      {expanded && (
        <div className="object-panel" id={panelId} role="group" aria-label={`${object.title} 的操作`}>
          {error && (
            <div className="form-alert" role="alert">
              <Icon name="alert" size={16} />
              <p>{error}</p>
            </div>
          )}

          {object.type === "work" && (
            <div className="object-panel-line">
              <span className="object-panel-label">状态</span>
              <div className="object-panel-group">
                {nextStatuses.length === 0 ? (
                  <span className="object-panel-note">
                    {object.archivedAt
                      ? "已归档，取消归档后可继续推进"
                      : object.library === "external" && object.status === "published"
                        ? "外库作品不能直接标记为已实践，先迁移到内库"
                        : "已是最后一个阶段"}
                  </span>
                ) : (
                  nextStatuses.map((to) => (
                    <button
                      className="chip-button chip-primary"
                      key={to}
                      type="button"
                      disabled={busy || object.archivedAt !== null}
                      onClick={() => advance(to)}
                    >
                      {pending === `status:${to}` ? "处理中…" : `推进到「${statusLabels[to]}」`}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}

          <div className="object-panel-line">
            <span className="object-panel-label">归属</span>
            <div className="object-panel-group">
              <span className="object-panel-value">{libraryLabels[object.library]}</span>
              <button
                className="chip-button"
                type="button"
                disabled={busy}
                onClick={() => openDialog("library")}
              >
                {pending === "library" ? "迁移中…" : `迁移到${libraryLabels[targetLibrary]}`}
              </button>
            </div>
          </div>

          <div className="object-panel-foot">
            <button className="text-button" type="button" disabled={busy} onClick={() => openDialog("edit")}>
              <Icon name="file" size={14} />
              编辑
            </button>
            <button className="text-button" type="button" disabled={busy} onClick={toggleArchive}>
              {pending === "archive" ? "处理中…" : object.archivedAt ? "取消归档" : "归档"}
            </button>
            <button
              className="text-button text-danger"
              type="button"
              disabled={busy}
              onClick={() => openDialog("delete")}
            >
              删除
            </button>
          </div>
        </div>
      )}

      {dialogMode && (
        <dialog
          ref={dialogRef}
          className={`dialog${dialogMode === "delete" ? " dialog-sm" : ""}`}
          aria-labelledby={headingId}
          onClose={closeDialog}
          onClick={(event) => {
            if (event.target === dialogRef.current) closeDialog();
          }}
        >
          <form
            className="dialog-form"
            aria-busy={busy}
            onSubmit={(event) => {
              event.preventDefault();
              if (dialogMode === "edit") void submitEdit();
              else if (dialogMode === "library") void submitLibrary();
              else void confirmDelete();
            }}
          >
            <header className="dialog-head">
              <div>
                <h2 id={headingId}>{heading}</h2>
                <p>{subtitle}</p>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭"
                disabled={busy}
                onClick={closeDialog}
              >
                <Icon name="x" size={18} />
              </button>
            </header>

            <div className="dialog-body">
              {dialogMode === "delete" ? (
                <p className="dialog-text">「{object.title}」将从工作台移除。</p>
              ) : null}

              {dialogMode === "edit" && (
                <>
                  <div className="field">
                    <label className="field-label" htmlFor={`${idPrefix}-title`}>
                      标题 <span className="field-note">必填</span>
                    </label>
                    <input
                      ref={titleRef}
                      id={`${idPrefix}-title`}
                      className="text-input"
                      type="text"
                      value={title}
                      maxLength={200}
                      aria-invalid={dialogError !== null && !title.trim()}
                      onChange={(event) => {
                        setTitle(event.target.value);
                        if (dialogError) setDialogError(null);
                      }}
                    />
                  </div>

                  <CategoryPicker
                    value={category}
                    onChange={setCategory}
                    categories={categories}
                    allowEmpty={object.type === "asset"}
                    disabled={busy}
                    canManageVocabulary={canManageVocabulary}
                  />

                  <TagField
                    value={tags}
                    onChange={setTags}
                    suggestions={tagSuggestions}
                    disabled={busy}
                  />

                  <div className="field">
                    <label className="field-label" htmlFor={`${idPrefix}-description`}>
                      描述 <span className="field-note">选填</span>
                    </label>
                    <textarea
                      id={`${idPrefix}-description`}
                      className="textarea"
                      rows={3}
                      value={description}
                      maxLength={5000}
                      placeholder="补充用途、来源或下一步计划…"
                      onChange={(event) => setDescription(event.target.value)}
                    />
                  </div>

                  <fieldset className="field">
                    <legend className="field-label">优先级</legend>
                    <div className="format-grid">
                      {priorities.map((item) => (
                        <label
                          className={`format-chip ${priority === item ? "is-active" : ""}`}
                          key={item}
                        >
                          <input
                            className="sr-only"
                            type="radio"
                            name={`${idPrefix}-priority`}
                            value={item}
                            checked={priority === item}
                            onChange={() => setPriority(item)}
                          />
                          {priorityLabels[item]}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </>
              )}

              {dialogMode === "library" && (
                <div className="field">
                  <label className="field-label" htmlFor={`${idPrefix}-reason`}>
                    迁移理由 <span className="field-note">必填</span>
                  </label>
                  <textarea
                    ref={reasonRef}
                    id={`${idPrefix}-reason`}
                    className="textarea"
                    rows={3}
                    value={reason}
                    maxLength={5000}
                    aria-invalid={dialogError !== null && !reason.trim()}
                    aria-describedby={dialogError ? dialogErrorId : undefined}
                    placeholder="例如：来源可靠，转入内库长期复用。"
                    onChange={(event) => {
                      setReason(event.target.value);
                      if (dialogError) setDialogError(null);
                    }}
                  />
                </div>
              )}

              {dialogError && (
                <div className="form-alert" id={dialogErrorId} role="alert">
                  <Icon name="alert" size={17} />
                  <p>{dialogError}</p>
                </div>
              )}
            </div>

            <footer className="dialog-actions">
              <button
                ref={cancelRef}
                className="btn btn-ghost"
                type="button"
                disabled={busy}
                onClick={closeDialog}
              >
                取消
              </button>
              <button
                className={`btn ${dialogMode === "delete" ? "btn-danger" : "btn-primary"}`}
                type="submit"
                disabled={busy}
              >
                {busy && <span className="spinner" aria-hidden="true" />}
                {submitLabel}
              </button>
            </footer>
          </form>
        </dialog>
      )}

      {toast && (
        <div className="toast" role="status">
          <Icon name="check" size={16} />
          {toast}
        </div>
      )}
    </>
  );
}
