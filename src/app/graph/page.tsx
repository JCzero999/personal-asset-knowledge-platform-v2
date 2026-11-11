import type { Metadata } from "next";

import { AppSidebar } from "@/components/app-sidebar";
import {
  GraphExplorer,
  type GraphStatusView,
  type GraphSubgraphView,
} from "@/components/graph-explorer";
import { pickInitialLabel } from "@/lib/graph-labels";
import { getDb } from "@/server/db/client";
import {
  getGraphNeighborhood,
  graphStatus,
  listGraphLabels,
} from "@/server/services/graph-service";
import { requireSession, resolveAuthMode } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "知识图谱 · 知产工作台",
  description: "从你的资产与作品里抽取实体和关系，并基于图谱提问。",
};

export default async function GraphPage() {
  const session = await requireSession();
  const signOutHref = resolveAuthMode() === "logto" ? "/api/logto/sign-out" : null;

  let labels: string[] = [];
  let status: GraphStatusView | null = null;
  let initialSubgraph: GraphSubgraphView | null = null;
  let error: string | null = null;

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
    error ??= "图谱服务暂时没有响应，请确认本机 LightRAG 已启动。";
  }

  const initialLabel = pickInitialLabel(labels);
  if (initialLabel) {
    try {
      initialSubgraph = await getGraphNeighborhood(getDb(), session.sub, initialLabel);
    } catch (cause) {
      console.error("[graph] 读取初始邻域失败", cause);
    }
  }

  return (
    <div className="app-shell">
      <AppSidebar session={session} active="graph" signOutHref={signOutHref} />

      <main className="workspace graph-page">
        <header className="workspace-header">
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
          initialSubgraph={initialSubgraph}
          initialError={error}
        />
      </main>
    </div>
  );
}
