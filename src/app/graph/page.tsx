import type { Metadata } from "next";

import { GraphDirectory } from "@/components/directory";
import { NavRail } from "@/components/nav-rail";
import {
  GraphExplorer,
  type GraphStatusView,
  type GraphSubgraphView,
} from "@/components/graph-explorer";
import type { GraphHop } from "@/lib/graph-model";
import { pickInitialLabel } from "@/lib/graph-labels";
import { getDb } from "@/server/db/client";
import {
  GRAPH_MAX_NODES_DEFAULT,
  GRAPH_MAX_NODES_MAX,
  GRAPH_MAX_NODES_MIN,
  getGraphNeighborhood,
  graphStatus,
  listGraphLabels,
} from "@/server/services/graph-service";
import { requireSession, resolveAuthMode } from "@/server/session";
import { listVocabulary } from "@/server/services/vocabulary-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "知识图谱 · 知产工作台",
  description: "从你的资产与作品里抽取实体和关系，并基于图谱提问。",
};

interface GraphPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function parseDepth(raw: string | null): GraphHop | null {
  return raw === "1" || raw === "2" || raw === "3" ? (Number(raw) as GraphHop) : null;
}

/**
 * `?maxNodes=` 是**验收 / 诊断参数**，不面向普通用户（页面上没有控件）。
 *
 * 只接受 50–600 的整数，其余（空串、小数、越界、非数字）一律回到默认 150：
 * 页面是 SSR，非法值不该把整页打成错误，服务端路由仍按 ValidationError 守住 API。
 * 同一个值同时给「首屏预取」与 `GraphExplorer` 的 `maxNodes`，客户端请求才跟得上。
 */
function parseMaxNodes(raw: string | null): number {
  if (raw === null) return GRAPH_MAX_NODES_DEFAULT;
  const value = Number(raw.trim() === "" ? Number.NaN : raw.trim());
  if (!Number.isInteger(value) || value < GRAPH_MAX_NODES_MIN || value > GRAPH_MAX_NODES_MAX) {
    return GRAPH_MAX_NODES_DEFAULT;
  }
  return value;
}

export default async function GraphPage({ searchParams }: GraphPageProps) {
  const session = await requireSession();
  const signOutHref = resolveAuthMode() === "logto" ? "/api/logto/sign-out" : null;
  const vocabulary = listVocabulary(getDb());
  const params = await searchParams;

  const requestedFocus = firstParam(params.focus)?.trim() || null;
  const initialDepth = parseDepth(firstParam(params.depth)) ?? 2;
  const maxNodes = parseMaxNodes(firstParam(params.maxNodes));

  let labels: string[] = [];
  let status: GraphStatusView | null = null;
  let initialSubgraph: GraphSubgraphView | null = null;
  let error: string | null = null;
  let statusFailed = false;

  try {
    labels = await listGraphLabels(getDb(), session.sub);
  } catch (cause) {
    console.error("[graph] 读取实体失败", cause);
    error = "图谱服务暂时没有响应，请确认本机 LightRAG 已启动。";
  }

  try {
    status = await graphStatus(getDb(), session.sub);
  } catch (cause) {
    console.error("[graph] 读取构图进度失败", cause);
    statusFailed = true;
    error ??= "图谱服务暂时没有响应，请确认本机 LightRAG 已启动。";
  }

  // URL 的 focus 优先于默认挑一个；没有 URL 时才回落到「第一个实体」。
  // 首屏预取必须与客户端请求同一个 maxNodes / depth，否则首屏与点选后的图是两个规模。
  const initialCenter = requestedFocus ?? pickInitialLabel(labels);
  if (initialCenter) {
    try {
      initialSubgraph = await getGraphNeighborhood(getDb(), session.sub, initialCenter, {
        depth: initialDepth,
        maxNodes,
      });
    } catch (cause) {
      // 不在首屏报错：客户端会用同一个 URL 再取一次，并给出重试入口。
      console.error("[graph] 读取初始邻域失败", cause);
    }
  }

  return (
    <div className="app-frame">
      <NavRail session={session} active="graph" signOutHref={signOutHref} />
      <GraphDirectory
        session={session}
        taxonomyCounts={{
          categories: vocabulary.categories.filter((item) => item.state === "active").length,
          tags: vocabulary.tags.length,
        }}
      />

      <main className="record-detail">
        <div className="detail-scroll">
          <div className="workspace graph-page">
            <header className="workspace-header graph-page-header">
              <div className="workspace-greeting">
                <p className="workspace-date">知识索引 · 实体关系</p>
                <h1>知识图谱</h1>
                <p className="workspace-subtitle">
                  把散落在资料里的概念连起来：先同步内容，再按实体浏览，或直接问图谱。
                </p>
              </div>
            </header>

            <GraphExplorer
              initialLabels={labels}
              initialStatus={status}
              initialStatusFailed={statusFailed}
              initialSubgraph={initialSubgraph}
              initialCenter={initialCenter}
              initialDepth={initialDepth}
              initialError={error}
              maxNodes={maxNodes}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
