/** Next 启动钩子：只在 Node 运行时挂载 outbox worker，Edge 与构建阶段不执行。 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { startSyncWorker } = await import("./server/sync-worker-runtime");
  startSyncWorker();
}
