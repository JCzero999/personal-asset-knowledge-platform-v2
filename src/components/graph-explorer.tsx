"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { pickInitialLabel, sortLabels } from "@/lib/graph-labels";
import { layoutRadial, visibleEdges } from "@/lib/graph-layout";
import { Icon } from "./icon";

export interface GraphNodeView {
  id: string;
  type: string;
  description: string;
}

export interface GraphEdgeView {
  source: string;
  target: string;
  description: string;
}

export interface GraphSubgraphView {
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
}

export interface GraphStatusView {
  total: number;
  byStatus: Record<string, number>;
  failed: Array<{ objectId: string; error: string }>;
}

export interface GraphReferenceView {
  objectId: string;
  title: string;
  type: "asset" | "work";
  library: "internal" | "external";
}

export interface GraphAnswerView {
  question: string;
  response: string;
  references: GraphReferenceView[];
}

export interface GraphSyncResultView {
  candidates: number;
  submitted: number;
  unchanged: number;
  skipped: Array<{ objectId: string; title: string; reason: string }>;
  removed: number;
  errors: Array<{ objectId: string; title: string; message: string }>;
}

const CANVAS_WIDTH = 640;
const CANVAS_HEIGHT = 420;

function isWorking(status: GraphStatusView | null): boolean {
  if (!status) return false;
  return (status.byStatus.pending ?? 0) + (status.byStatus.processing ?? 0) > 0;
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: { message?: string } })
    | null;
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `请求失败（${response.status}）`);
  }
  return payload as T;
}

function shortLabel(id: string, max = 10): string {
  return id.length > max ? `${id.slice(0, max)}…` : id;
}

