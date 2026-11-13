"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { apiErrorMessage, apiRequest } from "@/lib/api-client";
import { Icon } from "./icon";

type MaintenanceJob = "sync" | "parse";

const jobCopy: Record<MaintenanceJob, { label: string; running: string; done: string }> = {
  sync: {
    label: "立即同步队列",
    running: "同步中…",
    done: "已跑完一轮同步投递，统计随即刷新。",
  },
  parse: {
    label: "推进解析状态",
    running: "检查中…",
    done: "已跑完一轮解析状态检查，统计随即刷新。",
  },
};

/**
 * 管理后台的维护动作。
 *
 * 两个按钮都只是「手动催一轮」，和后台定时任务是同一段逻辑，
 * 服务端已限定只有管理员可以调用。
 */
export function AdminActions({
  canSync = true,
  canParse = true,
}: {
  /* 由页面按 content:sync / content:parse 传入，避免按钮点下去才 403。 */
  canSync?: boolean;
  canParse?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<MaintenanceJob | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(job: MaintenanceJob) {
    if (busy) return;

    setBusy(job);
    setMessage(null);
    setError(null);

    try {
      await apiRequest(`/api/${job}/run`, { method: "POST" });
      setMessage(jobCopy[job].done);
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  if (!canSync && !canParse) return null;

  return (
    <div className="admin-actions">
      <div className="admin-action-buttons">
        {canSync ? (
        <button
          className="btn btn-primary"
          type="button"
          disabled={busy !== null}
          onClick={() => void run("sync")}
        >
          {busy === "sync" ? (
            <span className="spinner" aria-hidden="true" />
          ) : (
            <Icon name="refresh" size={15} />
          )}
          {busy === "sync" ? jobCopy.sync.running : jobCopy.sync.label}
        </button>
        ) : null}
        {canParse ? (
        <button
          className="btn btn-secondary"
          type="button"
          disabled={busy !== null}
          onClick={() => void run("parse")}
        >
          {busy === "parse" ? (
            <span className="spinner spinner-dark" aria-hidden="true" />
          ) : (
            <Icon name="clock" size={15} />
          )}
          {busy === "parse" ? jobCopy.parse.running : jobCopy.parse.label}
        </button>
        ) : null}
      </div>

      {message ? (
        <p className="admin-action-note" role="status">
          <Icon name="check" size={14} />
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="admin-action-note is-error" role="alert">
          <Icon name="alert" size={14} />
          {error}
        </p>
      ) : null}
    </div>
  );
}
