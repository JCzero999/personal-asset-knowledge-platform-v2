/** Next 启动钩子：只在 Node 运行时挂载 outbox worker，Edge 与构建阶段不执行。 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { startSyncWorker } = await import("./server/sync-worker-runtime");
  startSyncWorker();

  // 授权自检（ADR-019）：目录漂移时大声失败，而不是带着判定空洞运行。
  try {
    const { getDb } = await import("./server/db/client");
    const { assertAuthzCatalog, countActiveOwners } = await import(
      "./server/services/user-service"
    );
    const { resolveAuthMode } = await import("./server/roles");
    const db = getDb();
    assertAuthzCatalog(db);

    const mode = resolveAuthMode();
    if (mode === "mock") {
      console.warn("[auth] AUTH_MODE=mock：固定身份直接是 owner，绝不能用于生产部署");
    } else if (mode === "logto" && countActiveOwners(db) === 0) {
      console.warn(
        "[auth] 库里没有 active owner：ADMIN_SUBS 将作为首次引导生效；若它为空，请运行 npm run admin:grant -- <sub> owner",
      );
    } else if (mode === "disabled") {
      console.warn("[auth] AUTH_MODE=disabled：没有任何身份可以登录");
    }
  } catch (error) {
    console.error("[auth] 启动自检失败", error);
  }
}
