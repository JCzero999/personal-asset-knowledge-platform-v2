"use client";

import { Icon } from "@/components/icon";

export default function WorkspaceError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="error-page">
      <span className="error-icon"><Icon name="alert" size={26} /></span>
      <h1>工作台暂时打不开</h1>
      <p>读取本地内容时出了点问题，稍后重试通常就能恢复。</p>
      <button className="btn btn-primary" type="button" onClick={() => reset()}>
        重新加载
      </button>
    </main>
  );
}
