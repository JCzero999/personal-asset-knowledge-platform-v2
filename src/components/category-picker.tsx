"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";

import { normalizeCategory, type VocabularyCategory } from "@/domain/vocabulary";
import { Icon } from "./icon";
import { VocabularyQuickCreate } from "./vocabulary-quick-create";
import { chooseCategory, filterVocabulary } from "./vocabulary-selection";
import styles from "./vocabulary-field.module.css";

/**
 * 分类选择器（ADR-023 第 8 条）：单选 chips + 过滤框 + 固定「＋ 自定义」。
 *
 * - 只能选词表里已有的分类，输入框只用于过滤，回车不会创建；
 * - 作品必须选一个（不默认选中）；资产可以不选（`allowEmpty`）；
 * - 「＋ 自定义」在本地立即追加并选中，服务端保存后页面刷新会带回正式数据。
 */
export function CategoryPicker({
  value,
  onChange,
  categories,
  allowEmpty = false,
  disabled = false,
  canManageVocabulary = false,
}: {
  value: string | null;
  onChange: (code: string | null) => void;
  categories: VocabularyCategory[];
  allowEmpty?: boolean;
  disabled?: boolean;
  canManageVocabulary?: boolean;
}) {
  const idPrefix = useId();
  const filterId = `${idPrefix}-category-filter`;
  const messageId = `${idPrefix}-category-message`;

  const [extra, setExtra] = useState<VocabularyCategory[]>([]);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const pool = useMemo(() => {
    const map = new Map(categories.map((item) => [item.code, item]));
    for (const item of extra) {
      if (!map.has(item.code)) map.set(item.code, item);
    }
    return [...map.values()].filter((item) => item.state === "active");
  }, [categories, extra]);

  const needle = normalizeCategory(query);
  const showFilter = pool.length > 12;
  const visible = useMemo(() => filterVocabulary(pool, needle), [pool, needle]);
  const selected = pool.find((item) => item.code === value) ?? null;

  function choose(code: string | null) {
    onChange(chooseCategory(value, code));
    setMessage(null);
  }

  return (
    <div className={styles.field}>
      <div className={styles.labelRow}>
        <span className={styles.label} id={`${idPrefix}-category-label`}>
          分类
        </span>
        <span className={styles.hint}>
          {allowEmpty ? "单选 · 可不选" : "单选 · 必选"}
        </span>
        {canManageVocabulary ? (
          <Link
            className="field-manage"
            href="/admin/vocabulary/categories"
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="settings" size={14} />
            管理
          </Link>
        ) : null}
      </div>

      {selected ? (
        <div className={styles.chips}>
          <span className={styles.chip}>
            <span className={styles.chipLabel} title={selected.label}>
              {selected.label}
            </span>
            {allowEmpty ? (
              <button
                className={styles.chipRemove}
                type="button"
                aria-label={`取消分类「${selected.label}」`}
                onClick={() => choose(null)}
              >
                <Icon name="x" size={12} />
              </button>
            ) : null}
          </span>
        </div>
      ) : null}

      <div className={styles.layout}>
        <div className={styles.picker}>
          {showFilter ? (
            <input
              id={filterId}
              className={styles.filter}
              type="search"
              role="combobox"
              aria-expanded={visible.length > 0}
              aria-controls={`${idPrefix}-category-grid`}
              aria-describedby={message ? messageId : undefined}
              aria-autocomplete="list"
              autoComplete="off"
              value={query}
              disabled={disabled}
              placeholder="过滤分类…"
              onChange={(event) => {
                setQuery(event.target.value);
                if (message) setMessage(null);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                if (visible.length === 1) choose(visible[0].code);
              }}
            />
          ) : null}

          <div
            className={styles.grid}
            id={`${idPrefix}-category-grid`}
            role="radiogroup"
            aria-labelledby={`${idPrefix}-category-label`}
          >
            {allowEmpty ? (
              <button
                className={`${styles.chipButton}${value === null ? ` ${styles.chipActive}` : ""}`}
                type="button"
                role="radio"
                aria-checked={value === null}
                disabled={disabled}
                onClick={() => choose(null)}
              >
                不选
              </button>
            ) : null}
            {visible.map((item) => (
              <button
                className={`${styles.chipButton}${
                  item.code === value ? ` ${styles.chipActive}` : ""
                }`}
                type="button"
                role="radio"
                aria-checked={item.code === value}
                disabled={disabled}
                key={item.code}
                title={item.label}
                onClick={() => choose(item.code)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <button
          className={styles.customButton}
          type="button"
          disabled={disabled}
          aria-label="自定义新建分类"
          aria-expanded={creating}
          onClick={() => {
            setCreating((current) => !current);
            setMessage(null);
          }}
        >
          <Icon name="plus" size={13} />
          自定义
        </button>
      </div>

      {creating ? (
        <VocabularyQuickCreate
          kind="category"
          open={creating}
          disabled={disabled}
          onClose={() => setCreating(false)}
          onCreated={(item) => {
            if (!item.code) {
              setMessage("新建成功，但刷新后才能选中，请稍后再试");
              return;
            }
            const created: VocabularyCategory = {
              code: item.code,
              label: item.label,
              normalized: normalizeCategory(item.label),
              sortOrder: Number.MAX_SAFE_INTEGER,
              state: "active",
              isSystem: false,
              usage: 0,
            };
            setExtra((current) => [...current, created]);
            choose(created.code);
          }}
        />
      ) : null}

      {message ? (
        <p className={styles.message} id={messageId} role="status">
          {message}
        </p>
      ) : showFilter && needle && visible.length === 0 ? (
        <p className={styles.emptyHint}>
          没有这个分类，点右侧「自定义」新建。
        </p>
      ) : pool.length === 0 ? (
        <p className={styles.emptyHint}>还没有可用分类，点右侧「自定义」新建一个。</p>
      ) : null}
    </div>
  );
}
