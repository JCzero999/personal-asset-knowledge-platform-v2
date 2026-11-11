import Link from "next/link";

import { Icon } from "./icon";

interface WelcomePageProps {
  signedIn: boolean;
  userName: string | null;
}

export function WelcomePage({ signedIn, userName }: WelcomePageProps) {
  return (
    <main className="welcome-page">
      <header className="welcome-header">
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
        <span className="local-badge"><span />本地应用</span>
      </header>

      <section className="welcome-content">
        <div className="welcome-copy">
          <p className="eyebrow"><Icon name="sparkles" size={16} /> PERSONAL KNOWLEDGE WORKSPACE</p>
          <h1>让每一份资产，<br /><em>都能继续生长。</em></h1>
          <p className="welcome-description">
            以 RAGFlow 为内容底座，连接资产管理与四阶段工作流，<br className="desktop-break" />
            让知识从记录走向完成、发布与实践。
          </p>
          {signedIn ? (
            <>
              <Link className="primary-button" href="/workspace">
                {userName ? `${userName}，进入工作台` : "进入工作台"}
                <Icon name="arrow-right" size={18} />
              </Link>
              <p className="mock-note">当前使用本地开发会话，接入 Logto 后改为真实登录</p>
            </>
          ) : (
            <>
              <span className="primary-button" aria-disabled="true">
                登录尚未接入<Icon name="arrow-right" size={18} />
              </span>
              <p className="mock-note">需要先完成 Logto 管理员账号与应用配置</p>
            </>
          )}
        </div>

        <div className="welcome-visual" aria-label="目标架构预览">
          <div className="visual-orbit orbit-one" />
          <div className="visual-orbit orbit-two" />
          <div className="core-card">
            <span className="core-icon"><Icon name="database" size={30} /></span>
            <small>唯一内容真相源</small>
            <strong>RAGFlow</strong>
            <span className="pending-pill">部署中</span>
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
        <span>Next.js App Router · SQLite 业务库</span>
      </footer>
    </main>
  );
}
