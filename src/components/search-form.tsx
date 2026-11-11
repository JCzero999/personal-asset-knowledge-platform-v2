"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { libraries, type Library } from "@/domain/objects";
import { libraryLabels } from "@/lib/object-labels";
import {
  buildSearchHref,
  DEFAULT_SEARCH_THRESHOLD,
  MAX_SEARCH_QUESTION,
  thresholdOptionsFor,
} from "@/lib/search-params";
import { Icon } from "./icon";

/**
 * 检索条件表单：只负责把一次明确的检索写成 URL，
 * 结果查询、空状态与错误都在服务端页面完成。
 */
export function SearchForm({
  q: initialQ,
  library: initialLibrary,
  threshold: initialThreshold,
}: {
  q: string;
  library: Library | null;
  threshold: number;
}) {
  const router = useRouter();
  const idPrefix = useId();
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useState(initialQ);
  const [library, setLibrary] = useState<Library | null>(initialLibrary);
  const [threshold, setThreshold] = useState(initialThreshold);

  // 前进后退或点示例链接时，页面会用新的地址作为 key 重新挂载这个表单，
  // 初始值直接来自 URL，不需要再用 effect 回写状态。

  const dirty =
    q !== initialQ
    || library !== initialLibrary
    || threshold !== initialThreshold;

  function submit() {
    const question = q.trim();
    if (!question) return;

    startTransition(() => {
      router.push(
        buildSearchHref({ q: question, library, threshold }),
        { scroll: false },
      );
    });
  }

  function clear() {
    setQ("");
    setLibrary(null);
    setThreshold(DEFAULT_SEARCH_THRESHOLD);
    startTransition(() => router.push("/search"));
  }

  return (
    <form
      className="search-form"
      role="search"
      aria-label="检索内容"
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="search-field search-query">
        <label className="filter-label" htmlFor={`${idPrefix}-q`}>检索词</label>
        <div className="filter-search">
          <span className="filter-search-icon" aria-hidden="true">
            <Icon name="search" size={16} />
          </span>
          <input
            id={`${idPrefix}-q`}
            className="text-input filter-input"
            type="search"
            value={q}
            maxLength={MAX_SEARCH_QUESTION}
            autoComplete="off"
            placeholder="例如：如何做内容复盘"
            onChange={(event) => setQ(event.target.value)}
          />
          {q ? (
            <button
              className="filter-clear"
              type="button"
              aria-label="清除检索词"
              onClick={() => setQ("")}
            >
              <Icon name="x" size={14} />
            </button>
          ) : null}
        </div>
      </div>

      <label className="search-field">
        <span className="filter-label">库别</span>
        <span className="select-wrap">
          <select
            className="select"
            value={library ?? ""}
            onChange={(event) =>
              setLibrary((event.target.value || null) as Library | null)
            }
          >
            <option value="">全部</option>
            {libraries.map((item) => (
              <option value={item} key={item}>{libraryLabels[item]}</option>
            ))}
          </select>
        </span>
      </label>

      <label className="search-field">
        <span className="filter-label">相似度阈值</span>
        <span className="select-wrap">
          <select
            className="select"
            value={String(threshold)}
            onChange={(event) => setThreshold(Number(event.target.value))}
          >
            {thresholdOptionsFor(threshold).map((option) => (
              <option value={String(option.value)} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </span>
      </label>

      <div className="search-actions">
        <button
          className="btn btn-primary"
          type="submit"
          disabled={pending || !q.trim()}
        >
          {pending && <span className="spinner" aria-hidden="true" />}
          {pending ? "检索中…" : "检索"}
        </button>
        {(initialQ || initialLibrary || initialThreshold !== DEFAULT_SEARCH_THRESHOLD) ? (
          <button className="btn btn-ghost" type="button" disabled={pending} onClick={clear}>
            清空
          </button>
        ) : dirty ? (
          <button className="btn btn-ghost" type="button" disabled={pending} onClick={clear}>
            重置
          </button>
        ) : null}
      </div>
    </form>
  );
}
