"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import {
  MAX_ACTIVE_CATEGORIES,
  MAX_CATEGORY_LABEL,
  MAX_TAG_LENGTH,
  categoryLabelProblem,
  tagLabelProblem,
  type VocabularySnapshot,
} from "@/domain/vocabulary";
import { Icon } from "./icon";
import styles from "./vocabulary-manager.module.css";

/**
 * 分类 / 标签管理（ADR-016、ADR-019）。
 *
 * 约定：
 * - 写入一律走 `/api/vocabulary/*`，成功后在 `router.refresh()` 重新读库，
 *   列表永远以服务端为准，不在客户端自己维护一份副本。
 * - 删除被引用项时服务端返回 409 + 引用数量，这里据此把「删除」变成
 *   「迁移到…（分类）/ 合并到…（标签）」，不提供强删。
 * - 内置分类、最后一个启用分类在界面上直接禁用删除，并说明原因。
 */

type CategoryRow = VocabularySnapshot["categories"][number];
type TagRow = VocabularySnapshot["tags"][number];

class RequestFailure extends Error {
  code: string | undefined;
  details: Record<string, unknown> | undefined;

  constructor(message: string, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(url, init);
  } catch {
    throw new RequestFailure("网络异常，请检查连接后重试。");
  }

  if (response.status === 204) return undefined as T;

  const data = (await response.json().catch(() => null)) as
    | {
        error?: { code?: string; message?: string; details?: Record<string, unknown> };
      }
    | null;

  if (!response.ok) {
    throw new RequestFailure(
      data?.error?.message ?? "操作失败，请稍后再试。",
      data?.error?.code,
      data?.error?.details,
    );
  }

  return data as T;
}

function numberFrom(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function failureMessage(cause: unknown): string {
  return cause instanceof RequestFailure ? cause.message : "操作失败，请稍后再试。";
}

function isConflict(cause: unknown): cause is RequestFailure {
  return cause instanceof RequestFailure && cause.code === "CONFLICT";
}

type Dialog =
  | { kind: "category-archive"; code: string; label: string }
  | { kind: "category-restore"; code: string; label: string }
  | {
      kind: "category-delete";
      code: string;
      label: string;
      usage: number;
      /** 1 = 删除前说明；2 = 409 之后选迁移目标。 */
      step: 1 | 2;
      migrateTo: string;
      error: string | null;
    }
  | {
      kind: "tag-delete";
      id: string;
      label: string;
      usage: number;
      step: 1 | 2;
      mergeTo: string;
      /** 第二次危险确认：从对象上移除标签。 */
      confirmRemove: boolean;
      error: string | null;
    }
  | {
      kind: "tag-merge";
      id: string;
      label: string;
      usage: number;
      targetId: string;
      error: string | null;
    };

function Modal({
  title,
  note,
  children,
  actions,
  onClose,
}: {
  title: string;
  note?: string;
  children?: React.ReactNode;
  actions: React.ReactNode;
  onClose: () => void;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);

  // 挂载即打开：本组件只在该弹窗出现时渲染。
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="dialog-form">
        <header className="dialog-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {note ? <p className={styles.modalNote}>{note}</p> : null}
          </div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </header>
        {children ? <div className="dialog-body">{children}</div> : null}
        <footer className="dialog-actions">{actions}</footer>
      </div>
    </dialog>
  );
}

