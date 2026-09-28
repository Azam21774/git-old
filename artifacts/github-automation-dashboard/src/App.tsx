import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import {
  addAutomationAccounts, clearAutomationAccounts, clearAutomationLogs, getAutomationState,
  pauseAutomationRun, replaceAutomationAccounts, replaceAutomationRecipients, resetAutomationRun,
  resumeAutomationRun, startAutomationRun, stopAutomationRun, updateAutomationSettings,
  type AccountRecord, type AutomationAccount, type AutomationLog, type AutomationRun,
  type AutomationSettings, type AutomationState,
} from "@workspace/api-client-react";

type RunStatus = "ready" | "running" | "paused" | "complete" | "stopped";
type User = { username: string; expiresAt: string };
const defaultSettings: AutomationSettings = { fileName: "", subject: "Update README", message: "Your commit message...", actionDelay: 700, typingDelay: 35, batchSize: 2, accountRecipientLimit: 0 };

function parseAccounts(value: string): AccountRecord[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [email = "", password = "", totp = ""] = line.split(":").map((part) => part.trim());
    return { email, password, totp };
  }).filter((account) => account.email.includes("@"));
}
function parseRecipients(value: string) {
  return Array.from(new Set(value.split(/\r?\n|,/).map((email) => email.trim()).filter((email) => email.includes("@"))));
}

async function replaceRecipientsInChunks(
  emails: string[],
): Promise<AutomationState> {
  if (emails.length === 0) {
    return replaceAutomationRecipients({ emails });
  }

  await replaceAutomationRecipients({ emails: [] });

  const chunkSize = 1000;
  let finalState: AutomationState | null = null;

  for (let offset = 0; offset < emails.length; offset += chunkSize) {
    const complete = offset + chunkSize >= emails.length;
    const response = await fetch(
      "/api/automation/recipients/chunk",
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          emails: emails.slice(offset, offset + chunkSize),
          complete,
        }),
      },
    );
    const result = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(
        result?.message ??
          `Recipient upload failed (${response.status}).`,
      );
    }

    if (complete) {
      finalState = result as AutomationState;
    }
  }

  return finalState ?? getAutomationState();
}

function formatLogTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
function getErrorMessage(error: unknown) { return error instanceof Error ? error.message : "Unable to reach the API server."; }
function isUnauthorized(error: unknown) { return (error as { status?: number })?.status === 401 || getErrorMessage(error).includes("401"); }
function remaining(expiresAt: string, now: number) {
  const seconds = Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000));
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function LoginGate({ onLogin }: { onLogin: (user: User) => void }) {
  const [username, setUsername] = useState("");
  const [activationKey, setActivationKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/login", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, activationKey }) });
      const data = await response.json();
      if (!response.ok || !data.authenticated) throw new Error(data.error || data.message || "Invalid username or activation key.");
      setActivationKey(""); onLogin(data.user);
    } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
  };
  return <main className="login-shell"><section className="login-card">
    <div className="brand-mark"><i /> GH // OPERATOR</div>
    <h1>Access console.</h1><p>Authenticate to manage your GitHub UI automation fleet. Your session is secured for this workspace.</p>
    {error && <div className="auth-error" role="alert">{error}</div>}
    <form className="auth-form" onSubmit={submit}>
      <label>Username<input required value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Enter username" autoComplete="username" /></label>
      <label>Activation key<input required type="password" value={activationKey} onChange={(e) => setActivationKey(e.target.value)} placeholder="Enter activation key" autoComplete="off" /></label>
      <button className="auth-submit" disabled={busy}>{busy ? "VERIFYING SESSION..." : "ENTER OPERATOR CONSOLE  →"}</button>
    </form>
    <p className="login-foot">AUTHENTICATED ACCESS · NO KEY STORAGE</p>
  </section></main>;
}

function Dashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [accounts, setAccounts] = useState<AutomationAccount[]>([]);
  const [pasteValue, setPasteValue] = useState("");
  const [recipientText, setRecipientText] = useState("");
  const [fileName, setFileName] = useState(defaultSettings.fileName);
  const [subject, setSubject] = useState(defaultSettings.subject);
  const [message, setMessage] = useState(defaultSettings.message);
  const [actionDelay, setActionDelay] = useState(defaultSettings.actionDelay);
  const [typingDelay, setTypingDelay] = useState(defaultSettings.typingDelay);
  const [batchSize, setBatchSize] = useState<1 | 2>(defaultSettings.batchSize);
  const [accountRecipientLimit, setAccountRecipientLimit] = useState(defaultSettings.accountRecipientLimit);
  const [run, setRun] = useState<AutomationRun | null>(null);
  const [logs, setLogs] = useState<AutomationLog[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [apiError, setApiError] = useState("");
  const [now, setNow] = useState(Date.now());
  const recipients = useMemo(() => parseRecipients(recipientText), [recipientText]);
  const status: RunStatus = run?.status ?? "ready";
  const total = run && status !== "ready" ? run.total : recipients.length ? Math.ceil(recipients.length / batchSize) : 0;
  const completed = run?.completed ?? 0;
  const totalRecipients = run && status !== "ready" ? run.totalRecipients : recipients.length;
  const completedRecipients = run && status !== "ready" ? run.completedRecipients : 0;
  const remainingRecipients = Math.max(0, totalRecipients - completedRecipients);
  const currentAccount = accounts.length ? Math.min(accounts.length, run?.currentAccount ?? 1) : 0;
  const activeAccountNumber = status === "running" || status === "paused" ? currentAccount : 0;
  const activeAccount = activeAccountNumber ? accounts[activeAccountNumber - 1] : null;
  const progress = total ? Math.min(100, Math.round(completed / total * 100)) : 0;
  const statusLabel = status === "running" ? "RUNNING" : status === "paused" ? "PAUSED" : status === "complete" ? "COMPLETE" : status === "stopped" ? "STOPPED" : "READY";
  const applyState = (next: AutomationState) => {
    setAccounts(next.accounts); setRecipientText(next.recipients.join("\n")); setFileName(next.settings.fileName);
    setSubject(next.settings.subject); setMessage(next.settings.message); setActionDelay(next.settings.actionDelay);
    setTypingDelay(next.settings.typingDelay); setBatchSize(next.settings.batchSize); setAccountRecipientLimit(next.settings.accountRecipientLimit); setRun(next.run); setLogs(next.logs);
  };
  const perform = async (
    action: () => Promise<AutomationState>,
    options?: { preserveRecipientDraft?: boolean },
  ) => {
    const recipientDraft = recipientText;
    setSyncing(true);
    try {
      const next = await action();
      applyState(next);
      if (options?.preserveRecipientDraft) setRecipientText(recipientDraft);
      setApiError("");
      return next;
    }
    catch (error) { if (isUnauthorized(error)) onLogout(); else setApiError(getErrorMessage(error)); return null; }
    finally { setSyncing(false); }
  };
  useEffect(() => { let cancelled = false; void getAutomationState().then((next) => { if (!cancelled) { applyState(next); setLoaded(true); } }).catch((error) => { if (!cancelled) { setLoaded(true); if (isUnauthorized(error)) onLogout(); else setApiError(getErrorMessage(error)); } }); return () => { cancelled = true; }; }, []);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { if (!loaded || (status !== "running" && status !== "paused")) return; const timer = window.setInterval(() => void getAutomationState().then(applyState).catch((error) => { if (isUnauthorized(error)) onLogout(); else setApiError(getErrorMessage(error)); }), 1000); return () => window.clearInterval(timer); }, [loaded, status]);
  const saveRecipients = () => perform(() => replaceRecipientsInChunks(recipients));
  const saveSettings = () => perform(() => updateAutomationSettings({ fileName, subject, message, actionDelay, typingDelay, batchSize, accountRecipientLimit }));
  const addAccounts = async () => { const parsed = parseAccounts(pasteValue); if (!parsed.length) { setApiError("No valid accounts found. Use email:password:2FA."); return; } if (await perform(() => addAutomationAccounts({ records: parsed }), { preserveRecipientDraft: true })) setPasteValue(""); };
  const startRun = async () => { if (!accounts.length) { setApiError("Cannot start: add at least one account."); return; } if (!recipients.length) { setApiError("Cannot start: add at least one recipient."); return; } if (!await perform(() => replaceRecipientsInChunks(recipients))) return; if (!await perform(() => updateAutomationSettings({ fileName, subject, message, actionDelay, typingDelay, batchSize, accountRecipientLimit }))) return; await perform(startAutomationRun); };
  const restartRun = async () => { if (!await perform(resetAutomationRun)) return; await startRun(); };
  const importRecipients = (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => { const text = String(reader.result ?? ""); setRecipientText(text); void perform(() => replaceRecipientsInChunks(parseRecipients(text))); }; reader.readAsText(file); event.target.value = ""; };
  const importAccounts = (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => { const parsed = parseAccounts(String(reader.result ?? "")); if (!parsed.length) { setApiError("No valid accounts found. Use email:password:2FA."); return; } void perform(() => replaceAutomationAccounts({ records: parsed }), { preserveRecipientDraft: true }); }; reader.readAsText(file); event.target.value = ""; };
  const logout = async () => { await fetch("/api/auth/logout", { method: "POST", credentials: "include" }); onLogout(); };
  return <div className="automation-app">
    <header className="app-header"><div><div className="header-title">GITHUB AUTOMATION</div><div className="header-subtitle">HIGH-FOCUS OPERATOR CONSOLE / V1.0</div></div>
      <div className="header-right"><div className="header-status-wrap"><div className={`header-status status-${status}`}><span className="status-bullet" />{statusLabel}</div><div className={`sync-status ${apiError ? "sync-error" : ""}`}><span className="sync-dot" />{!loaded ? "CONNECTING" : syncing ? "SYNCING" : apiError ? "API ERROR" : "SYNCED"}</div></div>
      <div className="user-area"><div className="user-avatar">{user.username.slice(0, 2).toUpperCase()}</div><div className="user-meta"><span>{user.username}</span><span className="expiry">EXPIRES {remaining(user.expiresAt, now)} · {new Date(user.expiresAt).toLocaleString()}</span></div><button className="logout" onClick={() => void logout()}>LOG OUT</button></div></div>
    </header>
    {apiError && <div className="api-alert" role="alert"><span>{apiError}</span><button className="alert-dismiss" onClick={() => setApiError("")}>DISMISS</button></div>}
    <main className="panel-content">
      <section className="panel-section"><h2 className="section-title">01 / ACCOUNTS</h2><div className="two-column-grid">
        <div className="wire-card"><div className="card-title">ADD ACCOUNT FLEET</div><div className="card-hint">email:password:2FA · one account per line</div><textarea className="wire-textarea paste-accounts" aria-label="Paste account data" placeholder="Paste account data..." value={pasteValue} onChange={(e) => setPasteValue(e.target.value)} /><div className="card-actions"><label className="wire-button secondary">IMPORT FILE<input type="file" accept=".txt,.csv" onChange={importAccounts} /></label><button className="wire-button" onClick={() => void addAccounts()} disabled={syncing}>ADD ACCOUNTS</button></div></div>
         <div className="wire-card"><div className="card-title">IMPORTED ACCOUNTS <span style={{ color: "var(--violet-2)" }}>· {accounts.length}</span></div><div className="account-list">{accounts.length ? accounts.map((account, index) => { const accountNumber = index + 1; const accountUsage = run?.completedRecipientsByAccount?.[String(account.id)] ?? 0; const limitReached = accountRecipientLimit > 0 && accountUsage >= accountRecipientLimit && (status === "running" || status === "paused"); return <div className={`account-row ${accountNumber === activeAccountNumber ? "active" : ""}`} key={account.id}><span className="account-index">{String(accountNumber).padStart(2, "0")}</span><span className="check-mark">●</span><span>{account.email}</span>{(status === "running" || status === "paused") && accountRecipientLimit > 0 && <span className="account-usage">{accountUsage}/{accountRecipientLimit}</span>}{limitReached ? <span className="limit-label">LIMIT REACHED</span> : accountNumber === activeAccountNumber && <span className="active-label">ACTIVE</span>}</div>; }) : <div className="empty-state">No accounts imported</div>}</div><div className="card-actions"><button className="wire-button" onClick={() => void perform(clearAutomationAccounts, { preserveRecipientDraft: true })} disabled={syncing}>CLEAR ALL</button></div></div>
      </div></section>
      <section className="two-column-grid content-grid"><div><section className="panel-section"><h2 className="section-title">02 / RECIPIENTS</h2><div className="wire-card tall-card"><div className="card-hint">One email per line or comma-separated · {recipients.length} parsed recipients</div><textarea className="wire-textarea recipients-textarea" aria-label="Recipient email addresses" value={recipientText} onChange={(e) => setRecipientText(e.target.value)} /><div className="recipient-actions"><label className="wire-button secondary">IMPORT CSV<input type="file" accept=".csv,.txt" onChange={importRecipients} /></label><button className="wire-button" onClick={() => void saveRecipients()} disabled={syncing}>SAVE RECIPIENTS</button><button className="wire-button" onClick={() => { setRecipientText(""); void perform(() => replaceAutomationRecipients({ emails: [] })); }} disabled={syncing || !recipients.length}>REMOVE ALL</button></div></div></section>
       <section className="panel-section"><h2 className="section-title">03 / SPEED & ACCOUNT LIMIT</h2><div className="wire-card"><div className="range-row"><div className="range-label"><span>Action delay</span><output>{actionDelay} ms</output></div><input type="range" min="0" max="2000" step="50" value={actionDelay} aria-label="Action delay" onChange={(e) => setActionDelay(Number(e.target.value))} onMouseUp={() => void saveSettings()} onTouchEnd={() => void saveSettings()} /></div><div className="range-row"><div className="range-label"><span>Typing delay</span><output>{typingDelay} ms</output></div><input type="range" min="0" max="250" step="5" value={typingDelay} aria-label="Typing delay" onChange={(e) => setTypingDelay(Number(e.target.value))} onMouseUp={() => void saveSettings()} onTouchEnd={() => void saveSettings()} /></div><label className="field-label batch-size-field">Recipients per batch<select className="wire-input" aria-label="Recipients per batch" value={batchSize} disabled={status === "running" || status === "paused"} onChange={(e) => { const next = Number(e.target.value) as 1 | 2; setBatchSize(next); void updateAutomationSettings({ fileName, subject, message, actionDelay, typingDelay, batchSize: next, accountRecipientLimit }).then(applyState).catch((error) => setApiError(getErrorMessage(error))); }}><option value={1}>1 recipient</option><option value={2}>2 recipients</option></select></label><label className="field-label batch-size-field">Max recipients per GitHub account<input className="wire-input" type="number" min="0" step="1" aria-label="Max recipients per GitHub account" value={accountRecipientLimit} disabled={status === "running" || status === "paused"} onChange={(e) => setAccountRecipientLimit(Math.max(0, Math.floor(Number(e.target.value) || 0)))} onBlur={() => void saveSettings()} /><span className="setting-hint">0 = unlimited. An account is taken offline after reaching this limit.</span></label></div></section></div>
      <section className="panel-section"><h2 className="section-title">04 / COMMIT MESSAGE</h2><div className="wire-card commit-card"><label className="field-label">File name<input className="wire-input" value={fileName} onChange={(e) => setFileName(e.target.value)} onBlur={() => void saveSettings()} placeholder="Enter exact file name" /></label><label className="field-label">Subject<input className="wire-input" value={subject} onChange={(e) => setSubject(e.target.value)} onBlur={() => void saveSettings()} /></label><label className="field-label">Message<textarea className="wire-textarea commit-message" value={message} onChange={(e) => setMessage(e.target.value)} onBlur={() => void saveSettings()} /></label><div className="commit-preview"><span className="preview-label">COMMIT PREVIEW</span><strong>{subject || "Untitled commit"}</strong><span>{message || "No extended message"}</span></div></div></section></section>
      <section className="summary-grid" aria-label="Automation summary"><div className="summary-box"><span>ACCOUNTS</span><strong>{accounts.length}</strong></div><div className="summary-box"><span>TOTAL RECIPIENTS</span><strong>{totalRecipients}</strong></div><div className="summary-box accent"><span>REMAINING RECIPIENTS</span><strong>{remainingRecipients}</strong></div><div className="summary-box"><span>BATCHES</span><strong>{total}</strong></div><div className="summary-box"><span>COMPLETED BATCHES</span><strong>{completed}</strong></div></section>
      <section className="status-section"><h2 className="section-title">05 / AUTOMATION STATUS</h2><div className={`status-line status-${status}`}><span className="status-bullet" /><span>{statusLabel[0] + statusLabel.slice(1).toLowerCase()}</span><span className="progress-inline">{completed}/{total} batches · {completedRecipients}/{totalRecipients} recipients · {remainingRecipients} remaining · {progress}% · {activeAccount ? `account ${activeAccountNumber}: ${activeAccount.email}` : "no active account"}</span></div><div className="progress-track" aria-label={`Automation progress ${progress}%`} role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><div className="progress-fill" style={{ width: `${progress}%` }} /></div>{status === "complete" && <div className="completion-note">All recipient batches completed successfully.</div>}{status === "stopped" && remainingRecipients > 0 && <div className="completion-note">{remainingRecipients} recipient(s) remain. Increase the account limit or add GitHub accounts to continue.</div>}</section>
       <section className="controls-row" aria-label="Automation controls">{status === "running" ? <><button className="wire-button control-button" onClick={() => void perform(pauseAutomationRun)} disabled={syncing}>Ⅱ &nbsp; PAUSE</button><button className="wire-button control-button" onClick={() => void perform(stopAutomationRun)} disabled={syncing}>■ &nbsp; STOP</button></> : status === "paused" ? <><button className="primary-control control-button" onClick={() => void perform(resumeAutomationRun)} disabled={syncing}>▶ &nbsp; RESUME</button><button className="wire-button control-button" onClick={() => void perform(stopAutomationRun)} disabled={syncing}>■ &nbsp; STOP</button></> : <>{status !== "complete" && <button className="primary-control control-button" onClick={() => void startRun()} disabled={syncing || !loaded}>▶ &nbsp; {status === "stopped" ? "RESUME FROM CHECKPOINT" : "START RUN"}</button>}{(status === "complete" || status === "stopped") && <button className="wire-button control-button" onClick={() => void restartRun()} disabled={syncing}>↺ &nbsp; RESTART</button>}</>}</section>
      <section><div className="logs-heading"><h2 className="section-title">06 / LIVE LOGS</h2><button className="clear-logs" onClick={() => void perform(clearAutomationLogs)} disabled={syncing}>CLEAR LOGS</button></div><div className="logs-window" aria-live="polite">{logs.length ? logs.map((entry) => <div className={`log-line ${entry.tone ?? ""}`} key={entry.id}><span className="log-time">{formatLogTime(entry.time)}</span><span>{entry.message}</span></div>) : <div className="empty-state">No logs yet. Start a run to begin telemetry.</div>}</div></section>
    </main>
  </div>;
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  useEffect(() => { fetch("/api/auth/session", { credentials: "include" }).then((response) => response.json()).then((data) => { if (data.authenticated) setUser(data.user); }).catch(() => undefined).finally(() => setChecking(false)); }, []);
  if (checking) return <div className="login-shell"><div className="login-card"><div className="brand-mark"><i /> GH // OPERATOR</div><p style={{ marginTop: 40 }}>Checking secure session...</p></div></div>;
  return user ? <Dashboard user={user} onLogout={() => setUser(null)} /> : <LoginGate onLogin={setUser} />;
}
export default App;