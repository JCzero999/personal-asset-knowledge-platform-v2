"use client";

import { useId, useMemo, useState } from "react";

import {
  MAX_TAGS_PER_OBJECT,
  normalizeTag,
  type VocabularyTag,
} from "@/domain/vocabulary";
import { Icon } from "./icon";
import { VocabularyQuickCreate } from "./vocabulary-quick-create";
import { filterVocabulary, findExact, toggleTag } from "./vocabulary-selection";
import styles from "./vocabulary-field.module.css";

/**
 * 标签选择器（ADR-023 第 8 条）：多选 chips + 过滤框 + 固定「＋ 自定义」。
 *
 * - 只能选词表里已有的标签，输入框只用于过滤；回车只选中已有项，
 *   不再「输入即创建」——未知标签现在会被服务端以 `TAG_NOT_FOUND` 拒绝；
 * - 新标签走「＋ 自定义」，创建成功后立即选中。
 */
export function TagField({
  value,
  onChange,
  suggestions,
  disabled = false,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  /** 全站标签词表，按使用次数排序后传入。 */
  suggestions: VocabularyTag[];
  disabled?: boolean;
}) {
  const idPrefix = useId();
  const filterId = `${idPrefix}-tag-filter`;
  const messageId = `${idPrefix}-tag-message`;
  const gridId = `${idPrefix}-tag-grid`;

  const [extra, setExtra] = useState<VocabularyTag[]>([]);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const pool = useMemo(() => {
    const map = new Map<string, VocabularyTag>();
    for (const item of suggestions) map.set(item.id, item);
    for (const item of extra) {
      if (!map.has(item.id)) map.set(item.id, item);
    }
    return [...map.values()];
  }, [suggestions, extra]);

  const selectedKeys = useMemo(() => new Set(value.map(normalizeTag)), [value]);
  const needle = normalizeTag(query);
  const showFilter = pool.length > 12;
  const visible = useMemo(() => filterVocabulary(pool, needle), [pool, needle]);
  const full = value.length >= MAX_TAGS_PER_OBJECT;

  function toggle(label: string) {
    const result = toggleTag(value, label);
    onChange(result.value);
    setMessage(result.message);
  }

  function selectExact() {
    if (!needle) return;
    const exact = findExact(pool, needle);

    if (exact) {
      if (!selectedKeys.has(exact.normalized)) toggle(exact.label);
      return;
    }

    setMessage(
      pool.length === 0
        ? "还没有标签，点右侧「自定义」新建。"
        : "没有这个标签，点右侧「自定义」新建。",
    );
  }

  return (
    <div className={styles.field}>
      <div className={styles.labelRow}>
        <span className={styles.label} id={`${idPrefix}-tag-label`}>
          标签
        </span>
        <span className={styles.hint}>内容属性，可多选</span>
        <span
          className={`${styles.count}${full ? ` ${styles.countFull}` : ""}`}
          aria-live="polite"
        >
          {value.length}/{MAX_TAGS_PER_OBJECT}
        </span>
      </div>

      {value.length > 0 ? (
        <div className={styles.chips}>
          {value.map((label) => (
            <span className={styles.chip} key={label}>
              <span className={styles.chipLabel} title={label}>
                {label}
              </span>
              <button
                className={styles.chipRemove}
                type="button"
                aria-label={`移除标签「${label}」`}
                disabled={disabled}
                onClick={() => toggle(label)}
              >
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
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
              aria-controls={gridId}
              aria-describedby={message ? messageId : undefined}
              aria-autocomplete="list"
              autoComplete="off"
              value={query}
              disabled={disabled}
              placeholder="过滤标签…"
              onChange={(event) => {
                setQuery(event.target.value);
                if (message) setMessage(null);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                selectExact();
              }}
            />
          ) : null}

          <div
            className={styles.grid}
            id={gridId}
            role="group"
            aria-labelledby={`${idPrefix}-tag-label`}
          >
            {visible.map((item) => {
              const active = selectedKeys.has(item.normalized);

              return (
                <button
                  className={`${styles.chipButton}${active ? ` ${styles.chipActive}` : ""}`}
                  type="button"
                  aria-pressed={active}
                  disabled={disabled || (full && !active)}
                  key={item.id}
                  title={`${item.label} · ${item.usage} 次`}
                  onClick={() => toggle(item.label)}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>

        <button
          className={styles.customButton}
          type="button"
          disabled={disabled}
          aria-label="自定义新建标签"
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
          kind="tag"
          open={creating}
          disabled={disabled}
          onClose={() => setCreating(false)}
          onCreated={(item) => {
            if (!item.id) {
              setMessage("新建成功，但刷新后才能选中，请稍后再试");
              return;
            }
            const created: VocabularyTag = {
              id: item.id,
              label: item.label,
              normalized: normalizeTag(item.label),
              sortOrder: 0,
              usage: 0,
            };
            setExtra((current) => [...current, created]);
            toggle(created.label);
          }}
        />
      ) : null}

      {message ? (
        <p className={styles.message} id={messageId} role="status">
          {message}
        </p>
      ) : pool.length === 0 ? (
        <p className={styles.emptyHint}>还没有标签，点右侧「自定义」新建一个。</p>
      ) : showFilter && needle && visible.length === 0 ? (
        <p className={styles.emptyHint}>没有这个标签，点右侧「自定义」新建。</p>
      ) : null}
    </div>
  );
}
