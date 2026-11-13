"use client";

import { useEffect } from "react";
import Link from "next/link";

import { Icon } from "@/components/icon";

/** 后台页面的错误兜底：保留重试入口，不吞掉错误信息。 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[admin] 页面渲染失败", error);
  }, [error]);

  return (
    <div className="app-frame">
      <main className="record-detail" style={{ gridColumn: "1 / -1" }}>
        <div className="detail-scroll">
          <div className="workspace">
            <header className="workspace-header">
              <div className="workspace-greeting">
                <p className="workspace-date">系统</p>
                <h1>页面没有加载成功</h1>
                <p className="workspace-subtitle">
                  可能是数据库或依赖服务暂时不可用；可以重试，或稍后刷新。
                </p>
              </div>
            </header>
            <section className="panel empty-state" role="alert">
              <span className="empty-icon"><Icon name="alert" size={26} /></span>
              <div className="empty-copy">
                <strong>渲染时出错</strong>
                <p>{error.message || "未知错误"}</p>
                <div className="admin-error-actions">
                  <button className="btn btn-primary" type="button" onClick={reset}>
                    重试
                  </button>
                  <Link className="btn btn-secondary" href="/workspace">回到工作台</Link>
                </div>
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
