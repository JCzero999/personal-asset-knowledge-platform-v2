"use client";

import Link from "next/link";
import { useEffect } from "react";

import { Icon } from "@/components/icon";

export default function GraphError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[graph] 页面渲染失败", error);
  }, [error]);

  return (
    <main className="error-page">
      <span className="error-icon">
        <Icon name="alert" size={26} />
      </span>
      <h1>图谱暂时打不开</h1>
      <p>{error.message || "读取本地图谱时出了点问题，稍后重试通常就能恢复。"}</p>
      <div className="graph-state-actions">
        <button className="btn btn-primary" type="button" onClick={() => reset()}>
          重新加载
        </button>
        <Link className="btn btn-ghost" href="/workspace">
          回到工作台
        </Link>
      </div>
    </main>
  );
}
