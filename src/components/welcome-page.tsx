import Link from "next/link";

import { Icon } from "./icon";

interface WelcomePageProps {
  signedIn: boolean;
  userName: string | null;
  /** 接好 Logto 时给出登录入口；为空表示登录尚未开放。 */
  signInHref: string | null;
}

export function WelcomePage({ signedIn, userName, signInHref }: WelcomePageProps) {
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
            把收集的资料沉淀成资产，让想法沿着四个阶段<br className="desktop-break" />
            走向完成、发布与实践。
          </p>
          {signedIn ? (
            <>
              <Link className="primary-button" href="/workspace">
                {userName ? `${userName}，进入工作台` : "进入工作台"}
                <Icon name="arrow-right" size={18} />
              </Link>
              <p className="welcome-note">本地工作区已就绪，内容只保存在这台电脑上</p>
            </>
          ) : signInHref ? (
            <>
              <a className="primary-button" href={signInHref}>
                登录<Icon name="arrow-right" size={18} />
              </a>
              <p className="welcome-note">登录后进入工作台，内容归在当前账号名下</p>
            </>
          ) : (
            <>
              <span className="primary-button" aria-disabled="true">
                登录尚未开放<Icon name="arrow-right" size={18} />
              </span>
              <p className="welcome-note">先以本地工作区使用，登录功能将在后续开放</p>
            </>
          )}
        </div>

        <div className="welcome-visual" aria-label="工作台预览">
          <div className="visual-orbit orbit-one" />
          <div className="visual-orbit orbit-two" />
          <div className="core-card">
            <span className="core-icon"><Icon name="database" size={30} /></span>
            <small>统一内容底座</small>
            <strong>内容中心</strong>
            <span className="pending-pill">准备中</span>
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
            <span><small>独立存储</small><strong>知识图谱</strong></span>
          </div>
        </div>
      </section>

      <footer className="welcome-footer">
        <span>内容与状态分开管理</span>
        <span>个人工作区 · 本地保存</span>
      </footer>
    </main>
  );
}
