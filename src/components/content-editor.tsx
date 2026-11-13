"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type UIEvent,
} from "react";

import type { ContentRef } from "@/domain/content-ref";
import { apiErrorMessage, apiRequest } from "@/lib/api-client";
import { MAX_UPLOAD_BYTES } from "@/lib/content-format";
import { isMarkdownContent } from "@/lib/markdown";
import styles from "./content-editor.module.css";
import { Icon } from "./icon";
import { MarkdownPreview } from "./markdown-preview";

/**
 * 主内容正文编辑器：原生 textarea + 行号列，不引入编辑器依赖。
 *
 * 保存走 `POST /api/objects/{id}/content`（role=primary），与上传共用同一条
 * RAGFlow → content_refs → outbox → 解析链路；服务端按 content_key 替换旧主内容，
 * 所以这里不需要（也不应该）自己删除旧文件。
 */

/** 行号列最多渲染多少行，避免超长正文把 DOM 拖垮；超出部分仍可正常编辑。 */
const MAX_GUTTER_LINES = 20000;

const INDENT = "  ";

/** 正文类型：纯文本（沿用行号 + 不换行）或 Markdown（左侧书写、右侧实时预览）。 */
export type EditorMode = "plain" | "markdown";

const modeOptions: Array<{ value: EditorMode; label: string; hint: string }> = [
  { value: "plain", label: "纯文本", hint: "行号与自动缩进，适合笔记、代码片段和草稿" },
  { value: "markdown", label: "Markdown", hint: "左侧写、右侧即时预览，适合结构化文章" },
];

export interface ContentEditorProps {
  objectId: string;
  objectTitle: string;
  /** 已有主内容（且是文本）时传入，打开后先取回原文。 */
  existing: ContentRef | null;
  /** 保存后是否会替换掉现有主内容，只影响提示文案。 */
  replacing: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}

