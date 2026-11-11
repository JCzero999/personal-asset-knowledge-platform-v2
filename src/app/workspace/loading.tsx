export default function WorkspaceLoading() {
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-hidden="true">
        <div className="brand">
          <span className="brand-mark">
            <span />
            <span />
            <span />
          </span>
          <span className="brand-copy">
            <strong>知产工作台</strong>
            <small>ASSET &amp; KNOWLEDGE</small>
          </span>
        </div>
        <div className="main-nav">
          <p className="nav-label">工作空间</p>
          <span className="skeleton sk-nav" />
          <span className="skeleton sk-nav" />
          <span className="skeleton sk-nav" />
        </div>
      </aside>

      <main className="workspace" aria-busy="true" aria-label="正在加载工作台">
        <div className="workspace-loading">
          <div className="skeleton sk-title" />
          <div className="skeleton sk-sub" />
          <div className="skeleton sk-overview" />
          <div className="skeleton sk-panel" />
          <div className="dashboard-grid">
            <div className="skeleton sk-panel tall" />
            <div className="skeleton sk-panel" />
          </div>
        </div>
      </main>
    </div>
  );
}
