"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  libraries,
  valueLevels,
  workStatuses,
  type Library,
  type ObjectType,
  type WorkStatus,
} from "@/domain/objects";
import type { VocabularyTag } from "@/domain/vocabulary";
import { libraryLabels, statusLabels } from "@/lib/object-labels";
import {
  defaultLifecycleFilters,
  reviewStatusFilterLabels,
  reviewStatusFilters,
  withLifecycleParams,
  type LifecycleFilters,
  type ReviewStatusFilter,
} from "./lifecycle";
import {
  buildWorkspaceHref,
  sortLabels,
  workspaceSorts,
  type ArchiveScope,
  type WorkspaceFilters,
  type WorkspaceSort,
} from "@/lib/workspace-filters";
import { Icon } from "./icon";

/**
 * 列表工具条：关键字、类型、库别、状态、排序与「在用 / 已归档」切换。
 *
 * 所有条件都写进 URL，查询由服务端组件完成；这里只负责把用户操作翻译成
 * 一次路由跳转，所以刷新、前进后退都能回到同一份结果。
 */
export function ObjectFilters({
  filters,
  lifecycle = defaultLifecycleFilters,
  tags = [],
  compact = false,
}: {
  filters: WorkspaceFilters;
  /** 生命周期筛选（复核状态 / 价值等级），与主筛选并列存在 URL 上。 */
  lifecycle?: LifecycleFilters;
  /** 标签词表（使用次数从高到低）；下拉只列有引用的标签 + 当前选中项。 */
  tags?: VocabularyTag[];
  /** 列表窄栏用：只留搜索框与下拉，范围切换交给目录。 */
  compact?: boolean;
}) {
  const router = useRouter();
  const idPrefix = useId();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState(filters.q);
  const inputRef = useRef<HTMLInputElement>(null);

  // 只在「URL 的关键字被外部改变」（前进后退、清空筛选）时回写输入框，
  // 避免用户正在输入、却因为改了别的筛选而丢掉未提交的文字。
  const syncedQ = useRef(filters.q);
  useEffect(() => {
    if (syncedQ.current === filters.q) return;
    syncedQ.current = filters.q;
    setValue(filters.q);
  }, [filters.q]);

  function go(href: string, push = false) {
    const current = withLifecycleParams(buildWorkspaceHref(filters), lifecycle);
    if (href === current) return;
    startTransition(() => {
      if (push) router.push(href, { scroll: false });
      else router.replace(href, { scroll: false });
    });
  }

  // 下拉是连续微调，用 replace 不塞满历史；搜索与范围切换是明确动作，用 push 以便后退还原。
  // 两次改动都保留生命周期条件，避免调一个筛选把另一个悄悄清掉。
  function apply(next: Partial<WorkspaceFilters>, push = false) {
    go(withLifecycleParams(buildWorkspaceHref(filters, next), lifecycle), push);
  }

  function applyLifecycle(patch: Partial<LifecycleFilters>) {
    go(withLifecycleParams(buildWorkspaceHref(filters), { ...lifecycle, ...patch }));
  }

  function submitSearch() {
    const q = value.trim();
    syncedQ.current = q;
    setValue(q);
    apply({ q }, true);
  }

  function clearSearch() {
    setValue("");
    apply({ q: "" });
    inputRef.current?.focus();
  }

  const statusDisabled = filters.type === "asset";
  const statusHintId = `${idPrefix}-status-hint`;

  // 只用有引用的标签，避免下拉里堆满 0 次的词条；当前选中的即使 0 次也保留，
  // 否则刷新后下拉会显示「全部标签」而结果仍是按标签筛过的。
  const tagOptions = (() => {
    const list = tags.filter((tag) => tag.usage > 0);
    if (filters.tag && !list.some((tag) => tag.label === filters.tag)) {
      const current = tags.find((tag) => tag.label === filters.tag);
      return [
        ...list,
        current ?? {
          id: `current-${filters.tag}`,
          label: filters.tag,
          normalized: filters.tag,
          sortOrder: 0,
          usage: 0,
        },
      ];
    }
    return list;
  })();

  return (
    <div className={`filters${compact ? " is-compact" : ""}`} aria-busy={pending}>
      <form
        className="filters-top"
        role="search"
        aria-label="筛选工作台内容"
        onSubmit={(event) => {
          event.preventDefault();
          submitSearch();
        }}
      >
        <div className="filter-search">
          <span className="filter-search-icon" aria-hidden="true">
            <Icon name="search" size={16} />
          </span>
          <input
            ref={inputRef}
            id={`${idPrefix}-q`}
            className="text-input filter-input"
            type="search"
            value={value}
            maxLength={100}
            autoComplete="off"
            placeholder="搜索标题或描述"
            aria-label="搜索标题或描述"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && value) {
                event.preventDefault();
                clearSearch();
              }
            }}
          />
          {value ? (
            <button
              className="filter-clear"
              type="button"
              aria-label="清除关键字"
              onClick={clearSearch}
            >
              <Icon name="x" size={14} />
            </button>
          ) : null}
        </div>

        <button className="btn btn-secondary filter-submit" type="submit">
          搜索
        </button>

        <div className="scope-switch" role="group" aria-label="内容范围">
          {(
            [
              { value: "active", label: "在用" },
              { value: "only", label: "已归档" },
            ] as Array<{ value: ArchiveScope; label: string }>
          ).map((option) => {
            const active = filters.archived === option.value;
            return (
              <Link
                className={`scope-option${active ? " is-active" : ""}`}
                href={withLifecycleParams(
                  buildWorkspaceHref(filters, { archived: option.value }),
                  lifecycle,
                )}
                aria-current={active ? "page" : undefined}
                scroll={false}
                key={option.value}
              >
                {option.label}
              </Link>
            );
          })}
        </div>
      </form>

      <div className="filters-fields">
        <label className="filter-field">
          <span className="filter-label">类型</span>
          <span className="select-wrap">
            <select
              className="select"
              value={filters.type ?? ""}
              onChange={(event) =>
                apply({ type: (event.target.value || null) as ObjectType | null })
              }
            >
              <option value="">全部</option>
              <option value="asset">资产</option>
              <option value="work">作品</option>
            </select>
          </span>
        </label>

        <label className="filter-field">
          <span className="filter-label">库别</span>
          <span className="select-wrap">
            <select
              className="select"
              value={filters.library ?? ""}
              onChange={(event) =>
                apply({ library: (event.target.value || null) as Library | null })
              }
            >
              <option value="">全部</option>
              {libraries.map((library) => (
                <option value={library} key={library}>
                  {libraryLabels[library]}
                </option>
              ))}
            </select>
          </span>
        </label>

        <label className="filter-field">
          <span className="filter-label">状态</span>
          <span className="select-wrap">
            <select
              className="select"
              value={statusDisabled ? "" : (filters.status ?? "")}
              disabled={statusDisabled}
              aria-describedby={statusDisabled ? statusHintId : undefined}
              onChange={(event) =>
                apply({ status: (event.target.value || null) as WorkStatus | null })
              }
            >
              <option value="">全部</option>
              {workStatuses.map((status) => (
                <option value={status} key={status}>
                  {statusLabels[status]}
                </option>
              ))}
            </select>
          </span>
        </label>

        <label className="filter-field">
          <span className="filter-label">标签</span>
          <span className="select-wrap">
            <select
              className="select"
              value={filters.tag ?? ""}
              onChange={(event) => apply({ tag: event.target.value || null })}
            >
              <option value="">全部标签</option>
              {tagOptions.map((tag) => (
                <option value={tag.label} key={tag.id}>
                  {tag.label}（{tag.usage}）
                </option>
              ))}
            </select>
          </span>
        </label>

        <label className="filter-field">
          <span className="filter-label">复核状态</span>
          <span className="select-wrap">
            <select
              className="select"
              value={lifecycle.aiStatus ?? ""}
              onChange={(event) =>
                applyLifecycle({
                  aiStatus: (event.target.value || null) as ReviewStatusFilter | null,
                })
              }
            >
              <option value="">全部</option>
              {reviewStatusFilters.map((status) => (
                <option value={status} key={status}>
                  {reviewStatusFilterLabels[status]}
                </option>
              ))}
            </select>
          </span>
        </label>

        <label className="filter-field">
          <span className="filter-label">价值等级</span>
          <span className="select-wrap">
            <select
              className="select"
              value={lifecycle.valueLevel ?? ""}
              onChange={(event) =>
                applyLifecycle({
                  valueLevel: (event.target.value || null) as LifecycleFilters["valueLevel"],
                })
              }
            >
              <option value="">全部</option>
              {valueLevels.map((level) => (
                <option value={level} key={level}>
                  {level} 级
                </option>
              ))}
            </select>
          </span>
        </label>

        <label className="filter-field">
          <span className="filter-label">排序</span>
          <span className="select-wrap">
            <select
              className="select"
              value={filters.sort}
              onChange={(event) => apply({ sort: event.target.value as WorkspaceSort })}
            >
              {workspaceSorts.map((sort) => (
                <option value={sort} key={sort}>
                  {sortLabels[sort]}
                </option>
              ))}
            </select>
          </span>
        </label>
      </div>

      {statusDisabled ? (
        <p className="filter-hint" id={statusHintId}>
          资产没有状态，切换到作品后可用。
        </p>
      ) : null}
    </div>
  );
}