export function GraphExplorer({
  initialLabels,
  initialStatus,
  initialSubgraph,
  initialError,
}: {
  initialLabels: string[];
  initialStatus: GraphStatusView | null;
  initialSubgraph: GraphSubgraphView | null;
  initialError: string | null;
}) {
  const [labels, setLabels] = useState<string[]>(sortLabels(initialLabels));
  const [status, setStatus] = useState<GraphStatusView | null>(initialStatus);
  const [serviceError, setServiceError] = useState<string | null>(initialError);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(pickInitialLabel(initialLabels));

  const [subgraph, setSubgraph] = useState<GraphSubgraphView | null>(initialSubgraph);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);

  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<GraphAnswerView | null>(null);
  const [answerError, setAnswerError] = useState<string | null>(null);

  const graphRequest = useRef(0);

  const loadGraph = useCallback(async (label: string) => {
    const ticket = ++graphRequest.current;
    setGraphLoading(true);
    setGraphError(null);
    try {
      const data = await readJson<GraphSubgraphView>(
        await fetch(`/api/graph?label=${encodeURIComponent(label)}&depth=2`, {
          cache: "no-store",
        }),
      );
      if (ticket !== graphRequest.current) return;
      setSubgraph(data);
    } catch (error) {
      if (ticket !== graphRequest.current) return;
      setSubgraph(null);
      setGraphError(error instanceof Error ? error.message : "图谱加载失败");
    } finally {
      if (ticket === graphRequest.current) setGraphLoading(false);
    }
  }, []);

  const refreshStatus = useCallback(async (): Promise<GraphStatusView | null> => {
    try {
      const data = await readJson<GraphStatusView>(
        await fetch("/api/graph/status", { cache: "no-store" }),
      );
      setStatus(data);
      setServiceError(null);
      return data;
    } catch (error) {
      setServiceError(error instanceof Error ? error.message : "图谱服务没有响应");
      return null;
    }
  }, []);

  const refreshLabels = useCallback(async () => {
    try {
      const data = await readJson<{ labels: string[] }>(
        await fetch("/api/graph/labels", { cache: "no-store" }),
      );
      const next = sortLabels(data.labels);
      setLabels(next);
      setServiceError(null);
      setSelected((current) => current ?? next[0] ?? null);
    } catch (error) {
      setServiceError(error instanceof Error ? error.message : "图谱服务没有响应");
    }
  }, []);

  useEffect(() => {
    if (!isWorking(status)) return;
    const timer = setInterval(() => {
      void refreshStatus().then((next) => {
        if (next && next.byStatus.processed) void refreshLabels();
      });
    }, 15_000);
    return () => clearInterval(timer);
  }, [status, refreshStatus, refreshLabels]);

  const selectEntity = (label: string) => {
    setSelected(label);
    void loadGraph(label);
  };

  const visibleLabels = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    if (!keyword) return labels;
    return labels.filter((label) => label.toLowerCase().includes(keyword));
  }, [filter, labels]);

  const layout = useMemo(() => {
    if (!subgraph) return [];
    return layoutRadial(
      subgraph.nodes.map((node) => ({
        id: node.id,
        type: node.type,
        description: node.description,
      })),
      { width: CANVAS_WIDTH, height: CANVAS_HEIGHT, ...(selected ? { centerId: selected } : {}) },
    );
  }, [subgraph, selected]);

  const positions = useMemo(
    () => new Map(layout.map((node) => [node.id, node])),
    [layout],
  );

  const drawnEdges = useMemo(
    () => (subgraph ? visibleEdges(subgraph.edges, layout) : []),
    [subgraph, layout],
  );

  const centerNode = layout.find((node) => node.center) ?? null;
  const working = isWorking(status);

  async function handleSync() {
    setSyncing(true);
    setSyncNote(null);
    try {
      const result = await readJson<GraphSyncResultView>(
        await fetch("/api/graph/sync", { method: "POST" }),
      );

      const parts = [`检查了 ${result.candidates} 个对象`];
      if (result.submitted > 0) parts.push(`新送 ${result.submitted} 个`);
      if (result.unchanged > 0) parts.push(`未变化 ${result.unchanged} 个`);
      if (result.removed > 0) parts.push(`更新 ${result.removed} 个旧版本`);
      if (result.skipped.length > 0) parts.push(`跳过 ${result.skipped.length} 个（无正文）`);
      if (result.errors.length > 0) parts.push(`${result.errors.length} 个失败`);

      setSyncNote(
        result.submitted > 0
          ? `${parts.join("，")}。抽取在本机后台进行，稍等后点「刷新进度」。`
          : `${parts.join("，")}。`,
      );

      await refreshStatus();
      if (result.submitted > 0) {
        setSelected(null);
        setSubgraph(null);
      }
    } catch (error) {
      setSyncNote(error instanceof Error ? error.message : "同步失败");
    } finally {
      setSyncing(false);
    }
  }

  async function refreshAll() {
    const next = await refreshStatus();
    if (next) await refreshLabels();
  }

  async function ask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || asking) return;

    setAsking(true);
    setAnswerError(null);
    try {
      const data = await readJson<GraphAnswerView>(
        await fetch("/api/graph/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q: trimmed }),
        }),
      );
      setAnswer(data);
    } catch (error) {
      setAnswer(null);
      setAnswerError(error instanceof Error ? error.message : "问答暂时不可用");
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="graph-workspace">
      <section className="panel graph-toolbar" aria-label="图谱状态">
        <div className="graph-status">
          <span className={`graph-dot${working ? " is-working" : ""}`} aria-hidden="true" />
          <div>
            <strong>
              {status
                ? `${status.total} 个内容已进图谱${
                    status.byStatus.processed ? ` · ${status.byStatus.processed} 个完成抽取` : ""
                  }`
                : "图谱服务未连接"}
            </strong>
            <p>
              {status && working
                ? `还有 ${(status.byStatus.pending ?? 0) + (status.byStatus.processing ?? 0)} 个在排队或抽取，本机模型较慢，几分钟属正常。`
                : "图谱从你的对象正文里抽实体和关系，只对本账号可见。"}
            </p>
          </div>
        </div>
        <div className="graph-toolbar-actions">
          <button className="btn btn-ghost" type="button" onClick={() => void refreshAll()}>
            <Icon name="refresh" size={16} />
            刷新进度
          </button>
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => void handleSync()}
            disabled={syncing}
          >
            <Icon name="sparkles" size={16} />
            {syncing ? "正在同步…" : "同步内容到图谱"}
          </button>
        </div>
      </section>

      {syncNote ? <p className="graph-note" role="status">{syncNote}</p> : null}
      {serviceError ? (
        <p className="graph-note graph-note-error" role="alert">
          {serviceError}
        </p>
      ) : null}

      <div className="graph-grid">
        <aside className="panel graph-side" aria-label="实体列表">
          <div className="graph-side-head">
            <h2>实体</h2>
            <span className="meta-chip">{labels.length} 个</span>
          </div>
          <label className="graph-filter">
            <Icon name="search" size={15} />
            <input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="筛选实体"
              aria-label="筛选实体"
            />
          </label>

          {labels.length === 0 ? (
            <p className="graph-side-empty">
              还没有实体。先点右上角「同步内容到图谱」，等抽取完成后再刷新。
            </p>
          ) : visibleLabels.length === 0 ? (
            <p className="graph-side-empty">没有匹配「{filter.trim()}」的实体。</p>
          ) : (
            <ul className="graph-label-list">
              {visibleLabels.map((label) => (
                <li key={label}>
                  <button
                    className={`graph-label${label === selected ? " active" : ""}`}
                    type="button"
                    onClick={() => selectEntity(label)}
                    aria-pressed={label === selected}
                  >
                    <span>{label}</span>
                    {label === selected ? <Icon name="arrow-right" size={13} /> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <div className="graph-main">
          <section className="panel graph-canvas-panel">
            <div className="panel-heading">
              <div>
                <h2>{selected ?? "图谱视图"}</h2>
                <p>点圆点切换中心实体；只展开两层邻居。</p>
              </div>
              {subgraph ? (
                <span className="meta-chip">
                  {subgraph.nodes.length} 个实体 · {subgraph.edges.length} 条关系
                </span>
              ) : null}
            </div>

            {graphLoading ? (
              <div className="graph-placeholder">正在读取图谱…</div>
            ) : graphError ? (
              <div className="graph-placeholder graph-placeholder-error" role="alert">
                <p>{graphError}</p>
                {selected ? (
                  <button className="btn btn-secondary" type="button" onClick={() => void loadGraph(selected)}>
                    重试
                  </button>
                ) : null}
              </div>
            ) : !subgraph || subgraph.nodes.length === 0 ? (
              <div className="graph-placeholder">
                这个实体还没有可见的邻居。换一个实体，或先同步更多内容。
              </div>
            ) : (
              <>
                <svg
                  className="graph-canvas"
                  viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
                  role="img"
                  aria-label={`${selected ?? "实体"}的两层邻域`}
                >
                  <g className="graph-edges">
                    {drawnEdges.map((edge, index) => {
                      const from = positions.get(edge.source);
                      const to = positions.get(edge.target);
                      if (!from || !to) return null;
                      return (
                        <line
                          key={`${edge.source}-${edge.target}-${index}`}
                          x1={from.x}
                          y1={from.y}
                          x2={to.x}
                          y2={to.y}
                          className="graph-edge"
                        >
                          <title>{edge.description || `${edge.source} → ${edge.target}`}</title>
                        </line>
                      );
                    })}
                  </g>
                  <g className="graph-nodes">
                    {layout.map((node) => (
                      <g
                        key={node.id}
                        className={`graph-node${node.center ? " center" : ""}`}
                        onClick={() => {
                          if (!node.center) selectEntity(node.id);
                        }}
                        role={node.center ? undefined : "button"}
                        tabIndex={node.center ? undefined : 0}
                        onKeyDown={(event) => {
                          if (!node.center && (event.key === "Enter" || event.key === " ")) {
                            event.preventDefault();
                            selectEntity(node.id);
                          }
                        }}
                      >
                        <title>{node.description || node.id}</title>
                        <circle cx={node.x} cy={node.y} r={node.radius} />
                        <text
                          x={node.x}
                          y={node.y + node.radius + 15}
                          textAnchor="middle"
                          className="graph-node-label"
                        >
                          {shortLabel(node.id, node.center ? 12 : 10)}
                        </text>
                      </g>
                    ))}
                  </g>
                </svg>

                {centerNode ? (
                  <div className="graph-detail">
                    <div className="graph-detail-head">
                      <strong>{centerNode.id}</strong>
                      {centerNode.type ? <span className="badge">{centerNode.type}</span> : null}
                    </div>
                    <p>{centerNode.description || "这个实体还没有生成描述。"}</p>
                  </div>
                ) : null}
              </>
            )}
          </section>

          <section className="panel graph-qa" aria-label="图谱问答">
            <div className="panel-heading">
              <div>
                <h2>问图谱</h2>
                <p>回答会同时参考图谱关系与内容片段，并标出来源对象。</p>
              </div>
            </div>
            <form className="graph-qa-form" onSubmit={(event) => void ask(event)}>
              <textarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="例如：设计系统里品牌色是怎么定义的？"
                rows={2}
                maxLength={200}
                aria-label="图谱问题"
                disabled={asking}
              />
              <button className="btn btn-primary" type="submit" disabled={asking || !question.trim()}>
                {asking ? "思考中…" : "提问"}
              </button>
            </form>

            {asking ? (
              <p className="graph-qa-hint">本机模型逐字生成答案，通常需要十几秒到一分多钟。</p>
            ) : null}

            {answerError ? (
              <p className="graph-note graph-note-error" role="alert">{answerError}</p>
            ) : null}

            {answer ? (
              <div className="graph-answer">
                <p className="graph-answer-question">{answer.question}</p>
                <div className="graph-answer-text">{answer.response || "图谱没有给出回答。"}</div>
                {answer.references.length > 0 ? (
                  <div className="graph-answer-refs">
                    <p className="graph-answer-refs-title">来源对象</p>
                    <ul>
                      {answer.references.map((ref) => (
                        <li key={ref.objectId}>
                          <Link className="text-link" href={`/workspace/${ref.objectId}`}>
                            {ref.title}
                            <Icon name="arrow-right" size={13} />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}
