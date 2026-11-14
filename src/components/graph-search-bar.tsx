"use client";

/**
 * 图谱问答（ADR-027 浮层清单）：底部居中的「问图谱」搜索卡 + 浮在它上方的结果卡。
 *
 * 取代原先右下角的固定问答面板：
 * - 搜索卡沿用首页检索的输入口径（40 高输入框 + 主按钮），外层套液态玻璃材质；
 * - 结果卡是同一套玻璃的第二张卡，回答正文、引用文档与「由 provider/model 生成」一行；
 * - 回答用当前账号绑定的大模型，页面不再出现「本机模型」这类提示。
 *
 * 取数只在这里做：`POST /api/graph/query { q }`；请求失败 / 空回答 / 生成中三态都在卡内，
 * 关闭（按钮或 Esc）会中止进行中的请求，迟到的响应按票据丢弃。
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { Icon } from "./icon";

export interface GraphAskReference {
  objectId: string;
  title: string;
}

export interface GraphAskAnswer {
  question: string;
  response: string;
  references: GraphAskReference[];
  /** 回答所用的大模型与提供方；后端未返回时整行不显示，不写「本机模型」。 */
  model?: string;
  provider?: string;
}

export interface GraphAskNode {
  id: string;
  label: string;
}

const MAX_QUESTION = 200;

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeReferences(raw: unknown): GraphAskReference[] {
  if (!Array.isArray(raw)) return [];
  const rows: GraphAskReference[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const objectId = typeof row.objectId === "string" ? row.objectId : "";
    if (!objectId || seen.has(objectId)) continue;
    seen.add(objectId);
    rows.push({
      objectId,
      title: typeof row.title === "string" && row.title ? row.title : objectId,
    });
  }
  return rows;
}

function toAnswer(payload: unknown, fallbackQuestion: string): GraphAskAnswer {
  const row = (payload ?? {}) as Record<string, unknown>;
  return {
    question: asText(row.question) || fallbackQuestion,
    response: asText(row.response),
    references: normalizeReferences(row.references),
    model: optionalText(row.model),
    provider: optionalText(row.provider),
  };
}

type Segment =
  | { type: "text"; text: string }
  | { type: "node"; id: string; label: string };

/**
 * 回答里的实体名切成可点胶囊（中文没有空格，按标签做最长前缀匹配）。
 * 与原来详情栏那套一致：只有出现在当前视图里的标签才切，避免把普通词变成按钮。
 */
function splitAnswer(text: string, nodes: GraphAskNode[]): Segment[] {
  const candidates = nodes
    .filter((node) => node.label.length >= 2)
    .sort((a, b) => b.label.length - a.label.length);
  const output: Segment[] = [];
  let buffer = "";
  let index = 0;

  while (index < text.length) {
    const hit = candidates.find((node) => text.startsWith(node.label, index));
    if (hit) {
      if (buffer) {
        output.push({ type: "text", text: buffer });
        buffer = "";
      }
      output.push({ type: "node", id: hit.id, label: hit.label });
      index += hit.label.length;
    } else {
      buffer += text[index];
      index += 1;
    }
  }
  if (buffer) output.push({ type: "text", text: buffer });
  return output;
}

