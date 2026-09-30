import { legacySearchControls } from "./lib/jobControls";
import { withVaultConfiguration } from "./lib/provenance";
import { NETWORK_ID, NETWORK_CONFIG } from "./lib/network";
import { operationsAllowed, serviceStatus } from "./lib/readiness";
import { useEffect, useRef, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FileKey2,
  Fingerprint,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  Plus,
  Receipt,
  ShieldCheck,
  Wallet as WalletIcon,
  X,
  Activity,
  BookOpen,
  KeyRound,
  LogOut,
  AlertCircle,
} from "lucide-react";
import { api, authenticate, clearSession } from "./lib/api";
import TransactionDialog from "./TransactionDialog";
import WalletCheck from "./WalletCheck";
import Costs from "./Costs";
import { connectWallet, signMessage, type Wallet } from "./lib/wallet";
import { generateQsb, validateRecovery, lockQsb } from "./lib/qsb";
import {
  encryptRecovery,
  decryptRecovery,
  downloadBackup,
  recoveryBackupFilename,
} from "./lib/backup";
import {
  formatBtc,
  release,
  type PublicVault,
  type Recovery,
  type Job,
  type StrayPayments,
} from "./lib/model";
import { downloadVaultExport } from "./lib/vault-export";
const pages = ["vaults", "activity", "costs", "recovery", "protocol"] as const;
type Page = (typeof pages)[number];
// The page lives in the URL, so Back, refresh and opening a page in a new tab all work.
const pageFromHash = (): Page => {
  const id = location.hash.replace(/^#\/?/, "");
  return (pages as readonly string[]).includes(id) ? (id as Page) : "vaults";
};
const short = (s: string) => `${s.slice(0, 7)}…${s.slice(-6)}`;
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const gpuTime = (seconds: number) => {
  const minutes = Math.round(seconds / 60);
  return minutes < 60
    ? `${minutes} min`
    : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};
const nav = [
  { id: "vaults", label: "My vaults", icon: Layers3 },
  { id: "activity", label: "Activity", icon: Activity },
  { id: "costs", label: "Costs", icon: Receipt },
  { id: "recovery", label: "Recovery", icon: KeyRound },
  { id: "protocol", label: "How QSB works", icon: BookOpen },
] as const;
const stageStep = { pinning: 1, round1: 2, round2: 3, verification: 4 };
const jobLabel = (j: Job) =>
  j.status === "searching"
    ? `Searching · step ${stageStep[j.stage] ?? 1} of 4`
    : ({
        queued: "Waiting to start",
        paused: "Paused",
        failed: "Failed",
        awaiting_authorization: "Ready to authorize",
        submitted: "Sent · waiting for confirmation",
        confirmed: "Confirmed",
      } as Record<string, string>)[j.status] ?? j.status.replaceAll("_", " ");
const vaultLabel = (v: PublicVault, job?: Job) =>
  v.status === "spent"
    ? "Withdrawn"
    : job && v.status === "confirmed"
      ? job.status === "awaiting_authorization"
        ? "Withdrawal ready"
        : "Withdrawing"
      : ({ unfunded: "Not funded", submitted: "Deposit pending", confirmed: "Funded" } as Record<string, string>)[v.status];
// One tab at a time checks the chain for a wallet, at most once a minute across tabs. Each
// check costs provider requests, and the status routes write a versioned record that two tabs
// checking at once would conflict on. Tabs share when each item was last checked.
const chainTurnKey = (address: string) => `qsb-chain-check:${address}`;
const chainSeenKey = (address: string) => `qsb-chain-checked:${address}`;
function readChainSeen(address: string): Record<string, string> {
  try {
    const seen = JSON.parse(localStorage.getItem(chainSeenKey(address)) ?? "{}");
    return seen && typeof seen === "object"
      ? Object.fromEntries(Object.entries(seen).filter((e): e is [string, string] => typeof e[1] === "string"))
      : {};
  } catch {
    return {};
  }
}
async function chainTurn(address: string, check: () => Promise<void>) {
  const key = chainTurnKey(address);
  const run = async () => {
    if (Date.now() - Number(localStorage.getItem(key) ?? 0) < 60000) return;
    localStorage.setItem(key, String(Date.now()));
    await check();
  };
  // Web Locks make the turn exclusive; without them the shared timestamp still spaces checks.
  if (navigator.locks) await navigator.locks.request(key, { ifAvailable: true }, (lock) => (lock ? run() : undefined));
  else await run();
}
const conflictText = (alert?: string) =>
  `${alert ?? "Funding outpoint was spent by a different transaction."} Contact the operator; do not resubmit or spend the helper output.`;
type Status = "checking" | "unknown" | ReturnType<typeof serviceStatus>;
const statusLabel: Record<Status, string> = {
  checking: "Checking service status",
  unknown: "Service status unavailable",
  on: "Deposits and withdrawals on",
  "search-only": "Submission to MARA off",
  off: "Deposits and withdrawals off",
};
const statusDetail: Record<Status, string> = {
  checking: "Checking this server's settings.",
  unknown:
    "The app couldn't read this server's settings, so transactions stay off. Creating a vault and saving its backup still work.",
  on: "Deposits are sent to MARA Slipstream, and withdrawal searches run on AWS GPUs. Creating a vault and saving its backup happen on this device.",
  "search-only":
    "Withdrawal searches can start, but submission to MARA is off: deposits can't be sent and a signed withdrawal can't be submitted. Creating a vault and saving its backup still work.",
  off: "This server has deposits and withdrawals switched off. Creating a vault and saving its backup still work, on this device.",
};
export default function App() {
  const [page, setPage] = useState<Page>(pageFromHash),
    [wallet, setWallet] = useState<Wallet>(),
    [walletMenu, setWalletMenu] = useState(false),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [vaults, setVaults] = useState<PublicVault[]>([]),
    // Vaults whose unconfirmed deposit has stored Slipstream bytes the server can resend.
    [resendable, setResendable] = useState<Set<string>>(new Set()),
    // Payments to a vault's script beyond its one deposit, flagged by the server. Never spent.
    [stray, setStray] = useState<StrayPayments[]>([]),
    [manualDeposit, setManualDeposit] = useState<{ vaultId: string; txid: string; rawTxHex: string }>(),
    [jobs, setJobs] = useState<Job[]>([]),
    // Feedback shown next to the row that asked for it, keyed "vault:<id>" or "job:<id>".
    [inline, setInline] = useState<Record<string, { kind: "error" | "notice"; text: string }>>({}),
    // When the chain was last checked for a pending deposit or withdrawal, by vault or job id.
    [checkedAt, setCheckedAt] = useState<Record<string, string>>({}),
    [modal, setModal] = useState<"create" | "readiness" | null>(null),
    [step, setStep] = useState(1),
    [name, setName] = useState("My first vault"),
    [pass, setPass] = useState(""),
    [confirmPass, setConfirmPass] = useState(""),
    [recovery, setRecovery] = useState<Recovery>(),
    [encrypted, setEncrypted] = useState(""),
    [verified, setVerified] = useState(false),
    [created, setCreated] = useState<PublicVault>(),
    [restoreFile, setRestoreFile] = useState(""),
    [restored, setRestored] =
      useState<Pick<Recovery, "vault" | "authorization">>(),
    [config, setConfig] = useState<any>(release),
    [configState, setConfigState] = useState<"loading" | "ready" | "failed">("loading"),
    [notice, setNotice] = useState("");
  // Deposit submission to MARA, and so every manual Slipstream path, needs both switches on.
  const submissionOn = operationsAllowed(config) && config?.exactSubmitEnabled === true;
  const status: Status =
    configState === "loading" ? "checking" : configState === "failed" ? "unknown" : serviceStatus(config);
  const [transaction, setTransaction] = useState<{
    vault: PublicVault;
    job?: Job;
    solvedResult?: unknown;
  }>();
  function go(next: Page) {
    location.hash = `/${next}`;
  }
  useEffect(() => {
    const onHash = () => {
      setPage(pageFromHash());
      setError("");
      setWalletMenu(false);
      scrollTo(0, 0);
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const conflictingCreation = !!transaction && !transaction.job && jobs.some((job) => job.vaultId === transaction.vault.id);
  useEffect(() => {
    if (!conflictingCreation) return;
    setTransaction(undefined);
    go("activity");
    setNotice("This vault already has a withdrawal request. Review it in Activity.");
  }, [conflictingCreation]);
  const dialog = useRef<HTMLDialogElement>(null),
    walletMenuRef = useRef<HTMLDivElement>(null),
    generation = useRef(0);
  useEffect(() => {
    api("/config")
      .then((value) => {
        setConfig(value);
        setConfigState("ready");
        if ((value as { network?: string }).network !== NETWORK_ID)
          setError(
            "Server network does not match this app. Transactions are disabled.",
          );
      })
      .catch(() => setConfigState("failed"));
  }, []);
  useEffect(() => {
    if (!walletMenu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !walletMenuRef.current?.contains(e.target as Node))
        setWalletMenu(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [walletMenu]);
  const say = (key: string, kind: "error" | "notice", text: string) =>
    setInline((m) => ({ ...m, [key]: { kind, text } }));
  const unsay = (key: string) =>
    setInline(({ [key]: _, ...rest }) => rest);
  // An unconfirmed Slipstream deposit whose MARA answer was lost stays "submitted"; this resends
  // the server's stored signed bytes. It never creates another deposit.
  // If the API route fails, the same signed deposit can be pasted into slipstream.mara.com.
  async function showManualDeposit(v: PublicVault) {
    const key = `vault:${v.id}`;
    unsay(key);
    const active = generation.current;
    try {
      // The stored bytes, without any chain lookup; the server refuses while deposits are off.
      const f = await api<{ rawTxHex?: string; txid?: string; status?: string }>(`/vaults/${v.id}/fund/signed`);
      if (active !== generation.current) return;
      if (f.status !== "submitted") {
        say(key, "notice", "This deposit is no longer waiting for submission. Nothing to do.");
        return;
      }
      if (!f.rawTxHex || !f.txid) throw Error("The signed deposit isn't available.");
      setManualDeposit({ vaultId: v.id, txid: f.txid, rawTxHex: f.rawTxHex });
    } catch (e) {
      if (active === generation.current)
        say(key, "error", e instanceof Error ? e.message : "The signed deposit isn't available.");
    }
  }
  async function resendDeposit(v: PublicVault) {
    const key = `vault:${v.id}`;
    unsay(key);
    try {
      const r = await api<{ submission: "submitted" | "uncertain" | "rejected"; reason?: string }>(
        `/vaults/${v.id}/fund/resubmit`,
        {},
      );
      say(
        key,
        "notice",
        r.submission === "submitted"
          ? "MARA has the deposit. Wait for confirmation before withdrawing; don't deposit again."
          : `MARA's answer is still unclear${r.reason ? ` (${r.reason})` : ""}. The same deposit can be resent again; don't make another deposit.`,
      );
    } catch (e) {
      say(key, "error", e instanceof Error ? e.message : "Resend failed. Don't make another deposit.");
    }
  }
  function markChecked(id: string) {
    const at = new Date().toISOString();
    setCheckedAt((c) => ({ ...c, [id]: at }));
    if (wallet)
      localStorage.setItem(
        chainSeenKey(wallet.address),
        JSON.stringify({ ...readChainSeen(wallet.address), [id]: at }),
      );
  }
  async function checkDeposit(v: PublicVault, stale = () => false) {
    const updated = await api<{
      vault: PublicVault;
      status: { confirmed: boolean };
      strayPayments?: StrayPayments | null;
    }>(`/vaults/${v.id}/funding`);
    if (stale()) return false;
    setVaults((items) =>
      items.map((item) => (item.id === v.id ? updated.vault : item)),
    );
    setStray((items) => [
      ...items.filter((p) => p.vaultId !== v.id),
      ...(updated.strayPayments ? [updated.strayPayments] : []),
    ]);
    markChecked(v.id);
    return updated.status.confirmed;
  }
  async function checkWithdrawal(j: Job, stale = () => false) {
    const observation = await api<{ status: string; alert?: string }>(
      `/transactions/${j.txid}/status`,
    );
    if (stale()) return observation;
    markChecked(j.id);
    if (observation.status !== "confirmed") return observation;
    const updated = await api<{ job: Job }>(`/jobs/${j.id}/status`);
    if (stale()) return observation;
    setJobs((js) => js.map((x) => (x.id === j.id ? updated.job : x)));
    const latest = await api<{ vaults: PublicVault[] }>("/vaults");
    if (!stale()) setVaults(latest.vaults);
    return observation;
  }
  useEffect(() => {
    if (modal) dialog.current?.showModal();
    else dialog.current?.close();
  }, [modal]);
  useEffect(() => {
    if (!wallet) return;
    let disposed = false;
    const stale = () => disposed;
    const refresh = async () => {
      try {
        const [v, j] = await Promise.all([
          api<{ vaults: PublicVault[]; resendable?: string[]; strayPayments?: StrayPayments[] }>("/vaults"),
          api<{ jobs: Job[] }>("/jobs"),
        ]);
        if (disposed) return;
        setVaults(v.vaults);
        setResendable(new Set(v.resendable ?? []));
        setStray(v.strayPayments ?? []);
        setJobs(j.jobs);
        setCheckedAt((c) => ({ ...c, ...readChainSeen(wallet.address) }));
        // Pending transactions are checked only while the page is on screen, by one tab.
        if (document.visibilityState !== "visible") return;
        await chainTurn(wallet.address, async () => {
          for (const vault of v.vaults)
            if (!disposed && vault.status === "submitted" && vault.funding)
              await checkDeposit(vault, stale).catch(() => {});
          for (const job of j.jobs)
            if (!disposed && job.txid && job.status === "submitted") {
              const observation = await checkWithdrawal(job, stale).catch(() => undefined);
              if (observation?.status === "conflict" && !disposed)
                say(`job:${job.id}`, "error", conflictText(observation.alert));
            }
        });
      } catch {}
    };
    void refresh();
    const t = setInterval(refresh, 15000);
    return () => {
      disposed = true;
      clearInterval(t);
    };
  }, [wallet]);
  async function action(label: string, fn: () => Promise<void>, isCurrent = () => true) {
    setError("");
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      if (isCurrent()) setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      if (isCurrent()) setBusy("");
    }
  }
  // Like action, but the outcome is shown in the row the button belongs to.
  async function rowAction(key: string, label: string, fn: () => Promise<void>) {
    unsay(key);
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      say(key, "error", e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy("");
    }
  }
  async function connect() {
    const connectionGeneration = ++generation.current;
    clearSession();
    const assertCurrentConnection = () => {
      if (generation.current !== connectionGeneration)
        throw new Error("Wallet connection changed during sign-in.");
    };
    await action("Connecting to Xverse", async () => {
      const w = await connectWallet();
      assertCurrentConnection();
      await authenticate(w.address, (m) => {
        assertCurrentConnection();
        return signMessage(w.address, m);
      });
      assertCurrentConnection();
      setWallet(w);
      setNotice("Xverse connected. No Bitcoin has moved.");
    }, () => generation.current === connectionGeneration);
  }
  function disconnect() {
    generation.current++;
    setWalletMenu(false);
    setManualDeposit(undefined);
    setResendable(new Set());
    setStray([]);
    setInline({});
    setCheckedAt({});
    setBusy("");
    setWallet(undefined);
    setVaults([]);
    setJobs([]);
    setRecovery(undefined);
    setRestored(undefined);
    setPass("");
    setConfirmPass("");
    setEncrypted("");
    setTransaction(undefined);
    clearSession();
    lockQsb();
    setNotice("Wallet disconnected and local keys locked.");
  }
  function copyAddress() {
    setWalletMenu(false);
    if (!wallet) return;
    navigator.clipboard?.writeText(wallet.address).then(
      () => setNotice("Address copied."),
      () => setError("Couldn't copy. Copy the address from Xverse instead."),
    );
  }
  function newVault() {
    setError("");
    setStep(1);
    setName(vaults.length === 0 ? "My first vault" : `Vault ${vaults.length + 1}`);
    setPass("");
    setConfirmPass("");
    setRecovery(undefined);
    setEncrypted("");
    setVerified(false);
    setCreated(undefined);
    setModal("create");
  }
  function closeModal() {
    if (busy) return;
    setModal(null);
    setPass("");
    setConfirmPass("");
    setRecovery(undefined);
    setEncrypted("");
    lockQsb();
  }
  function startTransaction(v: PublicVault) {
    // Status alone never releases this vault's one-time commitments.
    // Paused/failed and stale submitted/confirmed rows still need review.
    // The server reservation checks remain authoritative for stale clients.
    if (jobs.some((job) => job.vaultId === v.id)) {
      go("activity");
      setNotice("This vault already has a withdrawal request. Review it in Activity.");
      return;
    }
    if (operationsAllowed(config)) setTransaction({ vault: v });
    else setModal("readiness");
  }
  function depositNow() {
    const vault = created;
    closeModal();
    if (vault) startTransaction(vault);
  }
  function openAuthorization(j: Job) {
    const vault = vaults.find((v) => v.id === j.vaultId);
    if (!vault) {
      setModal("readiness");
      return;
    }
    void action("Loading the solved result", async () => {
      const solvedResult = await api(`/jobs/${j.id}/solved-result`);
      setTransaction({ vault, job: j, solvedResult });
    });
  }
  const passLongEnough = pass.length >= 14,
    passMatch = confirmPass !== "" && pass === confirmPass,
    formReady = passLongEnough && passMatch && !!name.trim();
  async function generate() {
    await action("Generating your keys locally", async () => {
      if (!wallet) throw new Error("Connect Xverse before creating a vault.");
      if (pass !== confirmPass)
        throw new Error("The passphrases do not match.");
      if (pass.length < 14)
        throw new Error(
          "Use at least 14 characters for your recovery passphrase.",
        );
      if (!name.trim()) throw new Error("Give your vault a name.");
      const gen = generation.current;
      const data = await generateQsb();
      if (gen !== generation.current)
        throw new Error("Wallet changed during key generation.");
      const vault = withVaultConfiguration({
        id: crypto.randomUUID(),
        name: name.trim(),
        createdAt: new Date().toISOString(),
        network: NETWORK_ID,
        config: "A",
        scriptHex: data.scriptHex,
        scriptHash: data.scriptHash,
        publicStateJson: data.publicStateJson,
        paymentAddress: wallet.address,
        status: "unfunded",
      });
      const r: Recovery = {
        format: "qsb-recovery-v1",
        vault,
        stateJson: data.stateJson,
      };
      const e = await encryptRecovery(r, pass);
      setRecovery(r);
      setEncrypted(e);
      setStep(2);
    });
  }
  async function verifyFile(file: File | undefined) {
    if (!file || !recovery) return;
    await action("Checking your backup", async () => {
      const r = await decryptRecovery(await file.text(), pass);
      const digest = await validateRecovery(r.stateJson);
      if (
        digest !== recovery.vault.scriptHash ||
        r.vault.id !== recovery.vault.id
      )
        throw new Error("This backup belongs to a different vault.");
      setVerified(true);
    });
  }
  async function save() {
    await action("Saving vault metadata", async () => {
      if (!recovery || !verified) throw new Error("Verify your backup first.");
      await api("/vaults", recovery.vault);
      setVaults((v) => [...v, recovery.vault]);
      setCreated(recovery.vault);
      setStep(3);
      setPass("");
      setConfirmPass("");
      setRecovery(undefined);
      lockQsb();
    });
  }
  async function restore() {
    await action("Restoring locally", async () => {
      const r = await decryptRecovery(restoreFile, pass);
      if ((await validateRecovery(r.stateJson)) !== r.vault.scriptHash)
        throw new Error("Backup script verification failed.");
      setRestored({ vault: r.vault, authorization: r.authorization });
      lockQsb();
      setPass("");
      setNotice(
        "Backup verified locally. Your recovery keys have not left this device.",
      );
    });
  }
  const funded = vaults.filter((v) => v.status === "confirmed");
  const balance = funded.reduce((n, v) => n + BigInt(v.funding?.value || "0"), 0n);
  const ready = jobs.filter((j) => legacySearchControls(j).authorize);
  const vaultName = (id: string) => vaults.find((v) => v.id === id)?.name;
  const checks: { id: string; label: string; passed: boolean }[] = config.checks ?? [];
  const subtitle: Record<Page, string> = {
    vaults:
      status === "on" || status === "checking"
        ? "Create a vault, save its backup, then deposit from Xverse."
        : status === "search-only"
          ? "Deposits can't be sent right now: submission to MARA is off. You can still create a vault and save its backup."
          : status === "unknown"
            ? "The app couldn't check whether deposits are on. You can still create a vault and save its backup."
            : "Deposits and withdrawals are off right now. You can still create a vault and save its backup.",
    activity: "Your withdrawals and how far each one has got.",
    costs: "What a deposit and a withdrawal cost today, and what isn't billed yet.",
    recovery:
      "Restore a QSB recovery file on this device. Your Xverse seed phrase is separate.",
    protocol: "What changes when Bitcoin moves into a QSB vault.",
  };
  const rowMessage = (k: string) =>
    inline[k] ? (
      <div
        className={`row-message ${inline[k].kind}`}
        role={inline[k].kind === "error" ? "alert" : "status"}
      >
        {inline[k].kind === "error" ? <AlertCircle size={16} /> : <Check size={16} />}
        <span>{inline[k].text}</span>
        <button aria-label="Dismiss" onClick={() => unsay(k)}>
          <X size={14} />
        </button>
      </div>
    ) : null;
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="#/vaults" aria-label="QSB home">
          <span className="brand-mark">
            <Layers3 size={25} />
          </span>
          qsb<span className="brand-dot">.</span>
        </a>
        <nav aria-label="Main navigation">
          {nav.map((n) => (
            <a
              key={n.id}
              className={page === n.id ? "nav active" : "nav"}
              href={`#/${n.id}`}
              aria-current={page === n.id ? "page" : undefined}
            >
              <n.icon size={19} />
              {n.label}
              {n.id === "activity" && ready.length > 0 && (
                <span className="nav-badge">
                  <span aria-hidden="true">{ready.length}</span>
                  <span className="sr-only">{ready.length} ready to authorize</span>
                </span>
              )}
              {page === n.id && <ChevronRight size={16} />}
            </a>
          ))}
        </nav>
        <div className="side-bottom">
          <div className="network">
            <span />
            {NETWORK_CONFIG.label}
          </div>
          <a
            href="https://github.com/avihu28/Quantum-Safe-Bitcoin-Transactions"
            target="_blank"
            rel="noreferrer"
          >
            Read the research <ArrowUpRight size={15} />
          </a>
        </div>
      </aside>
      <div className="workspace">
        <header>
          <button
            className={`service-status ${status}`}
            onClick={() => setModal("readiness")}
            aria-haspopup="dialog"
            aria-label={statusLabel[status]}
          >
            <span className="status-dot" />
            <span className="status-text">{statusLabel[status]}</span>
          </button>
          {wallet ? (
            <div className="wallet-menu" ref={walletMenuRef}>
              <button
                className="wallet connected"
                aria-haspopup="menu"
                aria-expanded={walletMenu}
                onClick={() => setWalletMenu((open) => !open)}
                disabled={!!busy}
              >
                <span className="wallet-dot" />
                {short(wallet.address)}
                <ChevronDown size={15} />
              </button>
              {walletMenu && (
                <div className="menu" role="menu">
                  <button role="menuitem" onClick={copyAddress}>
                    <Copy size={15} />
                    Copy address
                  </button>
                  <button role="menuitem" onClick={disconnect}>
                    <LogOut size={15} />
                    Disconnect
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button className="wallet" onClick={connect} disabled={!!busy}>
              <WalletIcon size={17} />
              Connect Xverse
            </button>
          )}
        </header>
        <main>
          <div className="page-top">
            <h1>{nav.find((n) => n.id === page)?.label}</h1>
            <p className="subtitle">{subtitle[page]}</p>
          </div>
          {error && (
            <div className="message error" role="alert">
              <AlertCircle size={18} />
              <span>{error}</span>
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div className="message success" role="status">
              <Check size={18} />
              <span>{notice}</span>
              <button
                aria-label="Dismiss notification"
                onClick={() => setNotice("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {page === "costs" && <Costs />}
          {page === "vaults" && (
            <>
              {ready.length > 0 && (
                <div className="callout">
                  <AlertCircle size={20} />
                  <div>
                    <strong>
                      {ready.length === 1
                        ? `${vaultName(ready[0].vaultId) ?? "A vault"}: your withdrawal is ready to authorize.`
                        : `${ready.length} withdrawals are ready to authorize.`}
                    </strong>
                    <p>The search has finished. Review the payout, then sign it in Xverse.</p>
                  </div>
                  <button
                    className="primary"
                    disabled={!!busy}
                    onClick={() =>
                      ready.length === 1 ? openAuthorization(ready[0]) : go("activity")
                    }
                  >
                    Review and authorize <ArrowRight size={16} />
                  </button>
                </div>
              )}
              {funded.length > 0 && (
                <div className="balance-card">
                  <div>
                    <div className="card-label">
                      BTC IN FUNDED VAULTS <ShieldCheck size={16} />
                    </div>
                    <div className="balance">
                      {formatBtc(balance)} <span>BTC</span>
                    </div>
                  </div>
                  <div className="balance-bottom">
                    <span>
                      {funded.length} funded {funded.length === 1 ? "vault" : "vaults"}
                    </span>
                    <span className="badge">
                      <LockKeyhole size={12} />
                      Self custody
                    </span>
                  </div>
                </div>
              )}
              {vaults.length === 0 ? (
                <div className="empty-vault">
                  <div className="empty-icon">
                    <Layers3 size={34} />
                  </div>
                  <h3>{wallet ? "Create your first vault." : "Connect Xverse to create your first vault."}</h3>
                  <p>
                    You'll generate the vault's keys on this device and save
                    an encrypted backup before any Bitcoin moves.
                  </p>
                  <button
                    className="primary"
                    onClick={wallet ? newVault : connect}
                    disabled={!!busy}
                  >
                    {busy ? (
                      <LoaderCircle className="spin" size={17} />
                    ) : wallet ? (
                      <Plus size={17} />
                    ) : (
                      <WalletIcon size={17} />
                    )}{" "}
                    {wallet ? "Create your first vault" : "Connect Xverse to begin"}
                    <ArrowRight size={16} />
                  </button>
                  {!wallet && (
                    <span className="subnote">
                      <LockKeyhole size={13} />
                      Connecting never moves your funds.
                    </span>
                  )}
                </div>
              ) : (
                <>
                  <div className="section-head">
                    <div>
                      <h2>
                        Vaults <span className="count">{vaults.length}</span>
                      </h2>
                      <p>Each vault has its own recovery backup and takes exactly one deposit.</p>
                    </div>
                    <div className="section-actions">
                      <button
                        className="secondary"
                        title="Downloads each vault's QSB version, deposit and status as JSON. No secrets."
                        onClick={() => downloadVaultExport(vaults, stray)}
                      >
                        Export
                      </button>
                      <button className="primary" onClick={newVault} disabled={!!busy}>
                        <Plus size={17} />
                        Create vault
                      </button>
                    </div>
                  </div>
                  <div className="vault-list">
                    {vaults.map((v) => {
                      const job = jobs.find((j) => j.vaultId === v.id);
                      const key = `vault:${v.id}`;
                      const stuck = v.status === "submitted" && resendable.has(v.id) && submissionOn;
                      const flagged = stray.find((p) => p.vaultId === v.id);
                      return (
                        <article className="vault-row" key={v.id}>
                          <div className="vault-main">
                            <div className="vault-icon">
                              <LockKeyhole size={22} />
                            </div>
                            <div className="vault-name">
                              <h3>{v.name}</h3>
                              <p>
                                {v.status === "submitted"
                                  ? `Deposit sent · ${checkedAt[v.id] ? `last checked ${clock(checkedAt[v.id])}` : "checking the chain"}`
                                  : v.status === "unfunded"
                                    ? `Created ${new Date(v.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`
                                    : v.status === "spent"
                                      ? "Withdrawal confirmed"
                                      : "Deposit confirmed"}
                              </p>
                              <p className="vault-meta">
                                {v.configuration?.protocol ?? "Unknown version"}
                                {v.configuration && ` · generator ${v.configuration.generatorCommit.slice(0, 7)}`}
                                {v.funding && ` · deposit ${short(v.funding.txid)}:${v.funding.vout}`}
                              </p>
                              {flagged && (
                                <p className="vault-warning" role="status">
                                  {flagged.count === 1 ? "1 payment" : `${flagged.count} payments`} of{" "}
                                  {formatBtc(flagged.sats)} BTC reached this vault outside its one deposit. No
                                  withdrawal spends them, and the app can't recover them.
                                </p>
                              )}
                            </div>
                            <div className="vault-amount">
                              {formatBtc(v.funding?.value || "0")} <span>BTC</span>
                            </div>
                            <span className={`status-label ${v.status}`}>{vaultLabel(v, job)}</span>
                            <div className="vault-actions">
                              {v.status === "unfunded" && (
                                <button className="secondary" onClick={() => startTransaction(v)}>
                                  <ArrowDownLeft size={16} /> Deposit
                                </button>
                              )}
                              {v.status === "submitted" && (
                                <>
                                  <button
                                    className="text-button"
                                    disabled={!!busy}
                                    onClick={() =>
                                      rowAction(key, "Checking the deposit", async () => {
                                        const confirmed = await checkDeposit(v);
                                        say(key, "notice", confirmed ? "Deposit confirmed." : "Still waiting for confirmation. Nothing was resent.");
                                      })
                                    }
                                  >
                                    Check now
                                  </button>
                                  <button className="secondary" disabled>
                                    Waiting for confirmation
                                  </button>
                                </>
                              )}
                              {v.status === "confirmed" &&
                                (!job ? (
                                  <button className="secondary" onClick={() => startTransaction(v)}>
                                    <ArrowUpRight size={16} /> Withdraw
                                  </button>
                                ) : legacySearchControls(job).authorize ? (
                                  <button className="primary" disabled={!!busy} onClick={() => openAuthorization(job)}>
                                    Review and authorize
                                  </button>
                                ) : (
                                  <button className="secondary" onClick={() => go("activity")}>
                                    View withdrawal
                                  </button>
                                ))}
                              {v.status === "spent" && job?.txid && (
                                <a
                                  className="text-button"
                                  href={`${NETWORK_CONFIG.explorerUrl}/tx/${job.txid}`}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  View transaction <ExternalLink size={14} />
                                </a>
                              )}
                            </div>
                          </div>
                          {stuck && (
                            <details className="stuck">
                              <summary>Deposit stuck?</summary>
                              <p>
                                If it hasn't confirmed after a few blocks, send the same signed deposit again. It
                                can only confirm once. Never make another deposit.
                              </p>
                              <div className="stuck-actions">
                                <button
                                  className="secondary"
                                  title="Resends the same signed deposit to MARA Slipstream. It can only confirm once."
                                  onClick={() => void resendDeposit(v)}
                                >
                                  Resend deposit to MARA
                                </button>
                                <button
                                  className="secondary"
                                  title="Shows the signed deposit so you can submit it on slipstream.mara.com yourself."
                                  onClick={() => void showManualDeposit(v)}
                                >
                                  Submit manually on MARA
                                </button>
                              </div>
                              {manualDeposit?.vaultId === v.id && (
                                <section className="manual-slipstream" aria-label="Submit a deposit on MARA Slipstream">
                                  <h3>Submit the deposit yourself on MARA Slipstream</h3>
                                  <p>
                                    Paste this signed deposit into the "Transaction/Package Hex" field on{" "}
                                    <a href="https://slipstream.mara.com/" target="_blank" rel="noreferrer">slipstream.mara.com</a> and submit it
                                    there (that means accepting MARA's terms). It's the same deposit the app recorded, so it can only confirm
                                    once: don't create another. The vault shows as confirmed once it's mined.
                                  </p>
                                  <p>Transaction ID: {manualDeposit.txid}</p>
                                  <textarea readOnly rows={4} aria-label="Signed deposit transaction (hex)" value={manualDeposit.rawTxHex} />
                                  <div className="stuck-actions">
                                    <button type="button" className="secondary" onClick={() => navigator.clipboard?.writeText(manualDeposit.rawTxHex).then(() => say(key, "notice", "Copied the signed deposit."), () => say(key, "error", "Couldn't copy. Select the text and copy it yourself."))}>
                                      Copy transaction
                                    </button>
                                    <button type="button" className="secondary" onClick={() => setManualDeposit(undefined)}>
                                      Close
                                    </button>
                                  </div>
                                </section>
                              )}
                            </details>
                          )}
                          {rowMessage(key)}
                        </article>
                      );
                    })}
                  </div>
                </>
              )}
              <div className="foot-grid">
                <div>
                  <span className="step-number">01</span>
                  <strong>Connect & create</strong>
                  <p>
                    Your wallet funds the vault.
                    <br /> New QSB keys stay on your device.
                  </p>
                </div>
                <div>
                  <span className="step-number">02</span>
                  <strong>Back up & verify</strong>
                  <p>
                    Save an encrypted recovery file.
                    <br /> Check it before making a deposit.
                  </p>
                </div>
                <div>
                  <span className="step-number">03</span>
                  <strong>Withdraw on your terms</strong>
                  <p>
                    On-demand computation prepares
                    <br /> your spend. You authorize it.
                  </p>
                </div>
              </div>
            </>
          )}
          {page === "activity" && (
            <>
              <div className="section-head">
                <h2>
                  Withdrawals <span className="count">{jobs.length}</span>
                </h2>
              </div>
              {jobs.length === 0 ? (
                <div className="empty-vault">
                  <Activity size={36} strokeWidth={1.4} />
                  <h3>No withdrawals yet.</h3>
                  <p>When you withdraw from a vault, its progress shows here.</p>
                  <a className="secondary" href="#/vaults">
                    Go to my vaults <ArrowRight size={16} />
                  </a>
                </div>
              ) : (
                jobs.map((j) => {
                  const key = `job:${j.id}`;
                  const controls = legacySearchControls(j);
                  return (
                    <article className="job" key={j.id}>
                      <div className="job-main">
                        <div className="job-name">
                          <h3>{vaultName(j.vaultId) ?? "Withdrawal"}</h3>
                          <p>
                            {j.manifest?.outputValue && `${formatBtc(j.manifest.outputValue)} BTC to ${short(j.manifest.destination)} · `}
                            {gpuTime(j.computeSeconds)} of GPU time
                          </p>
                          <p className="job-id">
                            Request {short(j.id)}
                            {checkedAt[j.id] && ` · last checked ${clock(checkedAt[j.id])}`}
                          </p>
                        </div>
                        <span className={`status-label job-${j.status}`}>{jobLabel(j)}</span>
                        <div className="job-actions">
                          {j.txid && j.status !== "confirmed" && (
                            <button
                              className="text-button"
                              disabled={!!busy}
                              onClick={() =>
                                rowAction(key, "Checking confirmation", async () => {
                                  const observation = await checkWithdrawal(j);
                                  if (observation.status === "conflict") throw Error(conflictText(observation.alert));
                                  say(key, "notice", observation.status === "confirmed" ? "Withdrawal confirmed." : `Withdrawal transaction: ${observation.status}. Nothing was resent.`);
                                })
                              }
                            >
                              Check now
                            </button>
                          )}
                          {j.txid && (
                            <a
                              className="text-button"
                              href={`${NETWORK_CONFIG.explorerUrl}/tx/${j.txid}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              View transaction <ExternalLink size={14} />
                            </a>
                          )}
                          {controls.pause && (
                            <button
                              className="secondary"
                              disabled={!!busy}
                              onClick={() =>
                                rowAction(key, "Pausing", async () => {
                                  await api(`/jobs/${j.id}/pause`, {});
                                  setJobs((js) =>
                                    js.map((x) =>
                                      x.id === j.id ? { ...x, status: "paused" } : x,
                                    ),
                                  );
                                })
                              }
                            >
                              Pause search
                            </button>
                          )}
                          {controls.resume && (
                            <button
                              className="secondary"
                              disabled={!!busy}
                              onClick={() =>
                                rowAction(key, "Resuming", async () => {
                                  const updated = await api<{ job: Job }>(
                                    `/jobs/${j.id}/resume`,
                                    {},
                                  );
                                  setJobs((js) =>
                                    js.map((x) => (x.id === j.id ? updated.job : x)),
                                  );
                                })
                              }
                            >
                              Resume search
                            </button>
                          )}
                          {controls.authorize && (
                            <button className="primary" disabled={!!busy} onClick={() => openAuthorization(j)}>
                              Review and authorize
                            </button>
                          )}
                        </div>
                      </div>
                      {j.error && <p className="job-error" role="status">{j.error}</p>}
                      {rowMessage(key)}
                    </article>
                  );
                })
              )}
              <div className="info-note">
                <BookOpen size={20} />
                <p>
                  Customer billing and spending-limit enforcement are not
                  enabled. Recorded execution time is not an invoice. You can
                  pause a search; completed work is retained. See{" "}
                  <a href="#/costs">Costs</a> for the itemized policy.
                </p>
              </div>
            </>
          )}
          {page === "recovery" && (
            <div className="recovery-layout">
              <section className="panel">
                <div className="icon-square">
                  <FileKey2 size={25} />
                </div>
                <h2>Restore a recovery file</h2>
                <p>
                  Your file is decrypted locally. Neither the file nor its
                  passphrase is uploaded.
                </p>
                <label className="file-drop">
                  <FileKey2 size={24} />
                  <strong>
                    {restoreFile
                      ? "Recovery file selected"
                      : "Choose encrypted recovery file"}
                  </strong>
                  <span>QSB recovery · JSON</span>
                  <input
                    aria-label="Recovery file"
                    type="file"
                    accept="application/json,.json"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) {
                        if (f.size > 260000) {
                          setError("Recovery file is too large.");
                          return;
                        }
                        setRestored(undefined);
                        void f.text().then(setRestoreFile);
                      }
                    }}
                  />
                </label>
                <label>
                  Recovery passphrase
                  <input
                    type="password"
                    autoComplete="off"
                    value={pass}
                    onChange={(e) => setPass(e.target.value)}
                    placeholder="Enter your backup passphrase"
                  />
                </label>
                <button
                  className="primary full"
                  onClick={restore}
                  disabled={!restoreFile || !pass || !!busy}
                >
                  {busy ? (
                    <LoaderCircle size={17} className="spin" />
                  ) : (
                    <KeyRound size={17} />
                  )}
                  Restore on this device
                </button>
                {restored && (
                  <div className="restored">
                    <CheckCheck size={20} />
                    <div>
                      <strong>{restored.vault.name} verified</strong>
                      <p>Vault ID: {restored.vault.id}</p>
                      <p className="recovery-fingerprint">
                        Script fingerprint: {restored.vault.scriptHash}
                      </p>
                      <p>
                        {restored.authorization
                          ? "This backup contains a withdrawal intent. Preserve it and resume that exact withdrawal."
                          : "No withdrawal intent is recorded in this backup. Keep the latest backup if you later authorize a withdrawal."}
                      </p>
                      <button
                        className="text-button"
                        onClick={() => {
                          setRestored(undefined);
                          lockQsb();
                          setRestoreFile("");
                          setNotice("Recovery result cleared.");
                        }}
                      >
                        Clear recovery result
                      </button>
                    </div>
                  </div>
                )}
              </section>
              <div className="recovery-explainer">
                <h2>A backup is part of the vault.</h2>
                <p>
                  QSB uses signing material that your Xverse recovery phrase
                  does not contain.
                </p>
                <ol>
                  <li>Keep the encrypted file somewhere you control.</li>
                  <li>Store its passphrase separately.</li>
                  <li>
                    Keep the full backup after funding, including your
                    transaction details.
                  </li>
                </ol>
                <div className="info-note">
                  <LockKeyhole size={22} />
                  <p>
                    Lost recovery material can mean permanently lost Bitcoin.
                    There is no service-held recovery key.
                  </p>
                </div>
              </div>
            </div>
          )}
          {page === "protocol" && (
            <>
              <div className="protocol-grid">
                {[
                  {
                    icon: WalletIcon,
                    title: "01. Fund from Xverse",
                    text: `Your Bitcoin moves into a dedicated QSB output on ${NETWORK_CONFIG.label}.`,
                  },
                  {
                    icon: Fingerprint,
                    title: "02. Hold with QSB",
                    text: "The vault uses hash-based signing conditions. Its recovery secrets remain yours.",
                  },
                  {
                    icon: Activity,
                    title: "03. Compute a withdrawal",
                    text: "AWS GPUs search public transaction data. The GPU never needs your recovery secrets.",
                  },
                  {
                    icon: CheckCheck,
                    title: "04. Verify & authorize",
                    text: "Your device checks the solution and authorizes the spend. MARA submits it directly to a miner.",
                  },
                ].map((x) => (
                  <article className="panel" key={x.title}>
                    <x.icon size={27} />
                    <h3>{x.title}</h3>
                    <p>{x.text}</p>
                  </article>
                ))}
              </div>
              <WalletCheck
                key={wallet?.address || "disconnected"}
                wallet={wallet}
                vaults={vaults}
              />
              <div className="panel protocol-caveat">
                <h2>Experimental means experimental.</h2>
                <p>
                  QSB is a research construction, not an unconditional guarantee
                  against quantum attacks. Protection applies only to the funded
                  QSB output. BTC returned to a normal Xverse address uses that
                  address’s ordinary security.
                </p>
                <p>
                  Search costs vary and mining is best effort. A completed
                  search is not a confirmed transaction.
                </p>
                <a
                  className="text-button"
                  href="https://github.com/avihu28/Quantum-Safe-Bitcoin-Transactions/blob/main/paper/QSB.pdf"
                  target="_blank"
                  rel="noreferrer"
                >
                  Read the QSB paper <ExternalLink size={15} />
                </a>
              </div>
            </>
          )}
        </main>
      </div>
      <dialog
        ref={dialog}
        onCancel={(e) => {
          e.preventDefault();
          closeModal();
        }}
      >
        <div className="dialog-content">
          <button
            className="close"
            aria-label="Close dialog"
            onClick={closeModal}
            disabled={!!busy}
          >
            <X size={20} />
          </button>
          {modal === "readiness" ? (
            <>
              <div className="eyebrow">SERVICE STATUS</div>
              <h2>{statusLabel[status]}.</h2>
              <p>{statusDetail[status]}</p>
              {checks.length > 0 && (
                <>
                  <h3 className="checklist-title">
                    Release checks · {checks.filter((c) => c.passed).length} of {checks.length} passed
                  </h3>
                  <div className="checklist">
                    {checks.map((c) => (
                      <div key={c.id}>
                        {c.passed ? (
                          <CheckCheck size={20} />
                        ) : (
                          <span className="unchecked" />
                        )}
                        <span>{c.label}</span>
                        <b>{c.passed ? "Passed" : "Pending"}</b>
                      </div>
                    ))}
                  </div>
                </>
              )}
              <button className="primary full" onClick={closeModal}>
                Close
              </button>
            </>
          ) : (
            <>
              <div className="eyebrow">NEW VAULT · STEP {step} OF 3</div>
              <h2>
                {step === 1
                  ? "Name it and set a passphrase."
                  : step === 2
                    ? "Save your backup."
                    : "Your vault is ready."}
              </h2>
              <div className="steps">
                {[1, 2, 3].map((s) => (
                  <span key={s} className={s <= step ? "done" : ""} />
                ))}
              </div>
              {step === 1 ? (
                <>
                  <p>
                    The vault's keys are generated on this device, then
                    encrypted with a passphrase only you know.
                  </p>
                  {!wallet ? (
                    <div className="connect-prompt">
                      <WalletIcon size={25} />
                      <p>
                        Connect Xverse to identify the wallet that will fund
                        this vault.
                      </p>
                      <button
                        className="primary full"
                        onClick={connect}
                        disabled={!!busy}
                      >
                        Connect Xverse
                      </button>
                    </div>
                  ) : (
                    <>
                      <label>
                        Vault name
                        <input
                          value={name}
                          maxLength={60}
                          onChange={(e) => setName(e.target.value)}
                        />
                      </label>
                      <label>
                        Recovery passphrase
                        <input
                          type="password"
                          autoComplete="new-password"
                          aria-describedby="pass-hint"
                          value={pass}
                          onChange={(e) => setPass(e.target.value)}
                          placeholder="At least 14 characters"
                        />
                      </label>
                      <p id="pass-hint" className={passLongEnough ? "field-hint ok" : "field-hint"}>
                        {passLongEnough ? <><Check size={13} /> Meets the 14-character minimum</> : `${pass.length} of 14 characters`}
                      </p>
                      <label>
                        Confirm passphrase
                        <input
                          type="password"
                          autoComplete="new-password"
                          aria-describedby="confirm-hint"
                          value={confirmPass}
                          onChange={(e) => setConfirmPass(e.target.value)}
                        />
                      </label>
                      {confirmPass && (
                        <p id="confirm-hint" className={passMatch ? "field-hint ok" : "field-hint bad"}>
                          {passMatch ? <><Check size={13} /> Passphrases match</> : "Doesn't match yet"}
                        </p>
                      )}
                      <div className="info-note compact">
                        <LockKeyhole size={17} />
                        <p>
                          This is separate from your Xverse password. We cannot
                          recover it.
                        </p>
                      </div>
                      {error && (
                        <p className="inline-error" role="alert">
                          {error}
                        </p>
                      )}
                      <button
                        className="primary full"
                        onClick={generate}
                        disabled={!!busy || !formReady}
                      >
                        {busy ? (
                          <LoaderCircle className="spin" size={17} />
                        ) : (
                          <Fingerprint size={17} />
                        )}{" "}
                        {busy || "Generate vault keys"}
                      </button>
                    </>
                  )}
                </>
              ) : step === 2 ? (
                <>
                  <p>
                    Save the encrypted backup, then open it again here. That
                    proves the file can restore this vault before any Bitcoin
                    moves.
                  </p>
                  <ol className="substeps">
                    <li>
                      <strong>Download the encrypted backup.</strong>
                      <span>
                        It saves as{" "}
                        <code>{recovery ? recoveryBackupFilename(recovery.vault.id) : "qsb-recovery.json"}</code>.
                        Keep it somewhere you control.
                      </span>
                      <button
                        className="secondary full"
                        onClick={() =>
                          downloadBackup(encrypted, recovery!.vault.id)
                        }
                      >
                        <Download size={18} />
                        Download encrypted backup
                      </button>
                    </li>
                    <li>
                      <strong>Select the file you saved.</strong>
                      <label className="file-drop">
                        <FileKey2 size={25} />
                        <strong>
                          {verified
                            ? "Backup successfully verified"
                            : "Select your saved backup to verify"}
                        </strong>
                        <span>
                          {verified
                            ? "The keys and script match."
                            : "Your file stays on this device."}
                        </span>
                        <input
                          aria-label="Verify downloaded backup"
                          type="file"
                          accept=".json"
                          onChange={(e) => void verifyFile(e.target.files?.[0])}
                        />
                      </label>
                    </li>
                  </ol>
                  {error && (
                    <p className="inline-error" role="alert">
                      {error}
                    </p>
                  )}
                  <button
                    className="primary full"
                    disabled={!verified || !!busy}
                    onClick={save}
                  >
                    {busy ? (
                      <LoaderCircle className="spin" size={17} />
                    ) : (
                      <CheckCheck size={17} />
                    )}
                    Save vault
                  </button>
                </>
              ) : (
                <>
                  <div className="complete-icon">
                    <Check size={34} />
                  </div>
                  <p>
                    Your backup is verified. Only the vault's public details
                    were saved to the service. No Bitcoin has moved yet.
                  </p>
                  {status === "on" ? (
                    <>
                      <button className="primary full" onClick={depositNow}>
                        Deposit now <ArrowRight size={17} />
                      </button>
                      <button className="secondary full" onClick={closeModal}>
                        Back to my vaults
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="info-note compact">
                        <AlertCircle size={19} />
                        <p>
                          {status === "search-only"
                            ? "Deposits can't be sent right now: submission to MARA is off. Deposit from My vaults once it's on."
                            : "Deposits are off right now. Deposit from My vaults once they're on."}
                        </p>
                      </div>
                      <button className="primary full" onClick={closeModal}>
                        Back to my vaults <ArrowRight size={17} />
                      </button>
                    </>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </dialog>
      {transaction && wallet && !conflictingCreation && (
        <TransactionDialog
          vault={transaction.vault}
          wallet={wallet}
          job={transaction.job}
          solvedResult={transaction.solvedResult}
          onClose={() => setTransaction(undefined)}
          onUpdated={() => {
            void Promise.all([
              api<{ vaults: PublicVault[] }>("/vaults"),
              api<{ jobs: Job[] }>("/jobs"),
            ])
              .then(([v, j]) => {
                setVaults(v.vaults);
                setJobs(j.jobs);
              })
              .catch(() => {});
          }}
        />
      )}
    </div>
  );
}
