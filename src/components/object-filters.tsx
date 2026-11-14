"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  libraries,
  valueLevels,
  workStatuses,
  type ObjectType,
} from "@/domain/objects";
import type { VocabularyTag } from "@/domain/vocabulary";
import { libraryLabels, statusLabels } from "@/lib/object-labels";
import {
  defaultLifecycleFilters,
  reviewStatusFilterLabels,
  reviewStatusFilters,
  withLifecycleParams,
  type LifecycleFilters,
} from "./lifecycle";
import {
  buildWorkspaceHref,
  sortLabels,
  workspaceSorts,
  type ArchiveScope,
  type WorkspaceFilters,
} from "@/lib/workspace-filters";
import { Icon } from "./icon";

/**
 * 列表工具条：关键字、类型、库别、状态、排序与「在用 / 已归档」切换。
 *
 * 所有条件都写进 URL，查询由服务端组件完成；这里只负责把用户操作翻译成
 * 一次路由跳转，所以刷新、前进后退都能回到同一份结果。
 */

interface ChipOption {
  key: string;
  label: string;
  href: string;
  active: boolean;
}

/** 一组平铺按钮：比下拉少一次点击，选项也一眼看全。 */
function FilterChips({
  name,
  label,
  options,
  disabled = false,
  describedBy,
}: {
  name: string;
  label: string;
  options: ChipOption[];
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <div className="filter-field" data-filter={name}>
      <span className="filter-label">{label}</span>
      <div
        className="chip-group"
        role="group"
        aria-label={label}
        aria-disabled={disabled || undefined}
        aria-describedby={describedBy}
      >
        {options.map((option) =>
          disabled ? (
            <span className="chip is-disabled" key={option.key}>
              {option.label}
            </span>
          ) : (
            <Link
              className={`chip${option.active ? " is-active" : ""}`}
              href={option.href}
              scroll={false}
              aria-current={option.active ? "page" : undefined}
              key={option.key}
            >
              {option.label}
            </Link>
          ),
        )}
      </div>
    </div>
  );
}

export function ObjectFilters({
  filters,
  lifecycle = defaultLifecycleFilters,
  tags = [],
  compact = false,
}: {
  filters: WorkspaceFilters;
  /** 生命周期筛选（复核状态 / 价值等级），与主筛选并列存在 URL 上。 */
  lifecycle?: LifecycleFilters;
  /** 标签词表（使用次数从高到低）；按钮只列有引用的标签 + 当前选中项。 */
  tags?: VocabularyTag[];
  /** 列表窄栏用：收紧间距，搜索框之外的条件照样可点。 */
  compact?: boolean;
}) {
  const idPrefix = useId();
  const router = useRouter();
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

  // 条件之间互不清除：改一个按钮，其余条件原样带过去。
  function hrefWith(patch: Partial<WorkspaceFilters>) {
    return withLifecycleParams(buildWorkspaceHref(filters, patch), lifecycle);
  }

  function hrefLifecycle(patch: Partial<LifecycleFilters>) {
    return withLifecycleParams(buildWorkspaceHref(filters), { ...lifecycle, ...patch });
  }

  function submitSearch() {
    const q = value.trim();
    syncedQ.current = q;
    setValue(q);
    const href = hrefWith({ q });
    if (href === withLifecycleParams(buildWorkspaceHref(filters), lifecycle)) return;
    startTransition(() => {
      router.push(href, { scroll: false });
    });
  }

  function clearSearch() {
    setValue("");
    syncedQ.current = "";
    const href = hrefWith({ q: "" });
    startTransition(() => {
      router.replace(href, { scroll: false });
    });
    inputRef.current?.focus();
  }

  const statusDisabled = filters.type === "asset";
  const statusHintId = `${idPrefix}-status-hint`;

  // 类型：全列表唯一的类型入口，与其它条件用同一套按钮组。
  // 原来顶部另有一个「全部 / 资产 / 作品」胶囊条，与「类型」下拉重复，已合并到这里。
  const typeChips: ChipOption[] = (
    [
      { value: null, label: "全部" },
      { value: "asset", label: "资产" },
      { value: "work", label: "作品" },
    ] as Array<{ value: ObjectType | null; label: string }>
  ).map((option) => ({
    key: option.label,
    label: option.label,
    href: hrefWith({ type: option.value }),
    active: filters.type === option.value,
  }));

  // 只用有引用的标签，避免按钮里堆满 0 次的词条；当前选中的即使 0 次也保留，
  // 否则刷新后会显示「全部标签」而结果仍是按标签筛过的。
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

  const libraryChips: ChipOption[] = [
    { key: "all", label: "全部", href: hrefWith({ library: null }), active: filters.library === null },
    ...libraries.map((library) => ({
      key: library,
      label: libraryLabels[library],
      href: hrefWith({ library }),
      active: filters.library === library,
    })),
  ];

  const statusChips: ChipOption[] = [
    { key: "all", label: "全部", href: hrefWith({ status: null }), active: filters.status === null },
    ...workStatuses.map((status) => ({
      key: status,
      label: statusLabels[status],
      href: hrefWith({ status }),
      active: filters.status === status,
    })),
  ];

  const tagChips: ChipOption[] = [
    { key: "all", label: "全部标签", href: hrefWith({ tag: null }), active: filters.tag === null },
    ...tagOptions.map((tag) => ({
      key: tag.id,
      label: `${tag.label}（${tag.usage}）`,
      href: hrefWith({ tag: tag.label }),
      active: filters.tag === tag.label,
    })),
  ];

  const reviewChips: ChipOption[] = [
    {
      key: "all",
      label: "全部",
      href: hrefLifecycle({ aiStatus: null }),
      active: lifecycle.aiStatus === null,
    },
    ...reviewStatusFilters.map((status) => ({
      key: status,
      label: reviewStatusFilterLabels[status],
      href: hrefLifecycle({ aiStatus: status }),
      active: lifecycle.aiStatus === status,
    })),
  ];

  const levelChips: ChipOption[] = [
    {
      key: "all",
      label: "全部",
      href: hrefLifecycle({ valueLevel: null }),
      active: lifecycle.valueLevel === null,
    },
    ...valueLevels.map((level) => ({
      key: level,
      label: `${level} 级`,
      href: hrefLifecycle({ valueLevel: level }),
      active: lifecycle.valueLevel === level,
    })),
  ];

  const sortChips: ChipOption[] = workspaceSorts.map((sort) => ({
    key: sort,
    label: sortLabels[sort],
    href: hrefWith({ sort }),
    active: filters.sort === sort,
  }));

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
        <FilterChips name="type" label="类型" options={typeChips} />
        <FilterChips name="library" label="库别" options={libraryChips} />
        <FilterChips
          name="status"
          label="状态"
          options={statusChips}
          disabled={statusDisabled}
          describedBy={statusDisabled ? statusHintId : undefined}
        />
        <FilterChips name="tag" label="标签" options={tagChips} />
        <FilterChips name="review" label="复核状态" options={reviewChips} />
        <FilterChips name="level" label="价值等级" options={levelChips} />
        <FilterChips name="sort" label="排序" options={sortChips} />
      </div>

      {statusDisabled ? (
        <p className="filter-hint" id={statusHintId}>
          资产没有状态，切换到作品后可用。
        </p>
      ) : null}
    </div>
  );
}
