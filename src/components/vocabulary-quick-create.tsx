"use client";

import { useId, useState } from "react";

import { MAX_CATEGORY_LABEL, MAX_TAG_LENGTH } from "@/domain/vocabulary";
import { apiErrorField, humanizeMessage, type ApiErrorBody } from "@/lib/api-error";
import { Icon } from "./icon";
import styles from "./vocabulary-field.module.css";

/**
 * 共用的小弹窗：只填名称，创建分类或标签（ADR-023 第 8 条）。
 *
 * 服务端决定重名策略：分类带 `reuseExisting: true`，命中同名启用项返回已有项；
 * 命中已停用项回 409 `CATEGORY_ARCHIVED`，这里原样显示提示，不自动复活。
 */

export interface QuickCreatedVocabulary {
  label: string;
  code?: string;
  id?: string;
}

export function VocabularyQuickCreate({
  kind,
  open,
  onClose,
  onCreated,
  disabled = false,
}: {
  kind: "category" | "tag";
  open: boolean;
  onClose: () => void;
  onCreated: (item: QuickCreatedVocabulary) => void;
  disabled?: boolean;
}) {
  const idPrefix = useId();
  const inputId = `${idPrefix}-name`;
  const max = kind === "category" ? MAX_CATEGORY_LABEL : MAX_TAG_LENGTH;
  const noun = kind === "category" ? "分类" : "标签";

  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    const name = label.trim();
    if (!name || saving) return;

    setSaving(true);
    setError(null);

    try {
      const response = await fetch(
        kind === "category" ? "/api/vocabulary/categories" : "/api/vocabulary/tags",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            kind === "category" ? { label: name, reuseExisting: true } : { label: name },
          ),
        },
      );
      const data = (await response.json().catch(() => null)) as
        | (ApiErrorBody & { code?: string; id?: string; label?: string })
        | null;

      if (!response.ok) {
        const badField = apiErrorField(data);
        setError(humanizeMessage(data?.error?.message ?? `新建${noun}失败，请稍后再试。`, badField));
        return;
      }

      onCreated({
        label: data?.label ?? name,
        ...(data?.code ? { code: data.code } : {}),
        ...(data?.id ? { id: data.id } : {}),
      });
      onClose();
    } catch {
      setError("网络异常，请检查连接后重试。");
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  // 这里不能用 <form>：本组件渲染在新建弹窗的 <form> 内部，嵌套表单会触发
  // hydration 报错，回车也会误提交外层表单。改成 group + 手动回车提交。
  return (
    <div
      className={styles.quickCreate}
      role="group"
      aria-label={`自定义（${noun}）`}
    >
      <div className={styles.quickHead}>
        <span className={styles.quickTitle}>新建{noun}</span>
        <button
          className={styles.quickClose}
          type="button"
          aria-label="关闭自定义"
          onClick={onClose}
        >
          <Icon name="x" size={14} />
        </button>
      </div>

      <label className="sr-only" htmlFor={inputId}>
        {noun}名称
      </label>
      <input
        autoFocus
        id={inputId}
        className={styles.quickInput}
        type="text"
        value={label}
        maxLength={max}
        placeholder={kind === "category" ? "分类名称（1–12 字）" : "标签名称（1–20 字）"}
        autoComplete="off"
        disabled={disabled || saving}
        onChange={(event) => {
          setLabel(event.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
          if (event.key === "Enter") {
            event.preventDefault();
            void submit();
          }
        }}
      />

      {error ? (
        <p className={styles.quickError} role="alert">
          {error}
        </p>
      ) : null}

      <div className={styles.quickActions}>
        <button className="btn btn-ghost" type="button" onClick={onClose}>
          取消
        </button>
        <button
          className="btn btn-primary"
          type="button"
          onClick={() => void submit()}
          disabled={disabled || saving || label.trim().length === 0}
        >
          {saving ? "保存中…" : "保存并选中"}
        </button>
      </div>
    </div>
  );
}
