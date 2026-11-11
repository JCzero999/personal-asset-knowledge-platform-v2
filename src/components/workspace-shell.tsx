"use client";

import { useState } from "react";
import { Icon, type IconName } from "./icon";

const navigation: Array<{ label: string; icon: IconName; enabled?: boolean }> = [
  { label: "工作台", icon: "grid", enabled: true },
  { label: "我的资产", icon: "archive" },
  { label: "作品工作流", icon: "workflow" },
  { label: "内容检索", icon: "search" },
  { label: "知识图谱", icon: "graph" },
];

const stages = [
  { key: "draft", order: "01", title: "草稿", description: "沉淀想法与内容", icon: "file" as IconName },
  { key: "finished", order: "02", title: "完成", description: "形成完整作品", icon: "check" as IconName },
  { key: "published", order: "03", title: "发布", description: "让知识产生价值", icon: "book" as IconName },
  { key: "practiced", order: "04", title: "实践", description: "回到行动与反馈", icon: "sparkles" as IconName },
];

function Brand() {
  return (
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
  );
}

export function WorkspaceShell() {
  const [session, setSession] = useState<"anonymous" | "mock">("anonymous");

  if (session === "anonymous") {
    return (
      <main className="welcome-page">
        <header className="welcome-header">
          <Brand />
          <span className="local-badge"><span />本地应用骨架</span>
        </header>

        <section className="welcome-content">
          <div className="welcome-copy">
            <p className="eyebrow"><Icon name="sparkles" size={16} /> PERSONAL KNOWLEDGE WORKSPACE</p>
            <h1>让每一份资产，<br /><em>都能继续生长。</em></h1>
            <p className="welcome-description">
              以 RAGFlow 为内容底座，连接资产管理与四阶段工作流，<br className="desktop-break" />
              让知识从记录走向完成、发布与实践。
            </p>
            <button className="primary-button" type="button" onClick={() => setSession("mock")}>
              预览已登录工作台<Icon name="arrow-right" size={18} />
            </button>
            <p className="mock-note">仅切换 Mock 用户界面，不会连接或跳转至 Logto</p>
          </div>

          <div className="welcome-visual" aria-label="目标架构预览">
            <div className="visual-orbit orbit-one" />
            <div className="visual-orbit orbit-two" />
            <div className="core-card">
              <span className="core-icon"><Icon name="database" size={30} /></span>
              <small>唯一内容真相源</small>
              <strong>RAGFlow</strong>
              <span className="pending-pill">等待 Docker 接入</span>
            </div>
            <div className="floating-card card-asset">
              <Icon name="archive" size={22} />
              <span><small>业务层</small><strong>资产管理</strong></span>
            </div>
            <div className="floating-card card-flow">
              <Icon name="workflow" size={22} />
              <span><small>四阶段</small><strong>作品工作流</strong></span>
            </div>
            <div className="floating-card card-graph">
              <Icon name="graph" size={22} />
              <span><small>独立存储</small><strong>LightRAG</strong></span>
            </div>
          </div>
        </section>

        <footer className="welcome-footer">
          <span>ADR-005 · 内容与业务状态分离</span>
          <span>Greenfield · Next.js App Router</span>
        </footer>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <nav className="main-nav" aria-label="主导航">
          <p className="nav-label">工作空间</p>
          {navigation.map((item) => (
            item.enabled ? (
              <a className="nav-item active" href="#overview" key={item.label}>
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
            <div><strong>内容底座尚未连接</strong><p>业务侧只保存元数据、状态与 content_ref。</p></div>
          </div>
          <button className="nav-item settings-item" type="button" disabled title="将在后续阶段接入">
            <Icon name="settings" /><span>设置</span>
          </button>
          <div className="sidebar-version">本地预览 · v0.1.0</div>
        </div>
      </aside>

      <main className="workspace" id="overview">
        <header className="workspace-header">
          <div>
            <p className="breadcrumb">工作空间 / 工作台</p>
            <h1>欢迎回来，林默</h1>
          </div>
          <div className="header-actions">
            <span className="mock-session"><span />Mock 会话</span>
            <button className="avatar" type="button" onClick={() => setSession("anonymous")} title="退出 Mock 预览" aria-label="退出 Mock 预览">林</button>
          </div>
        </header>

        <div className="preview-banner">
          <Icon name="sparkles" size={18} />
          <p><strong>当前为 UI 骨架。</strong>身份使用 Mock 用户，Logto、RAGFlow 与业务数据尚未连接。</p>
          <button type="button" onClick={() => setSession("anonymous")}><Icon name="logout" size={16} />退出预览</button>
        </div>

        <section className="stats-grid" aria-label="业务概览占位">
          {[
            { label: "全部资产", caption: "等待业务数据", icon: "archive" as IconName, tone: "green" },
            { label: "已完成作品", caption: "等待业务数据", icon: "check" as IconName, tone: "blue" },
            { label: "已发布", caption: "等待业务数据", icon: "book" as IconName, tone: "amber" },
            { label: "已实践", caption: "等待业务数据", icon: "sparkles" as IconName, tone: "violet" },
          ].map((stat) => (
            <article className="stat-card" key={stat.label}>
              <div className={`stat-icon ${stat.tone}`}><Icon name={stat.icon} size={21} /></div>
              <div className="stat-title">{stat.label}<span>—</span></div>
              <p>{stat.caption}</p>
            </article>
          ))}
        </section>

        <section className="dashboard-grid">
          <article className="panel workflow-panel">
            <div className="panel-heading">
              <div><h2>作品工作流</h2><p>从灵感沉淀到实践反馈</p></div>
              <span className="draft-badge">状态机 DRAFT</span>
            </div>
            <div className="stage-list">
              {stages.map((stage, index) => (
                <div className="stage-item" key={stage.key}>
                  <div className="stage-order">{stage.order}</div>
                  <span className="stage-icon"><Icon name={stage.icon} size={20} /></span>
                  <div className="stage-copy"><strong>{stage.title}</strong><small>{stage.key}</small></div>
                  <p>{stage.description}</p>
                  <span className="stage-count">—</span>
                  {index < stages.length - 1 && <span className="stage-connector" aria-hidden="true" />}
                </div>
              ))}
            </div>
            <div className="panel-footnote"><span />流转只更新业务状态，不移动 RAGFlow 中的内容</div>
          </article>

          <article className="panel connection-panel">
            <div className="panel-heading"><div><h2>接入状态</h2><p>真实服务连接进度</p></div></div>
            <div className="connection-list">
              <div><span className="service-icon"><Icon name="check" size={18} /></span><p><strong>Next.js 骨架</strong><small>App Router + TypeScript</small></p><span className="status-ready">已创建</span></div>
              <div><span className="service-icon"><Icon name="settings" size={18} /></span><p><strong>Logto</strong><small>登录 / 注册 / 会话</small></p><span className="status-pending">待 Docker</span></div>
              <div><span className="service-icon"><Icon name="database" size={18} /></span><p><strong>RAGFlow</strong><small>统一内容存储与检索</small></p><span className="status-pending">待 Docker</span></div>
              <div><span className="service-icon"><Icon name="graph" size={18} /></span><p><strong>LightRAG</strong><small>独立知识图谱存储</small></p><span className="status-later">Phase 3</span></div>
            </div>
          </article>
        </section>

        <section className="panel empty-panel">
          <div className="panel-heading"><div><h2>最近内容</h2><p>资产与作品将在这里呈现</p></div></div>
          <div className="empty-state">
            <span><Icon name="file" size={26} /></span>
            <div><strong>工作台已准备好</strong><p>业务数据尚未接入，这里不会用虚构的资产或 content_ref 填充。</p></div>
          </div>
        </section>
      </main>
    </div>
  );
}
