"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { apiErrorMessage, apiRequest } from "@/lib/api-client";
import { formatDateTime } from "@/lib/content-format";
import type { AdminUser, RoleCatalogEntry } from "@/server/services/user-service";
import { Icon } from "./icon";

/**
 * 用户与账号（ADR-019）：改角色、停用/启用。
 *
 * 所有判定都在服务端；这里只负责收集意图、做二次确认、把 422 的
 * LAST_OWNER 原因翻译成人话。停用与降级都是破坏性操作，一律弹窗确认。
 */

const roleHints: Record<string, string> = {
  owner: "全部权限，包括用户与角色维护",
  admin: "除用户、角色维护外的全部权限",
  editor: "查看并编辑内容，不能删除或导出",
  viewer: "只读",
};

type PendingAction =
  | { kind: "roles"; user: AdminUser }
  | { kind: "disable"; user: AdminUser }
  | { kind: "enable"; user: AdminUser };

export function AdminUsers({
  users,
  roles,
  canWrite,
  currentUserId,
}: {
  users: AdminUser[];
  roles: RoleCatalogEntry[];
  canWrite: boolean;
  currentUserId: string | null;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);

  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<"all" | "active" | "disabled">("all");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [draftRoles, setDraftRoles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const roleLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const role of roles) map.set(role.key, role.label);
    return map;
  }, [roles]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return users.filter((user) => {
      if (stateFilter !== "all" && user.state !== stateFilter) return false;
      if (!needle) return true;
      return (
        user.displayName.toLowerCase().includes(needle)
        || user.sub.toLowerCase().includes(needle)
        || (user.email ?? "").toLowerCase().includes(needle)
      );
    });
  }, [users, query, stateFilter]);

  useEffect(() => {
    if (!pending) return;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, [pending]);

  function openRoles(user: AdminUser) {
    setDraftRoles(user.roles.length > 0 ? [user.roles[0]] : ["viewer"]);
    setError(null);
    setPending({ kind: "roles", user });
  }

  function openAction(kind: "disable" | "enable", user: AdminUser) {
    setError(null);
    setPending({ kind, user });
  }

  function closeDialog() {
    if (busy) return;
    setPending(null);
    setError(null);
  }

  async function submit() {
    if (!pending || busy) return;

    if (pending.kind === "roles" && draftRoles.length === 0) {
      setError("至少要保留一个角色。");
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const body =
        pending.kind === "roles"
          ? { roles: draftRoles }
          : { state: pending.kind === "disable" ? "disabled" : "active" };

      await apiRequest(`/api/admin/users/${pending.user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      setNotice(
        pending.kind === "roles"
          ? `已更新「${pending.user.displayName}」的角色。`
          : pending.kind === "disable"
            ? `已停用「${pending.user.displayName}」。`
            : `已启用「${pending.user.displayName}」。`,
      );
      setPending(null);
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const heading =
    pending?.kind === "roles"
      ? "修改角色"
      : pending?.kind === "disable"
        ? "停用账号"
        : "启用账号";

  const target = pending?.user ?? null;

  return (
    <>
      <div className="admin-toolbar">
        <label className="admin-search">
          <Icon name="search" size={15} />
          <input
            type="search"
            value={query}
            placeholder="搜索名称、sub 或邮箱"
            aria-label="搜索账号"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="admin-filter-chips" role="group" aria-label="按状态筛选">
          {(
            [
              ["all", "全部"],
              ["active", "使用中"],
              ["disabled", "已停用"],
            ] as const
          ).map(([key, label]) => (
            <button
              className={`chip${stateFilter === key ? " is-active" : ""}`}
              type="button"
              key={key}
              aria-pressed={stateFilter === key}
              onClick={() => setStateFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="admin-toolbar-count">
          {filtered.length} / {users.length} 个账号
        </span>
      </div>

      {notice ? (
        <p className="admin-action-note" role="status">
          <Icon name="check" size={14} />
          {notice}
        </p>
      ) : null}

      <section className="panel admin-table-panel" aria-label="账号列表">
        {users.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon"><Icon name="inbox" size={26} /></span>
            <div className="empty-copy">
              <strong>还没有任何账号</strong>
              <p>有人第一次登录后，这里会出现对应记录。</p>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon"><Icon name="search" size={26} /></span>
            <div className="empty-copy">
              <strong>没有匹配的账号</strong>
              <p>换个关键字，或把状态筛选切回「全部」。</p>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => {
                  setQuery("");
                  setStateFilter("all");
                }}
              >
                清空筛选
              </button>
            </div>
          </div>
        ) : (
          <div className="admin-table-scroll">
            <table className="admin-table admin-users-table">
              <thead>
                <tr>
                  <th scope="col">账号</th>
                  <th scope="col">角色</th>
                  <th scope="col">内容</th>
                  <th scope="col">最近登录</th>
                  <th scope="col">状态</th>
                  {canWrite ? <th scope="col">操作</th> : null}
                </tr>
              </thead>
              <tbody>
                {filtered.map((user) => {
                  const isSelf = user.id === currentUserId;
                  return (
                    <tr key={user.id} data-state={user.state}>
                      <td data-label="账号">
                        <div className="admin-user-cell">
                          <strong>
                            {user.displayName}
                            {isSelf ? <span className="meta-chip">你</span> : null}
                          </strong>
                          <code className="admin-sub" title={user.sub}>{user.sub}</code>
                          {user.email ? <span className="admin-user-email">{user.email}</span> : null}
                        </div>
                      </td>
                      <td data-label="角色">
                        <div className="admin-role-chips">
                          {user.roles.length === 0 ? (
                            <span className="admin-badge is-muted">无角色</span>
                          ) : (
                            user.roles.map((role) => (
                              <span
                                className={`admin-badge${role === "owner" ? " is-owner" : ""}`}
                                key={role}
                              >
                                {roleLabel.get(role) ?? role}
                              </span>
                            ))
                          )}
                        </div>
                      </td>
                      <td data-label="内容">{user.objects}</td>
                      <td data-label="最近登录" className="admin-time">
                        {formatDateTime(user.lastSeenAt)}
                      </td>
                      <td data-label="状态">
                        <span
                          className={`admin-badge ${user.state === "active" ? "is-ok" : "is-error"}`}
                        >
                          {user.state === "active" ? "使用中" : "已停用"}
                        </span>
                      </td>
                      {canWrite ? (
                        <td data-label="操作">
                          <div className="admin-row-actions">
                            <button
                              className="text-button"
                              type="button"
                              onClick={() => openRoles(user)}
                            >
                              改角色
                            </button>
                            {user.state === "active" ? (
                              <button
                                className="text-button is-danger"
                                type="button"
                                disabled={isSelf}
                                title={isSelf ? "不能停用自己的账号" : undefined}
                                onClick={() => openAction("disable", user)}
                              >
                                停用
                              </button>
                            ) : (
                              <button
                                className="text-button"
                                type="button"
                                onClick={() => openAction("enable", user)}
                              >
                                启用
                              </button>
                            )}
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {pending && target ? (
        <dialog
          ref={dialogRef}
          className="dialog dialog-sm"
          aria-labelledby="admin-user-dialog-heading"
          aria-busy={busy}
          onClose={closeDialog}
          onClick={(event) => {
            if (event.target === dialogRef.current) closeDialog();
          }}
        >
          <form
            className="dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <header className="dialog-head">
              <div>
                <h2 id="admin-user-dialog-heading">{heading}</h2>
                <p>
                  {target.displayName} · <code className="admin-sub">{target.sub}</code>
                </p>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭"
                disabled={busy}
                onClick={closeDialog}
              >
                <Icon name="x" size={18} />
              </button>
            </header>

            <div className="dialog-body">
              {pending.kind === "roles" ? (
                <div className="role-choice" role="radiogroup" aria-label="选择角色">
                  {roles.map((role) => (
                    <label
                      className={`role-choice-item${draftRoles[0] === role.key ? " is-active" : ""}`}
                      key={role.key}
                    >
                      <input
                        type="radio"
                        name="role"
                        value={role.key}
                        checked={draftRoles[0] === role.key}
                        onChange={() => {
                          setDraftRoles([role.key]);
                          setError(null);
                        }}
                      />
                      <span>
                        <strong>{role.label}</strong>
                        <span>{roleHints[role.key] ?? `${role.permissions.length} 项权限`}</span>
                      </span>
                      <span className="role-choice-count">{role.permissions.length}</span>
                    </label>
                  ))}
                </div>
              ) : null}

              {pending.kind === "disable" ? (
                <p className="dialog-text">
                  停用后「{target.displayName}」将无法登录，名下内容保留，所有者仍可查看和管理。
                  确定要停用吗？
                </p>
              ) : null}

              {pending.kind === "enable" ? (
                <p className="dialog-text">
                  启用后「{target.displayName}」可以继续登录，并恢复原有角色。
                </p>
              ) : null}

              {pending.kind === "roles"
              && target.roles.includes("owner")
              && draftRoles[0] !== "owner" ? (
                <p className="dialog-warning" role="note">
                  <Icon name="alert" size={14} />
                  这是所有者账号；如果系统里没有其他可用所有者，保存会被拒绝。
                </p>
              ) : null}

              {error ? (
                <p className="dialog-error" role="alert">
                  <Icon name="alert" size={14} />
                  {error}
                </p>
              ) : null}
            </div>

            <div className="dialog-actions">
              <button
                className="btn btn-secondary"
                type="button"
                disabled={busy}
                onClick={closeDialog}
              >
                取消
              </button>
              <button
                className={`btn ${pending.kind === "disable" ? "btn-danger" : "btn-primary"}`}
                type="submit"
                disabled={busy}
              >
                {busy ? <span className="spinner" aria-hidden="true" /> : null}
                {busy ? "保存中…" : pending.kind === "disable" ? "确认停用" : "确认"}
              </button>
            </div>
          </form>
        </dialog>
      ) : null}
    </>
  );
}