export function VocabularyManager({
  tab,
  vocabulary,
}: {
  tab: "categories" | "tags";
  vocabulary: VocabularySnapshot;
}) {
  const router = useRouter();
  const isCategories = tab === "categories";
  const activeCategories = vocabulary.categories.filter((item) => item.state === "active");

  const [newLabel, setNewLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [editingCategory, setEditingCategory] = useState<string | null>(null);
  const [categoryDraft, setCategoryDraft] = useState("");
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const [query, setQuery] = useState("");
  const [tagSort, setTagSort] = useState<"usage" | "name">("usage");

  const tags = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? vocabulary.tags.filter(
          (tag) =>
            tag.label.toLowerCase().includes(needle) || tag.normalized.includes(needle),
        )
      : vocabulary.tags;

    return [...filtered].sort((a, b) =>
      tagSort === "usage"
        ? b.usage - a.usage || a.label.localeCompare(b.label, "zh")
        : a.label.localeCompare(b.label, "zh"),
    );
  }, [vocabulary.tags, query, tagSort]);

  function flash(message: string) {
    setNotice(message);
    setError(null);
  }

  function fail(cause: unknown) {
    setError(failureMessage(cause));
    setNotice(null);
  }

  function refresh() {
    router.refresh();
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating) return;

    const label = newLabel.trim();
    const problem = isCategories ? categoryLabelProblem(label) : tagLabelProblem(label);

    if (problem) {
      setError(problem);
      setNotice(null);
      return;
    }

    setCreating(true);
    setError(null);

    try {
      if (isCategories) {
        await request("/api/vocabulary/categories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label }),
        });
        flash(`已新增分类「${label}」，现在可以在新建弹窗里选到它。`);
      } else {
        await request("/api/vocabulary/tags", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label }),
        });
        flash(`已保存标签「${label}」。`);
      }
      setNewLabel("");
      refresh();
    } catch (cause) {
      fail(cause);
    } finally {
      setCreating(false);
    }
  }

  async function patchCategory(code: string, body: Record<string, unknown>, success: string) {
    setBusy(code);
    setError(null);

    try {
      await request(`/api/vocabulary/categories/${encodeURIComponent(code)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      flash(success);
      setEditingCategory(null);
      setDialog(null);
      refresh();
      return true;
    } catch (cause) {
      fail(cause);
      return false;
    } finally {
      setBusy(null);
    }
  }

  /**
   * 上移 / 下移：直接交换两行的 sort_order。
   *
   * 不能只改自己那行的值——相邻两行的值可能相等（新建与导入数据混排时），
   * 也可能间隔不足 10，算出来的新值会让排序原地不动。交换值总能换位；
   * 两行本来就相等时，先把整表按当前顺序重排成 10、20、30… 再交换。
   */
  async function moveCategory(code: string, direction: -1 | 1) {
    const list = vocabulary.categories;
    const index = list.findIndex((item) => item.code === code);
    const row = list[index];
    const neighbour = list[index + direction];

    if (!row || !neighbour) return;

    setBusy(code);
    setError(null);

    try {
      if (row.sortOrder === neighbour.sortOrder) {
        const reordered = [...list];
        reordered[index] = neighbour;
        reordered[index + direction] = row;

        for (const [position, item] of reordered.entries()) {
          const sortOrder = (position + 1) * 10;
          if (item.sortOrder === sortOrder) continue;
          await request(`/api/vocabulary/categories/${encodeURIComponent(item.code)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sortOrder }),
          });
        }
      } else {
        for (const [item, sortOrder] of [
          [row, neighbour.sortOrder],
          [neighbour, row.sortOrder],
        ] as const) {
          await request(`/api/vocabulary/categories/${encodeURIComponent(item.code)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sortOrder }),
          });
        }
      }

      flash(`已调整「${row.label}」的顺序。`);
      refresh();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(null);
    }
  }

  async function saveCategoryLabel(code: string) {
    const label = categoryDraft.trim();
    const problem = categoryLabelProblem(label);

    if (problem) {
      setError(problem);
      return;
    }

    await patchCategory(code, { label }, `已重命名为「${label}」。`);
  }

  function askDeleteCategory(row: CategoryRow) {
    setError(null);
    setDialog({
      kind: "category-delete",
      code: row.code,
      label: row.label,
      usage: row.usage,
      step: 1,
      migrateTo: "",
      error: null,
    });
  }

  async function performDeleteCategory(state: Extract<Dialog, { kind: "category-delete" }>) {
    setBusy(state.code);

    try {
      const result = await request<{ migrated: number }>(
        `/api/vocabulary/categories/${encodeURIComponent(state.code)}${
          state.step === 2 && state.migrateTo
            ? `?migrateTo=${encodeURIComponent(state.migrateTo)}`
            : ""
        }`,
        { method: "DELETE" },
      );
      flash(
        result.migrated > 0
          ? `已删除分类「${state.label}」，${result.migrated} 个对象已迁移。`
          : `已删除分类「${state.label}」。`,
      );
      setDialog(null);
      refresh();
    } catch (cause) {
      if (isConflict(cause) && numberFrom(cause.details?.usage) > 0) {
        const usage = numberFrom(cause.details?.usage);
        const targets = vocabulary.categories.filter(
          (item) => item.code !== state.code && item.state === "active",
        );
        setDialog({
          ...state,
          step: 2,
          usage,
          migrateTo: targets[0]?.code ?? "",
          error: null,
        });
        return;
      }

      if (state.step === 2) {
        setDialog({ ...state, error: failureMessage(cause) });
      } else {
        setDialog(null);
        fail(cause);
      }
    } finally {
      setBusy(null);
    }
  }

  async function patchTag(id: string, label: string, success: string) {
    setBusy(id);
    setError(null);

    try {
      await request(`/api/vocabulary/tags/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      flash(success);
      setEditingTag(null);
      refresh();
      return true;
    } catch (cause) {
      fail(cause);
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function saveTagLabel(id: string) {
    const label = tagDraft.trim();
    const problem = tagLabelProblem(label);

    if (problem) {
      setError(problem);
      return;
    }

    await patchTag(id, label, `已重命名为「${label}」，用到它的内容一起更新。`);
  }

  function askDeleteTag(row: TagRow) {
    setError(null);
    setDialog({
      kind: "tag-delete",
      id: row.id,
      label: row.label,
      usage: row.usage,
      step: 1,
      mergeTo: "",
      confirmRemove: false,
      error: null,
    });
  }

  async function performDeleteTag(state: Extract<Dialog, { kind: "tag-delete" }>) {
    setBusy(state.id);

    try {
      const result = await request<{ removedFrom: number }>(
        `/api/vocabulary/tags/${encodeURIComponent(state.id)}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ removeFromObjects: state.confirmRemove }),
        },
      );
      flash(
        result.removedFrom > 0
          ? `已删除标签「${state.label}」，并从 ${result.removedFrom} 个内容上移除。`
          : `已删除标签「${state.label}」。`,
      );
      setDialog(null);
      refresh();
    } catch (cause) {
      if (isConflict(cause) && numberFrom(cause.details?.usage) > 0) {
        const others = vocabulary.tags.filter((item) => item.id !== state.id);
        setDialog({
          ...state,
          step: 2,
          usage: numberFrom(cause.details?.usage),
          mergeTo: others[0]?.id ?? "",
          confirmRemove: false,
          error: null,
        });
        return;
      }

      if (state.step === 2) {
        setDialog({ ...state, error: failureMessage(cause) });
      } else {
        setDialog(null);
        fail(cause);
      }
    } finally {
      setBusy(null);
    }
  }

  async function performMerge(state: Extract<Dialog, { kind: "tag-merge" }>) {
    if (!state.targetId) {
      setDialog({ ...state, error: "请选择要合并到的标签" });
      return;
    }

    setBusy(state.id);

    try {
      const target = vocabulary.tags.find((item) => item.id === state.targetId);
      await request(`/api/vocabulary/tags/${encodeURIComponent(state.id)}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: state.targetId }),
      });
      flash(
        `已把「${state.label}」合并到「${target?.label ?? "目标标签"}」，关联内容保留。`,
      );
      setDialog(null);
      refresh();
    } catch (cause) {
      setDialog({ ...state, error: failureMessage(cause) });
    } finally {
      setBusy(null);
    }
  }

  const mergeTargets = (id: string) => vocabulary.tags.filter((item) => item.id !== id);

  return (
    <section className="panel vocabulary" aria-labelledby="vocabulary-heading">
      <div className={styles.head}>
        <div>
          <h2 id="vocabulary-heading" className={styles.title}>
            {isCategories ? "全部分类" : "全部标签"}
          </h2>
          <p className={styles.subtitle}>
            {isCategories
              ? `启用 ${activeCategories.length} / ${MAX_ACTIVE_CATEGORIES} 个 · 共 ${vocabulary.categories.length} 个`
              : `共 ${vocabulary.tags.length} 个 · 输入即建，同名自动复用`}
          </p>
        </div>
      </div>

      <form className={styles.create} onSubmit={create}>
        <label className={styles.createField}>
          <span className="sr-only">{isCategories ? "新分类名称" : "新标签名称"}</span>
          <input
            className={styles.input}
            value={newLabel}
            maxLength={isCategories ? MAX_CATEGORY_LABEL : MAX_TAG_LENGTH}
            placeholder={isCategories ? "新分类名称，如「复盘笔记」" : "新标签名称，如「工具类」"}
            onChange={(event) => setNewLabel(event.target.value)}
            disabled={creating}
          />
        </label>
        <button className="btn btn-primary" type="submit" disabled={creating || !newLabel.trim()}>
          {creating ? "保存中…" : isCategories ? "新增分类" : "新增标签"}
        </button>
      </form>

      {!isCategories ? (
        <div className={styles.toolbar}>
          <label className={styles.search}>
            <Icon name="search" size={14} />
            <input
              className={styles.searchInput}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="按名称或归一化键搜索"
              aria-label="搜索标签"
            />
          </label>
          <label className={styles.sortField}>
            <span className={styles.sortLabel}>排序</span>
            <select
              className={styles.select}
              value={tagSort}
              onChange={(event) => setTagSort(event.target.value as "usage" | "name")}
            >
              <option value="usage">按使用次数</option>
              <option value="name">按名称</option>
            </select>
          </label>
        </div>
      ) : null}

      {notice ? (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      {isCategories ? (
        <ul className={styles.list} aria-label="分类列表">
          <li className={styles.headerRow} aria-hidden="true">
            <span>名称</span>
            <span className={styles.colUsage}>使用</span>
            <span className={styles.colOrder}>排序</span>
            <span className={styles.colActions}>操作</span>
          </li>
          {vocabulary.categories.length === 0 ? (
            <li className={styles.empty}>
              <Icon name="inbox" size={22} />
              <p>还没有任何分类，先在上方新增一个。</p>
            </li>
          ) : (
            vocabulary.categories.map((row, index) => {
              const isFirst = index === 0;
              const isLast = index === vocabulary.categories.length - 1;
              const isOnlyActive = row.state === "active" && activeCategories.length <= 1;
              const deleteBlocked = row.isSystem || isOnlyActive;
              const deleteReason = row.isSystem
                ? "内置分类不能删除，只能改名或停用"
                : isOnlyActive
                  ? "至少保留一个启用分类"
                  : "";
              const editing = editingCategory === row.code;

              return (
                <li className={styles.row} key={row.code}>
                  <div className={styles.nameCell}>
                    {editing ? (
                      <div className={styles.inlineEdit}>
                        <input
                          className={styles.input}
                          value={categoryDraft}
                          maxLength={MAX_CATEGORY_LABEL}
                          aria-label={`重命名分类「${row.label}」`}
                          autoFocus
                          disabled={busy === row.code}
                          onChange={(event) => setCategoryDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void saveCategoryLabel(row.code);
                            }
                            if (event.key === "Escape") setEditingCategory(null);
                          }}
                        />
                        <button
                          className={`btn btn-primary ${styles.smallBtn}`}
                          type="button"
                          disabled={busy === row.code}
                          onClick={() => void saveCategoryLabel(row.code)}
                        >
                          保存
                        </button>
                        <button
                          className={`btn btn-ghost ${styles.smallBtn}`}
                          type="button"
                          onClick={() => setEditingCategory(null)}
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <span className={styles.nameText}>{row.label}</span>
                    )}
                    <span className={styles.meta}>
                      <code className={styles.code}>{row.code}</code>
                      {row.isSystem ? <span className={styles.badge}>内置</span> : null}
                      {row.state === "active" ? (
                        <span className={styles.badgeOk}>启用中</span>
                      ) : (
                        <span className={styles.badgeMuted}>已停用</span>
                      )}
                    </span>
                  </div>

                  <span className={styles.usageCell}>
                    {row.usage > 0 ? `${row.usage} 个对象` : "未使用"}
                  </span>

                  <span className={styles.orderCell}>
                    <button
                      className={styles.iconButton}
                      type="button"
                      aria-label={`上移「${row.label}」`}
                      disabled={isFirst || busy === row.code}
                      onClick={() => void moveCategory(row.code, -1)}
                    >
                      ↑
                    </button>
                    <button
                      className={styles.iconButton}
                      type="button"
                      aria-label={`下移「${row.label}」`}
                      disabled={isLast || busy === row.code}
                      onClick={() => void moveCategory(row.code, 1)}
                    >
                      ↓
                    </button>
                  </span>

                  <span className={styles.actions}>
                    {editing ? null : (
                      <button
                        className={styles.link}
                        type="button"
                        onClick={() => {
                          setEditingCategory(row.code);
                          setCategoryDraft(row.label);
                        }}
                      >
                        重命名
                      </button>
                    )}
                    {row.state === "active" ? (
                      <button
                        className={styles.link}
                        type="button"
                        disabled={isOnlyActive || row.code === "uncategorized"}
                        title={
                          isOnlyActive
                            ? "至少保留一个启用分类"
                            : row.code === "uncategorized"
                              ? "「未分类」是兜底分类，不能停用"
                              : undefined
                        }
                        onClick={() =>
                          setDialog({ kind: "category-archive", code: row.code, label: row.label })
                        }
                      >
                        停用
                      </button>
                    ) : (
                      <button
                        className={styles.link}
                        type="button"
                        onClick={() =>
                          setDialog({ kind: "category-restore", code: row.code, label: row.label })
                        }
                      >
                        启用
                      </button>
                    )}
                    <button
                      className={styles.danger}
                      type="button"
                      disabled={deleteBlocked}
                      title={deleteReason || undefined}
                      onClick={() => askDeleteCategory(row)}
                    >
                      删除
                    </button>
                  </span>
                </li>
              );
            })
          )}
        </ul>
      ) : (
        <ul className={styles.list} aria-label="标签列表">
          <li className={styles.headerRowTags} aria-hidden="true">
            <span>名称</span>
            <span className={styles.colUsage}>使用</span>
            <span className={styles.colActions}>操作</span>
          </li>
          {tags.length === 0 ? (
            <li className={styles.empty}>
              <Icon name="inbox" size={22} />
              <p>
                {query.trim()
                  ? `没有匹配「${query.trim()}」的标签。`
                  : "还没有任何标签，在新建内容时输入即可创建。"}
              </p>
            </li>
          ) : (
            tags.map((row) => {
              const editing = editingTag === row.id;
              const mergeable = mergeTargets(row.id).length > 0;

              return (
                <li className={styles.rowTags} key={row.id}>
                  <div className={styles.nameCell}>
                    {editing ? (
                      <div className={styles.inlineEdit}>
                        <input
                          className={styles.input}
                          value={tagDraft}
                          maxLength={MAX_TAG_LENGTH}
                          aria-label={`重命名标签「${row.label}」`}
                          autoFocus
                          disabled={busy === row.id}
                          onChange={(event) => setTagDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void saveTagLabel(row.id);
                            }
                            if (event.key === "Escape") setEditingTag(null);
                          }}
                        />
                        <button
                          className={`btn btn-primary ${styles.smallBtn}`}
                          type="button"
                          disabled={busy === row.id}
                          onClick={() => void saveTagLabel(row.id)}
                        >
                          保存
                        </button>
                        <button
                          className={`btn btn-ghost ${styles.smallBtn}`}
                          type="button"
                          onClick={() => setEditingTag(null)}
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <span className={styles.nameText}>{row.label}</span>
                    )}
                    <span className={styles.meta}>
                      <code className={styles.code}>{row.normalized}</code>
                      {row.usage === 0 ? <span className={styles.badgeMuted}>未使用</span> : null}
                    </span>
                  </div>

                  <span className={styles.usageCell}>
                    {row.usage > 0 ? `${row.usage} 个内容` : "—"}
                  </span>

                  <span className={styles.actions}>
                    {editing ? null : (
                      <button
                        className={styles.link}
                        type="button"
                        onClick={() => {
                          setEditingTag(row.id);
                          setTagDraft(row.label);
                        }}
                      >
                        重命名
                      </button>
                    )}
                    <button
                      className={styles.link}
                      type="button"
                      disabled={!mergeable}
                      title={mergeable ? undefined : "没有可合并的目标标签"}
                      onClick={() =>
                        setDialog({
                          kind: "tag-merge",
                          id: row.id,
                          label: row.label,
                          usage: row.usage,
                          targetId: "",
                          error: null,
                        })
                      }
                    >
                      合并
                    </button>
                    <button
                      className={styles.danger}
                      type="button"
                      onClick={() => askDeleteTag(row)}
                    >
                      删除
                    </button>
                  </span>
                </li>
              );
            })
          )}
        </ul>
      )}

      {dialog?.kind === "category-archive" ? (
        <Modal
          title={`停用「${dialog.label}」？`}
          note="停用后不再出现在新建弹窗里，已有对象不受影响，随时可以重新启用。"
          actions={
            <>
              <button className="btn btn-ghost" type="button" onClick={() => setDialog(null)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                type="button"
                disabled={busy === dialog.code}
                onClick={() =>
                  void patchCategory(
                    dialog.code,
                    { state: "archived" },
                    `已停用分类「${dialog.label}」。`,
                  )
                }
              >
                停用
              </button>
            </>
          }
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === "category-restore" ? (
        <Modal
          title={`重新启用「${dialog.label}」？`}
          note="启用后会按当前排序回到新建弹窗的分类列表里。"
          actions={
            <>
              <button className="btn btn-ghost" type="button" onClick={() => setDialog(null)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                type="button"
                disabled={busy === dialog.code}
                onClick={() =>
                  void patchCategory(
                    dialog.code,
                    { state: "active" },
                    `已启用分类「${dialog.label}」。`,
                  )
                }
              >
                启用
              </button>
            </>
          }
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === "category-delete" ? (
        <Modal
          title={
            dialog.step === 1 ? `删除分类「${dialog.label}」？` : `「${dialog.label}」还有对象在用`
          }
          note={
            dialog.step === 1
              ? "删除不可撤销。如果只是暂时不用，建议改为「停用」。"
              : `该分类下还有 ${dialog.usage} 个对象，删除前要先选一个分类接收它们。`
          }
          actions={
            dialog.step === 1 ? (
              <>
                <button className="btn btn-ghost" type="button" onClick={() => setDialog(null)}>
                  取消
                </button>
                <button
                  className="btn btn-danger"
                  type="button"
                  disabled={busy === dialog.code}
                  onClick={() => void performDeleteCategory(dialog)}
                >
                  删除
                </button>
              </>
            ) : (
              <>
                <button className="btn btn-ghost" type="button" onClick={() => setDialog(null)}>
                  取消
                </button>
                <button
                  className="btn btn-danger"
                  type="button"
                  disabled={busy === dialog.code || !dialog.migrateTo}
                  onClick={() => void performDeleteCategory(dialog)}
                >
                  {busy === dialog.code ? "迁移中…" : "迁移并删除"}
                </button>
              </>
            )
          }
          onClose={() => setDialog(null)}
        >
          {dialog.step === 2 ? (
            <>
              <label className={styles.dialogField}>
                <span>迁移到</span>
                <select
                  className={styles.select}
                  value={dialog.migrateTo}
                  onChange={(event) =>
                    setDialog({ ...dialog, migrateTo: event.target.value, error: null })
                  }
                >
                  <option value="">选择目标分类</option>
                  {vocabulary.categories
                    .filter((item) => item.code !== dialog.code && item.state === "active")
                    .map((item) => (
                      <option key={item.code} value={item.code}>
                        {item.label}（{item.usage} 个对象）
                      </option>
                    ))}
                </select>
              </label>
              <p className={styles.dialogHint}>
                这 {dialog.usage} 个对象的分类会被改写，并重新排队同步。
              </p>
              {dialog.error ? (
                <p className={styles.dialogError} role="alert">
                  {dialog.error}
                </p>
              ) : null}
            </>
          ) : null}
        </Modal>
      ) : null}

      {dialog?.kind === "tag-delete" ? (
        <Modal
          title={
            dialog.step === 1 ? `删除标签「${dialog.label}」？` : `「${dialog.label}」还有内容在用`
          }
          note={
            dialog.step === 1
              ? "删除不可撤销。如果只是名字不合适，建议改用「重命名」。"
              : `该标签还被 ${dialog.usage} 个内容使用，合并会保留这些内容的关联。`
          }
          actions={
            dialog.step === 1 ? (
              <>
                <button className="btn btn-ghost" type="button" onClick={() => setDialog(null)}>
                  取消
                </button>
                <button
                  className="btn btn-danger"
                  type="button"
                  disabled={busy === dialog.id}
                  onClick={() => void performDeleteTag(dialog)}
                >
                  删除
                </button>
              </>
            ) : dialog.confirmRemove ? (
              <>
                <button
                  className="btn btn-ghost"
                  type="button"
                  onClick={() => setDialog({ ...dialog, confirmRemove: false })}
                >
                  返回
                </button>
                <button
                  className="btn btn-danger"
                  type="button"
                  disabled={busy === dialog.id}
                  onClick={() => void performDeleteTag(dialog)}
                >
                  {busy === dialog.id ? "处理中…" : "确认移除并删除"}
                </button>
              </>
            ) : (
              <>
                <button className="btn btn-ghost" type="button" onClick={() => setDialog(null)}>
                  取消
                </button>
                <button
                  className="btn btn-danger"
                  type="button"
                  disabled={busy === dialog.id || !dialog.mergeTo}
                  onClick={() => {
                    const target = vocabulary.tags.find((item) => item.id === dialog.mergeTo);
                    if (!target) return;
                    void performMerge({
                      kind: "tag-merge",
                      id: dialog.id,
                      label: dialog.label,
                      usage: dialog.usage,
                      targetId: dialog.mergeTo,
                      error: null,
                    });
                  }}
                >
                  {busy === dialog.id ? "合并中…" : "合并并删除"}
                </button>
              </>
            )
          }
          onClose={() => setDialog(null)}
        >
          {dialog.step === 2 ? (
            dialog.confirmRemove ? (
              <div className={styles.dangerBox}>
                <strong>这一步会把标签从 {dialog.usage} 个内容上移除</strong>
                <p>内容本身不会被删除，只是不再带这个标签。确认后无法撤销。</p>
              </div>
            ) : (
              <>
                <label className={styles.dialogField}>
                  <span>合并到</span>
                  <select
                    className={styles.select}
                    value={dialog.mergeTo}
                    onChange={(event) =>
                      setDialog({ ...dialog, mergeTo: event.target.value, error: null })
                    }
                  >
                    <option value="">选择目标标签</option>
                    {mergeTargets(dialog.id).map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}（{item.usage} 个内容）
                      </option>
                    ))}
                  </select>
                </label>
                <p className={styles.dialogHint}>
                  源标签的关联会整体转到目标标签，重复的自动去重。
                </p>
                <button
                  className={styles.dangerLink}
                  type="button"
                  onClick={() => setDialog({ ...dialog, confirmRemove: true, error: null })}
                >
                  或：不合并，直接从这些内容上移除标签
                </button>
                {dialog.error ? (
                  <p className={styles.dialogError} role="alert">
                    {dialog.error}
                  </p>
                ) : null}
              </>
            )
          ) : null}
        </Modal>
      ) : null}

      {dialog?.kind === "tag-merge" ? (
        <Modal
          title={`合并「${dialog.label}」`}
          note={`合并后该标签消失，${dialog.usage} 个内容的关联转到目标标签。`}
          actions={
            <>
              <button className="btn btn-ghost" type="button" onClick={() => setDialog(null)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                type="button"
                disabled={busy === dialog.id || !dialog.targetId}
                onClick={() => void performMerge(dialog)}
              >
                {busy === dialog.id ? "合并中…" : "合并"}
              </button>
            </>
          }
          onClose={() => setDialog(null)}
        >
          <label className={styles.dialogField}>
            <span>合并到</span>
            <select
              className={styles.select}
              value={dialog.targetId}
              onChange={(event) =>
                setDialog({ ...dialog, targetId: event.target.value, error: null })
              }
            >
              <option value="">选择目标标签</option>
              {mergeTargets(dialog.id).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}（{item.usage} 个内容）
                </option>
              ))}
            </select>
          </label>
          {dialog.error ? (
            <p className={styles.dialogError} role="alert">
              {dialog.error}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </section>
  );
}
