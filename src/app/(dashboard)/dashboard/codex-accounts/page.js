"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const SESSION_KEYS = ["session", "Session"];
const WEEKLY_KEYS = ["weekly", "Weekly"];

function formatReset(resetAt) {
  if (!resetAt) return "reset -";
  const diffMs = new Date(resetAt).getTime() - Date.now();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "reset soon";
  const totalMinutes = Math.ceil(diffMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (!days && minutes) parts.push(`${minutes}m`);
  return `reset ${parts.join(" ") || "soon"}`;
}

function getQuotaByNames(quotaEntry, names) {
  const quotas = quotaEntry?.quotas || [];
  return quotas.find((quota) => names.some((name) => quota.name?.toLowerCase?.() === name.toLowerCase()));
}

function getRemaining(quota) {
  if (!quota) return null;
  if (typeof quota.remaining === "number") return Math.max(0, Math.min(100, Math.round(quota.remaining)));
  if (typeof quota.remainingPercentage === "number") return Math.max(0, Math.min(100, Math.round(quota.remainingPercentage)));
  if (typeof quota.used === "number" && typeof quota.total === "number" && quota.total > 0) {
    return Math.max(0, Math.min(100, Math.round(100 - (quota.used / quota.total) * 100)));
  }
  return null;
}

function QuotaBar({ label, quota, tone }) {
  const remaining = getRemaining(quota);
  const text = remaining == null ? "not loaded" : `${remaining}% left · ${formatReset(quota?.resetAt)}`;
  const width = remaining == null ? 0 : remaining;
  const fillClass = tone === "session"
    ? "bg-gradient-to-r from-rose-500 via-orange-400 to-orange-300"
    : "bg-gradient-to-r from-emerald-400 via-sky-400 to-violet-500";

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-text-muted">{label}</span>
        <span className={tone === "session" ? "text-orange-500" : "text-blue-500"}>{text}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
        <div className={`h-full rounded-full ${fillClass}`} style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

function AccountCard({ account, quotaEntry, loadingQuota, activating, onActivate }) {
  const sessionQuota = getQuotaByNames(quotaEntry, SESSION_KEYS);
  const weeklyQuota = getQuotaByNames(quotaEntry, WEEKLY_KEYS);

  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface p-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-semibold text-text-main">{account.name}</p>
            {account.activeInCodex ? (
              <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600">
                In use
              </span>
            ) : null}
          </div>
          <p className="truncate text-xs text-text-muted">{account.email || "No email"}</p>
          <p className="truncate font-mono text-[11px] text-text-muted">account_id: {account.accountId || "-"}</p>
        </div>
        <button
          type="button"
          onClick={() => onActivate(account.id)}
          disabled={account.activeInCodex || activating}
          className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:border disabled:border-border disabled:bg-surface disabled:text-text-muted disabled:shadow-none"
        >
          {account.activeInCodex ? "Activated" : activating ? "Activating" : "Activate"}
        </button>
      </div>

      {quotaEntry?.error ? (
        <div className="mt-3 rounded bg-amber-500/10 px-2 py-2 text-xs text-amber-700 dark:text-amber-300">
          Quota: {quotaEntry.error}
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <QuotaBar label="Session" quota={sessionQuota} tone="session" />
          <QuotaBar label="Weekly" quota={weeklyQuota} tone="weekly" />
          {loadingQuota ? <p className="text-[11px] text-text-muted">Refreshing quota...</p> : null}
        </div>
      )}
    </div>
  );
}

export default function CodexAccountsPage() {
  const [accounts, setAccounts] = useState([]);
  const [authPath, setAuthPath] = useState("");
  const [quotaData, setQuotaData] = useState({});
  const [quotaLoading, setQuotaLoading] = useState({});
  const [loading, setLoading] = useState(true);
  const [activatingId, setActivatingId] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [restartRequired, setRestartRequired] = useState(false);
  const [codexProcesses, setCodexProcesses] = useState({ running: false, count: 0, processes: [] });
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [secondsLeft, setSecondsLeft] = useState(45);
  const fileInputRef = useRef(null);
  const accountsRef = useRef([]);

  const loadAccounts = useCallback(async () => {
    setError("");
    const res = await fetch("/api/codex-accounts", { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load Codex accounts");
    const nextAccounts = data.accounts || [];
    accountsRef.current = nextAccounts;
    setAccounts(nextAccounts);
    setAuthPath(data.authPath || "");
    setCodexProcesses(data.codexProcesses || { running: false, count: 0, processes: [] });
    return nextAccounts;
  }, []);

  const refreshQuota = useCallback(async (items = accountsRef.current) => {
    const codexAccounts = items.filter((account) => account.isActive);
    await Promise.allSettled(codexAccounts.map(async (account) => {
      setQuotaLoading((prev) => ({ ...prev, [account.id]: true }));
      try {
        const res = await fetch(`/api/usage/${account.id}`, { cache: "no-store" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to fetch quota");
        const quotas = data.quotas
          ? Object.entries(data.quotas).map(([name, quota]) => ({ name, ...quota }))
          : [];
        setQuotaData((prev) => ({ ...prev, [account.id]: { quotas, raw: data } }));
      } catch (quotaError) {
        setQuotaData((prev) => ({
          ...prev,
          [account.id]: { error: quotaError.message || "Failed to fetch quota" },
        }));
      } finally {
        setQuotaLoading((prev) => ({ ...prev, [account.id]: false }));
      }
    }));
  }, []);

  const loadAll = useCallback(async ({ withQuota = true } = {}) => {
    setLoading(true);
    try {
      const nextAccounts = await loadAccounts();
      if (withQuota) await refreshQuota(nextAccounts);
    } catch (loadError) {
      setError(loadError.message || "Failed to load Codex accounts");
    } finally {
      setLoading(false);
    }
  }, [loadAccounts, refreshQuota]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = setInterval(() => {
      setSecondsLeft((current) => {
        if (current <= 1) {
          refreshQuota();
          return 45;
        }
        return current - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [autoRefresh, refreshQuota]);

  const activate = async (connectionId) => {
    setActivatingId(connectionId);
    setError("");
    setMessage("");
    try {
      const res = await fetch("/api/codex-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "activate", connectionId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to activate account");
      setRestartRequired(Boolean(data.restartRequired));
      setCodexProcesses(data.codexProcesses || { running: false, count: 0, processes: [] });
      const restartText = data.restartRequired ? " Restart Codex CLI to use this account in /status." : "";
      const activateMessage = (data.disabledProxyConfig ? "Activated and disabled Codex 9Router config. " : "Activated. ") + (data.backupPath ? "Previous auth backed up to " + data.backupPath + "." : "") + restartText;
      setMessage(activateMessage.trim());
      await loadAll({ withQuota: false });
    } catch (activateError) {
      setError(activateError.message || "Failed to activate account");
    } finally {
      setActivatingId(null);
    }
  };

  const importBackup = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setError("");
    setMessage("");
    try {
      const auth = JSON.parse(await file.text());
      const res = await fetch("/api/codex-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "import", auth }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to import backup");
      setMessage("Backup JSON imported into Codex accounts");
      await loadAll();
    } catch (importError) {
      setError(importError.message || "Failed to import backup JSON");
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="rounded-lg border border-border bg-surface p-4 shadow-sm">
        <div className="flex flex-col gap-3 border-b border-border pb-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-text-main">Direct Codex Account Switcher</h2>
            <p className="text-xs text-text-muted">Switch the active Codex CLI account by writing the selected credentials to auth.json.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setAutoRefresh((value) => !value)}
              className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors ${autoRefresh ? "border-primary/30 bg-primary/10 text-primary" : "border-border bg-bg text-text-muted hover:text-text-main"}`}
            >
              <span className="material-symbols-outlined text-[16px]">{autoRefresh ? "toggle_on" : "toggle_off"}</span>
              Auto-refresh {autoRefresh ? `(${secondsLeft}s)` : ""}
            </button>
            <button type="button" onClick={() => refreshQuota()} className="inline-flex items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2 text-xs text-text-main transition-colors hover:border-primary">
              <span className="material-symbols-outlined text-[16px]">refresh</span>
              Refresh All
            </button>
            <button type="button" onClick={() => loadAll({ withQuota: false })} className="inline-flex items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2 text-xs text-text-main transition-colors hover:border-primary">
              <span className="material-symbols-outlined text-[16px]">sync</span>
              Sync Auth File
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 py-3">
          <button type="button" onClick={() => loadAll()} className="rounded-md bg-primary px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-primary-hover">
            Load from DB
          </button>
          <button type="button" onClick={() => fileInputRef.current?.click()} className="rounded-md border border-border bg-bg px-3 py-2 text-xs text-text-main transition-colors hover:border-primary">
            Load from Backup JSON
          </button>
          <input ref={fileInputRef} type="file" accept="application/json,.json" className="hidden" onChange={importBackup} />
          <span className="w-full text-xs text-text-muted">Auth file: {authPath || "~/.codex/auth.json"}</span>
        </div>

        {error ? <div className="mb-3 rounded bg-red-500/10 px-3 py-2 text-xs text-red-600">{error}</div> : null}
        {message ? <div className="mb-3 rounded bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600">{message}</div> : null}
        {(restartRequired || codexProcesses.running) ? (
          <div className="mb-3 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <div className="flex items-start gap-2">
              <span className="material-symbols-outlined text-[16px]">restart_alt</span>
              <div className="min-w-0">
                <p className="font-semibold">Restart Codex CLI after switching accounts.</p>
                <p className="mt-0.5">
                  Codex reads auth.json when the CLI process starts, so running sessions keep showing the old account in /status.
                  {codexProcesses.count ? ` Detected ${codexProcesses.count} Codex process(es) currently running.` : ""}
                </p>
              </div>
            </div>
          </div>
        ) : null}

        {loading ? (
          <div className="rounded-lg border border-border bg-bg p-6 text-sm text-text-muted">Loading Codex accounts...</div>
        ) : accounts.length === 0 ? (
          <div className="rounded-lg border border-border bg-bg p-6 text-sm text-text-muted">
            No Codex accounts found in the local 9Router database. Connect Codex once under Providers or import a Codex auth backup JSON.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            {accounts.map((account) => (
              <AccountCard
                key={account.id}
                account={account}
                quotaEntry={quotaData[account.id]}
                loadingQuota={quotaLoading[account.id]}
                activating={activatingId === account.id}
                onActivate={activate}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
