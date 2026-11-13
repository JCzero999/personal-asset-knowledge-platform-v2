export default function WorkspaceLoading() {
  return (
    <div className="app-frame has-list" aria-busy="true" aria-label="正在加载工作台">
      <aside className="nav-rail" aria-hidden="true">
        <span className="rail-brand">
          <span className="brand-mark">
            <span />
            <span />
            <span />
          </span>
        </span>
      </aside>
      <aside className="directory" aria-hidden="true">
        <div className="dir-head">
          <strong>工作台</strong>
        </div>
        <span className="skeleton sk-dir" />
        <span className="skeleton sk-dir" />
        <span className="skeleton sk-dir" />
      </aside>
      <section className="record-list" aria-hidden="true">
        <div className="record-list-head">
          <div className="skeleton sk-title" />
        </div>
        <div className="record-scroll">
          <span className="skeleton sk-row" />
          <span className="skeleton sk-row" />
          <span className="skeleton sk-row" />
          <span className="skeleton sk-row" />
        </div>
      </section>
      <main className="record-detail">
        <div className="detail-scroll">
          <div className="workspace workspace-loading">
            <div className="skeleton sk-title" />
            <div className="skeleton sk-sub" />
            <div className="skeleton sk-overview" />
            <div className="skeleton sk-panel" />
          </div>
        </div>
      </main>
    </div>
  );
}
