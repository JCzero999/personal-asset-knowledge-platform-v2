import type { AppDatabase } from "./db/client";

/**
 * 进程内 outbox worker：Next 启动时挂一个定时器，按固定间隔认领并投递
 * `sync_jobs`。没有配置 RAGFlow 时保持静默，避免本地只做前端时反复报错；
 * `SYNC_WORKER_ENABLED=false` 可显式关闭。
 *
 * 定时器 `unref()`：不会阻止进程退出。多进程部署时各进程会各自认领，
 * `claimJobs` 的原子认领保证同一条任务不会被处理两次。
 */

const DEFAULT_INTERVAL_MS = 30_000;

interface WorkerGlobal {
  __pakpSyncTimer?: ReturnType<typeof setInterval>;
  __pakpSyncRunning?: boolean;
}

const holder = globalThis as unknown as WorkerGlobal;

function hasRagflowConfig(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.RAGFLOW_BASE_URL?.trim() && env.RAGFLOW_API_KEY?.trim());
}

async function tick(db: AppDatabase): Promise<void> {
  if (holder.__pakpSyncRunning) {
    return;
  }
  holder.__pakpSyncRunning = true;

  try {
    const { runSyncOnce } = await import("./services/sync-service");
    const result = await runSyncOnce(db, { limit: 20 });
    if (result.failed > 0) {
      console.warn("[sync] 有任务投递失败，已按退避重试", result.errors);
    }
  } catch (error) {
    console.error(
      "[sync] worker 本轮异常",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    holder.__pakpSyncRunning = false;
  }
}

export function startSyncWorker(): void {
  if (holder.__pakpSyncTimer) {
    return;
  }
  if (process.env.SYNC_WORKER_ENABLED === "false") {
    return;
  }
  if (!hasRagflowConfig(process.env)) {
    return;
  }

  const configured = Number(process.env.SYNC_WORKER_INTERVAL_MS);
  const intervalMs =
    Number.isFinite(configured) && configured >= 5_000 ? configured : DEFAULT_INTERVAL_MS;

  // 延迟加载数据库单例：worker 启动不应影响只读页面。
  const timer = setInterval(() => {
    void (async () => {
      try {
        const { getDb } = await import("./db/client");
        await tick(getDb());
      } catch (error) {
        console.error(
          "[sync] worker 无法取得数据库连接",
          error instanceof Error ? error.message : String(error),
        );
      }
    })();
  }, intervalMs);

  timer.unref?.();
  holder.__pakpSyncTimer = timer;
}
