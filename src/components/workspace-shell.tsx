import {
  workFormats,
  type BusinessObject,
  type WorkStatus,
} from "@/domain/objects";
import type { Session } from "@/server/ports/session";
import { Icon, type IconName } from "./icon";

const navigation: Array<{ label: string; icon: IconName; href?: string }> = [
  { label: "工作台", icon: "grid", href: "/workspace" },
  { label: "我的资产", icon: "archive" },
  { label: "作品工作流", icon: "workflow" },
  { label: "内容检索", icon: "search" },
  { label: "知识图谱", icon: "graph" },
];

const stages: Array<{
  key: WorkStatus;
  order: string;
  title: string;
  description: string;
  icon: IconName;
}> = [
  { key: "draft", order: "01", title: "草稿", description: "沉淀想法与内容", icon: "file" },
  { key: "finished", order: "02", title: "完成", description: "形成完整作品", icon: "check" },
  { key: "published", order: "03", title: "发布", description: "让知识产生价值", icon: "book" },
  { key: "practiced", order: "04", title: "实践", description: "回到行动与反馈", icon: "sparkles" },
];

const formatLabels = new Map(workFormats.map((item) => [item.value, item.label]));

const statusLabels: Record<WorkStatus, string> = {
  draft: "草稿",
  finished: "完成",
  published: "发布",
  practiced: "实践",
};

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

export function WorkspaceShell({
  session,
  objects,
}: {
  session: Session;
  objects: BusinessObject[];
}) {
  const works = objects.filter((object) => object.type === "work");
  const assets = objects.filter((object) => object.type === "asset");
  const countByStatus = (status: WorkStatus) => works.filter((work) => work.status === status).length;
  const recent = objects.slice(0, 5);

  const stats = [
    { label: "全部资产", value: assets.length, icon: "archive" as IconName, tone: "green" },
    { label: "已完成作品", value: countByStatus("finished") + countByStatus("published") + countByStatus("practiced"), icon: "check" as IconName, tone: "blue" },
    { label: "已发布", value: countByStatus("published") + countByStatus("practiced"), icon: "book" as IconName, tone: "amber" },
    { label: "已实践", value: countByStatus("practiced"), icon: "sparkles" as IconName, tone: "violet" },
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span className="brand-copy">
            <strong>知产工作台</strong>
            <small>ASSET &amp; KNOWLEDGE</small>
          </span>
        </div>
        <nav className="main-nav" aria-label="主导航">
          <p className="nav-label">工作空间</p>
          {navigation.map((item) => (
            item.href ? (
              <a className="nav-item active" href={item.href} key={item.label}>
                <Icon name={item.icon} /><span>{item.label}</span>
              </a>
            ) : (
              <button className="nav-item" type="button" disabled key={item.label} title="将在后续阶段接入">
                <Icon name={item.icon} /><span>{item.label}</span><small>待接入</small>
              </button>
            )
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="architecture-note">
            <span className="note-icon"><Icon name="database" size={18} /></span>
            <div><strong>业务库已连接</strong><p>对象与状态存于本地 SQLite，内容区等待 RAGFlow。</p></div>
          </div>
          <button className="nav-item settings-item" type="button" disabled title="将在后续阶段接入">
            <Icon name="settings" /><span>设置</span>
          </button>
          <div className="sidebar-version">本地运行 · v0.1.0</div>
        </div>
      </aside>

      <main className="workspace" id="overview">
        <header className="workspace-header">
          <div>
            <p className="breadcrumb">工作空间 / 工作台</p>
            <h1>欢迎回来，{session.name}</h1>
          </div>
          <div className="header-actions">
            <span className="mock-session"><span />本地开发会话</span>
            <span className="avatar" title={session.email ?? session.sub} aria-label={session.name}>
              {session.name.slice(0, 1)}
            </span>
          </div>
        </header>

        <div className="preview-banner">
          <Icon name="sparkles" size={18} />
          <p><strong>数据已落库。</strong>对象与状态写入本地业务库；登录仍为本地会话，Logto 管理员待创建。</p>
        </div>

        <section className="stats-grid" aria-label="业务概览">
          {stats.map((stat) => (
            <article className="stat-card" key={stat.label}>
              <div className={`stat-icon ${stat.tone}`}><Icon name={stat.icon} size={21} /></div>
              <div className="stat-title">{stat.label}<span>{stat.value}</span></div>
              <p>{stat.label === "全部资产" ? "内库与外库合计" : "按作品状态统计"}</p>
            </article>
          ))}
        </section>

        <section className="dashboard-grid">
          <article className="panel workflow-panel">
            <div className="panel-heading">
              <div><h2>作品工作流</h2><p>从灵感沉淀到实践反馈</p></div>
              <span className="draft-badge">四阶段</span>
            </div>
            <div className="stage-list">
              {stages.map((stage, index) => (
                <div className="stage-item" key={stage.key}>
                  <div className="stage-order">{stage.order}</div>
                  <span className="stage-icon"><Icon name={stage.icon} size={20} /></span>
                  <div className="stage-copy"><strong>{stage.title}</strong><small>{stage.key}</small></div>
                  <p>{stage.description}</p>
                  <span className="stage-count">{countByStatus(stage.key)}</span>
                  {index < stages.length - 1 && <span className="stage-connector" aria-hidden="true" />}
                </div>
              ))}
            </div>
            <div className="panel-footnote"><span />流转只更新业务状态，不移动 RAGFlow 中的内容</div>
          </article>

          <article className="panel connection-panel">
            <div className="panel-heading"><div><h2>接入状态</h2><p>真实服务连接进度</p></div></div>
            <div className="connection-list">
              <div><span className="service-icon"><Icon name="check" size={18} /></span><p><strong>业务库</strong><small>SQLite · Drizzle</small></p><span className="status-ready">已连接</span></div>
              <div><span className="service-icon"><Icon name="check" size={18} /></span><p><strong>Logto</strong><small>登录 / 注册 / 会话</small></p><span className="status-pending">待建管理员</span></div>
              <div><span className="service-icon"><Icon name="database" size={18} /></span><p><strong>RAGFlow</strong><small>统一内容存储与检索</small></p><span className="status-pending">部署中</span></div>
              <div><span className="service-icon"><Icon name="graph" size={18} /></span><p><strong>LightRAG</strong><small>独立知识图谱存储</small></p><span className="status-later">Phase 3</span></div>
            </div>
          </article>
        </section>

        <section className="panel empty-panel">
          <div className="panel-heading"><div><h2>最近内容</h2><p>资产与作品按更新时间排列</p></div></div>
          {recent.length === 0 ? (
            <div className="empty-state">
              <span><Icon name="file" size={26} /></span>
              <div><strong>还没有任何对象</strong><p>业务库已就绪，创建第一个资产或作品后会出现在这里。</p></div>
            </div>
          ) : (
            <ul className="object-list">
              {recent.map((object) => (
                <li className="object-row" key={object.id}>
                  <span className={`object-type ${object.type}`}>
                    {object.type === "work" ? "作品" : "资产"}
                  </span>
                  <div className="object-main">
                    <strong>{object.title}</strong>
                    <small>
                      {object.type === "work"
                        ? `${formatLabels.get(object.format) ?? object.format} · ${statusLabels[object.status]}`
                        : "资产"}
                      {" · "}
                      {object.library === "internal" ? "内库" : "外库"}
                    </small>
                  </div>
                  <span className="object-date">{formatDate(object.updatedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
