"use client";

import { useEffect, useId, useMemo, useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import type { VocabularySnapshot } from "@/domain/vocabulary";
import { apiErrorField, humanizeMessage, type ApiErrorBody } from "@/lib/api-error";
import { CategoryPicker } from "./category-picker";
import { Icon } from "./icon";
import { TagField } from "./tag-field";

type ObjectType = "asset" | "work";
type Library = "internal" | "external";
type ButtonVariant = "primary" | "secondary" | "ghost";

interface CreateObjectButtonProps {
  label?: string;
  variant?: ButtonVariant;
  withIcon?: boolean;
  className?: string;
  /**
   * 词表快照（ADR-016 / ADR-023）：由服务端读库后传入，只显示启用分类、按 sort_order 排序。
   * 组件里不再保留任何硬编码分类或标签名单。
   */
  vocabulary: VocabularySnapshot;
  /** 管理员可见「管理」入口；普通账号看不到，直接访问管理路由会得到 403。 */
  canManageVocabulary?: boolean;
}

export function CreateObjectButton({
  label = "新建",
  variant = "primary",
  withIcon = true,
  className = "",
  vocabulary,
  canManageVocabulary = false,
}: CreateObjectButtonProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const idPrefix = useId();
  const titleId = `${idPrefix}-title`;
  const descriptionId = `${idPrefix}-description`;
  const errorId = `${idPrefix}-error`;

  const [open, setOpen] = useState(false);
  const [type, setType] = useState<ObjectType>("asset");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [library, setLibrary] = useState<Library>("internal");
  const [tags, setTags] = useState<string[]>([]);
  const activeCategories = useMemo(
    () => vocabulary.categories.filter((item) => item.state === "active"),
    [vocabulary.categories],
  );
  const tagSuggestions = useMemo(
    () => [...vocabulary.tags].sort((a, b) => b.usage - a.usage || a.label.localeCompare(b.label, "zh")),
    [vocabulary.tags],
  );
  const [category, setCategory] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [field, setField] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;

    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    titleRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!toast) return;

    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function openDialog() {
    setError(null);
    setField(null);
    setOpen(true);
  }

  function closeDialog() {
    setOpen(false);
    setError(null);
    setField(null);
    resetForm();
  }

  function resetForm() {
    setType("asset");
    setTitle("");
    setDescription("");
    setLibrary("internal");
    setTags([]);
    setCategory(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setError(null);
    setField(null);

    if (type === "work" && !category) {
      setSubmitting(false);
      setField("category");
      setError("请选择一个分类");
      return;
    }

    const payload = {
      type,
      title: title.trim(),
      library,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(category ? { category } : {}),
      ...(tags.length > 0 ? { tags } : {}),
    };

    try {
      const response = await fetch("/api/objects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json().catch(() => null)) as
        | (ApiErrorBody & { title?: string })
        | null;

      if (!response.ok) {
        const badField = apiErrorField(data);
        setField(badField);
        setError(
          humanizeMessage(data?.error?.message ?? "保存失败，请稍后再试。", badField),
        );
        return;
      }

      const createdTitle = (data as { title?: string } | null)?.title;
      closeDialog();
      setToast(createdTitle ? `已新建「${createdTitle}」` : "已新建");
      startTransition(() => router.refresh());
    } catch {
      setError("网络异常，请检查连接后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        className={`btn btn-${variant} ${className}`.trim()}
        type="button"
        onClick={openDialog}
      >
        {withIcon && <Icon name="plus" size={16} />}
        <span>{label}</span>
      </button>

      {open && (
        <dialog
          ref={dialogRef}
          className="dialog"
          aria-labelledby={`${idPrefix}-heading`}
          onClose={closeDialog}
          onClick={(event) => {
            if (event.target === dialogRef.current) closeDialog();
          }}
        >
          <form className="dialog-form" onSubmit={handleSubmit} aria-busy={submitting}>
            <header className="dialog-head">
              <div>
                <h2 id={`${idPrefix}-heading`}>新建内容</h2>
                <p>先记下来，细节随时可以补充。</p>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭"
                onClick={closeDialog}
              >
                <Icon name="x" size={18} />
              </button>
            </header>

            <div className="dialog-body">
              <div className="field">
                <span className="field-label" id={`${idPrefix}-type`}>类型</span>
                <div className="type-grid" role="radiogroup" aria-labelledby={`${idPrefix}-type`}>
                  <label className={`type-card ${type === "asset" ? "is-active" : ""}`}>
                    <input
                      className="sr-only"
                      type="radio"
                      name={`${idPrefix}-type`}
                      value="asset"
                      checked={type === "asset"}
                      onChange={() => setType("asset")}
                    />
                    <span className="type-card-icon"><Icon name="archive" size={19} /></span>
                    <span className="type-card-copy">
                      <strong>资产</strong>
                      <small>资料、笔记与参考</small>
                    </span>
                  </label>
                  <label className={`type-card ${type === "work" ? "is-active" : ""}`}>
                    <input
                      className="sr-only"
                      type="radio"
                      name={`${idPrefix}-type`}
                      value="work"
                      checked={type === "work"}
                      onChange={() => {
                        setType("work");
                        // 作品只在外部库流转，内库是实践沉淀出来的结果。
                        setLibrary("external");
                      }}
                    />
                    <span className="type-card-icon"><Icon name="workflow" size={19} /></span>
                    <span className="type-card-copy">
                      <strong>作品</strong>
                      <small>要完成并交付的内容</small>
                    </span>
                  </label>
                </div>
              </div>

              <div className="field">
                <label className="field-label" htmlFor={titleId}>
                  标题 <span className="field-note">必填</span>
                </label>
                <input
                  ref={titleRef}
                  id={titleId}
                  className="text-input"
                  type="text"
                  value={title}
                  placeholder={type === "work" ? "例如：如何搭建个人知识系统" : "例如：读书笔记 · 深度工作"}
                  maxLength={200}
                  aria-invalid={field === "title"}
                  aria-describedby={error && field === "title" ? errorId : undefined}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    if (error) setError(null);
                  }}
                />
              </div>

              <CategoryPicker
                value={category}
                onChange={setCategory}
                categories={activeCategories}
                allowEmpty={type === "asset"}
                disabled={submitting}
                canManageVocabulary={canManageVocabulary}
              />

              <TagField
                value={tags}
                onChange={setTags}
                suggestions={tagSuggestions}
                disabled={submitting}
              />

              <fieldset className="field">
                <legend className="field-label">放在哪里</legend>
                <div className="library-grid">
                  <label
                    className={`type-card ${library === "internal" ? "is-active" : ""}${type === "work" ? " is-disabled" : ""}`}
                    title={type === "work" ? "作品先在外部库流转" : undefined}
                  >
                    <input
                      className="sr-only"
                      type="radio"
                      name={`${idPrefix}-library`}
                      value="internal"
                      checked={library === "internal"}
                      disabled={type === "work"}
                      onChange={() => setLibrary("internal")}
                    />
                    <span className="type-card-copy">
                      <strong>内库</strong>
                      <small>{type === "work" ? "作品先在外部库流转" : "长期复用"}</small>
                    </span>
                  </label>
                  <label className={`type-card ${library === "external" ? "is-active" : ""}`}>
                    <input
                      className="sr-only"
                      type="radio"
                      name={`${idPrefix}-library`}
                      value="external"
                      checked={library === "external"}
                      onChange={() => setLibrary("external")}
                    />
                    <span className="type-card-copy">
                      <strong>外库</strong>
                      <small>收集的输入</small>
                    </span>
                  </label>
                </div>
                <p className="library-hint">
                  {type === "work"
                    ? "作品先在外部库流转：草稿可 AI 提炼，发布后标记已实践即自动沉淀进内库。"
                    : library === "internal"
                      ? "保存后立即进行 5 维价值评估，生成 S / A / B / C 等级。"
                      : "外库资产先经 AI 打分，≥75 分自动进内库，60–74 分待人工复核。"}
                </p>
              </fieldset>

              <div className="field">
                <label className="field-label" htmlFor={descriptionId}>
                  说明 <span className="field-note">选填</span>
                </label>
                <textarea
                  id={descriptionId}
                  className="textarea"
                  rows={3}
                  value={description}
                  placeholder="补充来源、用途或下一步计划…"
                  maxLength={5000}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>

              {error && (
                <div className="form-alert" id={errorId} role="alert">
                  <Icon name="alert" size={17} />
                  <p>{error}</p>
                </div>
              )}
            </div>

            <footer className="dialog-actions">
              <button className="btn btn-ghost" type="button" onClick={closeDialog}>
                取消
              </button>
              <button className="btn btn-primary" type="submit" disabled={submitting}>
                {submitting && <span className="spinner" aria-hidden="true" />}
                {submitting ? "创建中…" : "创建"}
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