export function GraphSearchBar({
  floating,
  nodes,
  onPickNode,
  onGlassChange,
}: {
  /** 浮层模式（3D / 2D）套玻璃并绝对定位；列表模式走文档流，用普通面板。 */
  floating: boolean;
  nodes: GraphAskNode[];
  onPickNode?: (id: string) => void;
  /** 结果卡挂上 / 卸下时通知容器重新绑定指针高光。 */
  onGlassChange?: () => void;
}) {
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<GraphAskAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const requestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const close = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    // 票据前进一格：迟到的响应不再写回已关闭的卡片。
    requestRef.current += 1;
    setOpen(false);
    setAsking(false);
    setError(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  useEffect(() => {
    onGlassChange?.();
  }, [open, onGlassChange]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const ask = useCallback(async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;

    const ticket = ++requestRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setAsking(true);
    setError(null);
    setOpen(true);

    try {
      const response = await fetch("/api/graph/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: trimmed }),
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? `请求失败（${response.status}）`);
      }
      if (ticket !== requestRef.current) return;
      setAnswer(toAnswer(payload, trimmed));
    } catch (reason) {
      if (controller.signal.aborted || ticket !== requestRef.current) return;
      setAnswer(null);
      setError(reason instanceof Error ? reason.message : "问答暂时不可用");
    } finally {
      if (ticket === requestRef.current) setAsking(false);
    }
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(question);
  }

  const segments = useMemo(
    () => (answer?.response ? splitAnswer(answer.response, nodes) : []),
    [answer, nodes],
  );

  const modelLine = [answer?.provider, answer?.model].filter(Boolean).join("/");

  return (
    <div className={`graph-ask-dock${floating ? "" : " is-static"}`} id="graph-qa">
      {open ? (
        <section
          className={`graph-ask-result${floating ? " graph-glass" : " panel"}`}
          aria-label="图谱回答"
          aria-busy={asking}
        >
          <button
            className="graph-ask-close"
            type="button"
            aria-label="关闭回答"
            onClick={close}
          >
            <Icon name="x" size={14} />
          </button>

          <div className="graph-ask-result-body">
            {asking ? (
              <p className="graph-ask-status" role="status">
                正在生成…
              </p>
            ) : error ? (
              <p className="graph-ask-error" role="alert">
                {error}
                <button className="text-link" type="button" onClick={() => void ask(question)}>
                  重试
                </button>
              </p>
            ) : answer ? (
              <>
                <p className="graph-ask-question">{answer.question}</p>
                {answer.response ? (
                  <div className="graph-ask-answer">
                    {segments.map((segment, index) =>
                      segment.type === "text" ? (
                        <span key={index}>{segment.text}</span>
                      ) : (
                        <button
                          key={index}
                          className="graph-ask-entity"
                          type="button"
                          title={`定位到 ${segment.label}`}
                          onClick={() => onPickNode?.(segment.id)}
                        >
                          {segment.label}
                        </button>
                      ),
                    )}
                  </div>
                ) : (
                  <p className="graph-ask-status">图谱没有给出回答，可以换个问法。</p>
                )}

                {answer.references.length > 0 ? (
                  <div className="graph-ask-refs">
                    <p className="graph-ask-refs-title">引用文档</p>
                    <ul className="graph-source-list">
                      {answer.references.map((reference) => (
                        <li key={reference.objectId}>
                          <Link className="text-link" href={`/workspace/${reference.objectId}`}>
                            {reference.title}
                            <Icon name="arrow-right" size={13} />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>

          {answer && modelLine && !asking && !error ? (
            <p className="graph-ask-model">由 {modelLine} 生成</p>
          ) : null}
        </section>
      ) : null}

      <form
        className={`graph-ask-form${floating ? " graph-glass" : " panel"}`}
        role="search"
        aria-label="问图谱"
        onSubmit={handleSubmit}
      >
        <span className="graph-ask-icon" aria-hidden="true">
          <Icon name="sparkles" size={16} />
        </span>
        <input
          className="graph-ask-input"
          type="text"
          value={question}
          maxLength={MAX_QUESTION}
          autoComplete="off"
          enterKeyHint="send"
          placeholder="问图谱：例如「设计系统里品牌色是怎么定义的？」"
          aria-label="图谱问题"
          disabled={asking}
          onChange={(event) => setQuestion(event.target.value)}
        />
        {question ? (
          <button
            className="graph-ask-clear"
            type="button"
            aria-label="清空问题"
            onClick={() => setQuestion("")}
          >
            <Icon name="x" size={13} />
          </button>
        ) : null}
        <button
          className="btn btn-primary graph-ask-submit"
          type="submit"
          disabled={asking || !question.trim()}
        >
          {asking ? "正在生成…" : "提问"}
        </button>
      </form>
    </div>
  );
}