/** 用对象标题当文件名：RAGFlow 靠扩展名选解析器，这里按正文类型给 `.md` 或 `.txt`。 */
export function editorFileName(title: string, mode: EditorMode = "plain"): string {
  const stem = title
    .replace(/[\\/:*?"<>|\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);

  return `${stem || "正文"}${mode === "markdown" ? ".md" : ".txt"}`;
}

function lineNumbers(lineCount: number): string {
  const count = Math.min(lineCount, MAX_GUTTER_LINES);
  if (count <= 0) return "";

  const numbers: string[] = [];
  for (let line = 1; line <= count; line += 1) {
    numbers.push(String(line));
  }

  return numbers.join("\n");
}

export function ContentEditor({
  objectId,
  objectTitle,
  existing,
  replacing,
  onClose,
  onSaved,
}: ContentEditorProps) {
  const idPrefix = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const [text, setText] = useState("");
  const [loadedText, setLoadedText] = useState("");
  const [mode, setMode] = useState<EditorMode>(
    isMarkdownContent(existing) ? "markdown" : "plain",
  );
  const [loading, setLoading] = useState(existing !== null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = !loading && text !== loadedText;
  const lines = useMemo(() => text.split("\n").length, [text]);
  const gutter = useMemo(() => lineNumbers(lines), [lines]);
  const title = existing ? "编辑正文" : "编写正文";

  // 打开已有主内容：先取回原文；二进制文件不会走到这里（入口已按 MIME 过滤）。
  // 初始 loading 由 useState 决定，effect 里只在请求结束后改状态。
  useEffect(() => {
    if (!existing) return;

    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(
          `/api/objects/${objectId}/content/${existing.id}`,
          { cache: "no-store" },
        );
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const raw = await response.text();
        if (cancelled) return;

        setText(raw);
        setLoadedText(raw);
      } catch {
        if (!cancelled) setLoadError("读取原文失败，请关闭后重试。");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [existing, objectId]);

  useEffect(() => {
    if (loading || loadError) return;

    const input = textareaRef.current;
    if (!input) return;

    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [loading, loadError]);

  // 面板打开时锁住页面滚动，关闭后恢复原值，不碰全局样式。
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  function requestClose() {
    if (saving) return;
    if (dirty && !window.confirm("正文还没有保存，确定关闭吗？")) return;
    onClose();
  }

  async function save() {
    if (saving || loading || loadError) return;

    if (!text.trim()) {
      setError("正文还是空的，写点内容再保存。");
      return;
    }

    // 与服务端同一口径：按 UTF-8 字节数挡 25 MB，中文不能按字符数算。
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > MAX_UPLOAD_BYTES) {
      setError(`正文不能超过 ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB。`);
      return;
    }

    setSaving(true);
    setError(null);

    const formData = new FormData();
    formData.append(
      "file",
      new File([text], editorFileName(objectTitle, mode), {
        type: mode === "markdown" ? "text/markdown" : "text/plain",
      }),
    );
    formData.append("role", "primary");

    try {
      await apiRequest<ContentRef>(`/api/objects/${objectId}/content`, {
        method: "POST",
        body: formData,
      });
      onSaved("正文已保存，解析完成后就可以被检索。");
    } catch (cause) {
      setError(apiErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      requestClose();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save();
    }
  }

  function handleTab(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Tab" || event.shiftKey) return;

    // 原生 textarea 的 Tab 会切走焦点；这里改成插入两个空格，保持“写代码”的手感。
    event.preventDefault();
    const input = event.currentTarget;
    input.setRangeText(INDENT, input.selectionStart, input.selectionEnd, "end");
    setText(input.value);
  }

  function syncScroll(event: UIEvent<HTMLTextAreaElement>) {
    if (gutterRef.current) {
      gutterRef.current.scrollTop = event.currentTarget.scrollTop;
    }
  }

  return (
    <div
      className={styles.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <section
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${idPrefix}-title`}
        onKeyDown={handleKeyDown}
      >
        <header className={styles.header}>
          <div className={styles.heading}>
            <h2 className={styles.title} id={`${idPrefix}-title`}>{title}</h2>
            <p className={styles.subtitle}>
              {replacing
                ? `「${objectTitle}」保存后会替换当前主内容并重新解析。`
                : `保存后会作为「${objectTitle}」的主内容上传并解析。`}
            </p>
            <div className={styles.modeRow}>
              <span className={styles.modeLabel}>类型</span>
              <div className={styles.modeSwitch} role="group" aria-label="正文类型">
                {modeOptions.map((option) => {
                  const active = mode === option.value;

                  return (
                    <button
                      className={`${styles.modeOption}${active ? " is-active" : ""}`}
                      type="button"
                      aria-pressed={active}
                      disabled={saving}
                      onClick={() => setMode(option.value)}
                      key={option.value}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
              <span className={styles.modeHint}>
                {modeOptions.find((option) => option.value === mode)?.hint}
              </span>
            </div>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭编辑区"
            disabled={saving}
            onClick={requestClose}
          >
            <Icon name="x" size={18} />
          </button>
        </header>

        {error ? (
          <div className={`form-alert ${styles.alert}`} role="alert">
            <Icon name="alert" size={16} />
            <p>{error}</p>
          </div>
        ) : null}

        {loading ? (
          <div className={styles.loading} role="status">
            <span className="spinner spinner-dark" aria-hidden="true" />
            正在读取原文…
          </div>
        ) : loadError ? (
          <div className={`form-alert ${styles.alert}`} role="alert">
            <Icon name="alert" size={16} />
            <p>{loadError}</p>
          </div>
        ) : mode === "markdown" ? (
          <div className={styles.markdownPane}>
            <div className={styles.writePane}>
              <p className={styles.paneLabel}>编辑</p>
              <textarea
                className={`${styles.input} ${styles.markdownInput}`}
                ref={textareaRef}
                aria-labelledby={`${idPrefix}-title`}
                spellCheck={false}
                wrap="soft"
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={handleTab}
              />
            </div>
            <div className={styles.previewPane}>
              <p className={styles.paneLabel}>预览</p>
              <div className={styles.previewScroll}>
                <MarkdownPreview text={text} />
              </div>
            </div>
          </div>
        ) : (
          <div className={styles.shell}>
            <div className={styles.gutter} ref={gutterRef} aria-hidden="true">
              <pre className={styles.gutterText}>{gutter}</pre>
            </div>
            <textarea
              className={styles.input}
              ref={textareaRef}
              aria-labelledby={`${idPrefix}-title`}
              spellCheck={false}
              wrap="off"
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={handleTab}
              onScroll={syncScroll}
            />
          </div>
        )}

        <footer className={styles.footer}>
          <div className={styles.stats}>
            <span>{lines} 行 · {text.length} 字符</span>
            <span className={styles.hint}>
              {mode === "markdown"
                ? "Markdown：# 标题 · **粗体** · - 列表 · `代码` · Ctrl/Cmd+S 保存"
                : "Tab 缩进两格 · Ctrl/Cmd+S 保存 · Esc 关闭"}
            </span>
          </div>
          <div className={styles.actions}>
            <button
              className="btn btn-secondary"
              type="button"
              disabled={saving}
              onClick={requestClose}
            >
              取消
            </button>
            <button
              className="btn btn-primary"
              type="button"
              disabled={saving || loading || loadError !== null}
              onClick={() => void save()}
            >
              {saving ? (
                <span className="spinner" aria-hidden="true" />
              ) : (
                <Icon name="check" size={16} />
              )}
              {saving ? "保存中…" : "保存正文"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
