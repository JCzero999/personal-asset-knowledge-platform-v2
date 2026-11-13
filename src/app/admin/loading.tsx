/** 后台页面的加载骨架：保持三列框架不跳动，内容区先占位。 */
export default function AdminLoading() {
  return (
    <div className="app-frame">
      <aside className="nav-rail" aria-hidden="true" />
      <aside className="directory admin-skeleton-dir" aria-hidden="true">
        <span className="skeleton-line" />
        <span className="skeleton-line" />
        <span className="skeleton-line" />
      </aside>
      <main className="record-detail">
        <div className="detail-scroll">
          <div className="workspace admin-workspace" aria-busy="true" aria-live="polite">
            <p className="sr-only">正在加载系统页面…</p>
            <div className="admin-skeleton-head">
              <span className="skeleton-line skeleton-line-sm" />
              <span className="skeleton-line skeleton-line-lg" />
            </div>
            <div className="admin-stats">
              {[0, 1, 2, 3, 4, 5].map((index) => (
                <div className="admin-stat" key={index}>
                  <span className="skeleton-block" />
                </div>
              ))}
            </div>
            <div className="admin-grid">
              <div className="panel admin-skeleton-panel" />
              <div className="panel admin-skeleton-panel" />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
