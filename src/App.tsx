import { legacySearchControls } from "./lib/jobControls";
import { vaultConfiguration } from "./lib/provenance";
import { NETWORK_ID, NETWORK_CONFIG } from "./lib/network";
import { operationsAllowed } from "./lib/readiness";
import { useEffect, useRef, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ArrowRight,
  Check,
  CheckCheck,
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
  ShieldCheck,
  Wallet as WalletIcon,
  X,
  Activity,
  BookOpen,
  KeyRound,
  LogOut,
  AlertCircle,
} from "lucide-react";
import { api, authenticate, clearSession, readSessionEpoch } from "./lib/api";
import { MAINNET_SEARCH_PROFILE } from "./mainnet/submission";
import TransactionDialog from "./TransactionDialog";
import { MainnetRecoveryRoute } from "./mainnet/RecoveryRoute";
import WalletCheck from "./WalletCheck";
import OfflineFixture from "./OfflineFixture";
import Costs, { CostDisclosure } from "./Costs";
import { connectWallet, signMessage, type Wallet } from "./lib/wallet";
import { generateQsb, validateRecovery, lockQsb } from "./lib/qsb";
import { encryptRecovery, decryptRecovery, downloadBackup } from "./lib/backup";
import {
  formatBtc,
  release,
  type PublicVault,
  type Recovery,
  type Job,
} from "./lib/model";
type Page = "vaults" | "activity" | "recovery" | "protocol" | "costs";
const short = (s: string) => `${s.slice(0, 7)}…${s.slice(-6)}`;
const nav = [
  { id: "vaults", label: "My vaults", icon: Layers3 },
  { id: "activity", label: "Activity", icon: Activity },
  { id: "costs", label: "Costs & billing", icon: BookOpen },
  { id: "recovery", label: "Recovery", icon: KeyRound },
  { id: "protocol", label: "How QSB works", icon: BookOpen },
] as const;
export default function App() {
  const [page, setPage] = useState<Page>("vaults"),
    [wallet, setWallet] = useState<Wallet>(),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [vaults, setVaults] = useState<PublicVault[]>([]),
    [jobs, setJobs] = useState<Job[]>([]),
    [modal, setModal] = useState<"create" | "readiness" | null>(null),
    [step, setStep] = useState(1),
    [name, setName] = useState("My first vault"),
    [pass, setPass] = useState(""),
    [confirmPass, setConfirmPass] = useState(""),
    [recovery, setRecovery] = useState<Recovery>(),
    [encrypted, setEncrypted] = useState(""),
    [verified, setVerified] = useState(false),
    [restoreFile, setRestoreFile] = useState(""),
    [restored, setRestored] =
      useState<Pick<Recovery, "vault" | "authorization">>(),
    [config, setConfig] = useState<any>(release),
    [notice, setNotice] = useState("");
  const supervisedSearchEnabled = NETWORK_ID === "mainnet" && config?.network === "mainnet" && config?.supervisedSearch?.enabled === true && config.supervisedSearch.releaseId === MAINNET_SEARCH_PROFILE;
  const mainnetRecoveryEnabled = NETWORK_ID === "mainnet" && config?.network === "mainnet" && config?.mainnetRecoveryEnabled === true && config?.supervisedSearch?.releaseId === MAINNET_SEARCH_PROFILE;
  const [mainnetRecovery, setMainnetRecovery] = useState<Job>();
  const [transaction, setTransaction] = useState<{
    vault: PublicVault;
    job?: Job;
  }>();
  const conflictingCreation = !!transaction && !transaction.job && jobs.some((job) => job.vaultId === transaction.vault.id);
  useEffect(() => {
    if (!conflictingCreation) return;
    setTransaction(undefined);
    setPage("activity");
    setNotice("This vault already has a withdrawal request. Review it in Activity.");
  }, [conflictingCreation]);
  const dialog = useRef<HTMLDialogElement>(null),
    generation = useRef(0);
  useEffect(() => {
    api("/config")
      .then((value) => {
        setConfig(value);
        if ((value as { network?: string }).network !== NETWORK_ID)
          setError(
            "Server network does not match this app. Transactions are disabled.",
          );
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (modal) dialog.current?.showModal();
    else dialog.current?.close();
  }, [modal]);
  useEffect(() => {
    if (!wallet) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const [v, j] = await Promise.all([
          api<{ vaults: PublicVault[] }>("/vaults"),
          api<{ jobs: Job[] }>("/jobs"),
        ]);
        if (!disposed) {
          setVaults(v.vaults);
          setJobs(j.jobs);
        }
      } catch {}
    };
    void refresh();
    const t = setInterval(refresh, 15000);
    return () => {
      disposed = true;
      clearInterval(t);
    };
  }, [wallet]);
  useEffect(() => {
    const changed = () => disconnect();
    window.addEventListener("qsb-wallet-changed", changed);
    return () => window.removeEventListener("qsb-wallet-changed", changed);
  }, []);
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
  async function connect() {
    setMainnetRecovery(undefined);
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
    setMainnetRecovery(undefined);
    generation.current++;
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
  function newVault() {
    setError("");
    setStep(1);
    setPass("");
    setConfirmPass("");
    setRecovery(undefined);
    setEncrypted("");
    setVerified(false);
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
      const vault: PublicVault = {
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
      };
      vault.configuration = vaultConfiguration(vault);
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
  const balance = vaults
    .filter((v) => v.status === "confirmed")
    .reduce((n, v) => n + BigInt(v.funding?.value || "0"), 0n);
  return (
    <div className="shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("vaults");
          }}
          aria-label="QSB home"
        >
          <span className="brand-mark">
            <Layers3 size={25} />
          </span>
          qsb<span className="brand-dot">.</span>
        </a>
        <div className="side-label">YOUR BITCOIN. YOUR KEYS.</div>
        <nav aria-label="Main navigation">
          {nav.map((n) => (
            <button
              key={n.id}
              className={page === n.id ? "nav active" : "nav"}
              onClick={() => {
                setPage(n.id);
                setError("");
              }}
            >
              <n.icon size={19} />
              {n.label}
              {page === n.id && <ChevronRight size={16} />}
            </button>
          ))}
        </nav>
        <div className="side-bottom">
          <div className="private-note">
            <Fingerprint size={27} />
            <strong>Ownership stays with you.</strong>
            <p>Recovery keys are generated and used on your device.</p>
          </div>
          <div className="network">
            <span />
            {NETWORK_CONFIG.label} <span className="poc">POC</span>
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
          <div className="breadcrumb">
            Workspace <ChevronRight size={14} />{" "}
            <span>{nav.find((n) => n.id === page)?.label}</span>
          </div>
          <button
            className={wallet ? "wallet connected" : "wallet"}
            onClick={wallet ? disconnect : connect}
            disabled={!!busy}
          >
            {wallet ? (
              <>
                <span className="wallet-dot" />
                {short(wallet.address)}
                <LogOut size={15} />
              </>
            ) : (
              <>
                <WalletIcon size={17} />
                Connect Xverse
              </>
            )}
          </button>
        </header>
        <main>
          {NETWORK_ID === "testnet4" && (
            <div className="notice" role="status">
              <strong>Testnet4 rehearsal · test coins only.</strong> Select
              Testnet4 in Xverse and use a dedicated test wallet. Testnet3 and
              mainnet wallets are not supported here. GPU work still has a real
              monetary cost.
            </div>
          )}
          <div className="page-top">
            <div>
              <div className="eyebrow">BITCOIN, HELD FOR THE FUTURE</div>
              <h1>
                {page === "vaults"
                  ? "Your Bitcoin. A new layer of protection."
                  : page === "activity"
                    ? "Every step, accounted for."
                    : page === "recovery"
                      ? "Your backup. Your way back."
                      : page === "costs"
                        ? "Every cost, explained."
                        : "Built on Bitcoin. Secured by hashes."}
              </h1>
              <p className="subtitle">
                {page === "vaults"
                  ? NETWORK_ID === "testnet4"
                    ? "Rehearse deposits and withdrawals with Testnet4 coins. Funding stays disabled until the server verifies the network and enables the rehearsal."
                    : "Create and test an unfunded QSB vault. Mainnet funding is currently disabled."
                  : page === "activity"
                    ? "Follow transactions and the computation behind your withdrawals."
                    : page === "recovery"
                      ? "Restore your QSB recovery file on this device. Your Xverse seed is separate."
                      : page === "costs"
                        ? "See what is known, what is estimated and what is not connected yet."
                        : "Understand what changes when Bitcoin moves into a QSB vault."}
              </p>
            </div>
            <span className="experiment">EXPERIMENTAL</span>
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
              <div className="overview">
                <div className="balance-card">
                  <div className="card-label">
                    BTC IN CONFIRMED VAULTS <ShieldCheck size={18} />
                  </div>
                  <div className="balance">
                    {formatBtc(balance)} <span>BTC</span>
                  </div>
                  <div className="balance-bottom">
                    <span>
                      {vaults.filter((v) => v.status === "confirmed").length}{" "}
                      funded vaults
                    </span>
                    <span className="badge">
                      <LockKeyhole size={12} />
                      Self custody
                    </span>
                  </div>
                </div>
                <div className="intro-card">
                  <div className="intro-heading">
                    <span className="icon-square">
                      <Fingerprint size={25} />
                    </span>
                    <span className="tiny-label">
                      A DIFFERENT SPENDING CONDITION
                    </span>
                  </div>
                  <h2>
                    Keep the keys.
                    <br />
                    Change the protection.
                  </h2>
                  <p>
                    QSB uses hash-based signing to protect a dedicated Bitcoin
                    output. No wrapped assets. No bridge.
                  </p>
                  <button
                    className="text-button"
                    onClick={() => setPage("protocol")}
                  >
                    Understand QSB <ArrowRight size={16} />
                  </button>
                </div>
              </div>
              <div className="section-head">
                <div>
                  <h2>
                    My vaults <span className="count">{vaults.length}</span>
                  </h2>
                  <p>Each vault has its own recovery backup.</p>
                </div>
                <button className="primary" onClick={newVault}>
                  <Plus size={17} />
                  Create vault
                </button>
              </div>
              {vaults.length === 0 ? (
                <div className="empty-vault">
                  <div className="empty-icon">
                    <Layers3 size={34} />
                  </div>
                  <h3>A place for your first vault.</h3>
                  <p>
                    Connect Xverse, generate your keys, and save your recovery
                    backup before moving any Bitcoin.
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
                    {wallet
                      ? "Create your first vault"
                      : "Connect Xverse to begin"}
                    <ArrowRight size={16} />
                  </button>
                  <span className="subnote">
                    <LockKeyhole size={13} />
                    Connecting never moves your funds.
                  </span>
                </div>
              ) : (
                <div className="vault-list">
                  {vaults.map((v) => (
                    <article className="vault-row" key={v.id}>
                      <div className="vault-icon">
                        <LockKeyhole size={22} />
                      </div>
                      <div className="vault-name">
                        <h3>{v.name}</h3>
                        <p>{short(v.scriptHash)} · Config A</p>
                      </div>
                      <div className="vault-amount">
                        {formatBtc(v.funding?.value || "0")} <span>BTC</span>
                      </div>
                      <span className="status-label">
                        {v.status === "unfunded" ? "Ready to fund" : v.status}
                      </span>
                      {v.funding && (
                        <button
                          className="text-button"
                          disabled={!!busy}
                          onClick={() =>
                            action("Checking transaction", async () => {
                              const observation = await api<{ status: string }>(
                                `/transactions/${v.funding!.txid}/status`,
                              );
                              if (observation.status === "confirmed") {
                                const updated = await api<{
                                  vault: PublicVault;
                                }>(`/vaults/${v.id}/funding`);
                                setVaults((items) =>
                                  items.map((item) =>
                                    item.id === v.id ? updated.vault : item,
                                  ),
                                );
                              }
                              setNotice(
                                `Funding transaction: ${observation.status}. No transaction was resubmitted.`,
                              );
                            })
                          }
                        >
                          Check transaction
                        </button>
                      )}
                      <button
                        className="secondary"
                        disabled={v.status === "spent"}
                        onClick={() => {
                          // Status alone never releases this vault's one-time commitments.
                          // Paused/failed and stale submitted/confirmed rows still need review.
                          // The server reservation checks remain authoritative for stale clients.
                          if (jobs.some((job) => job.vaultId === v.id)) {
                            setPage("activity");
                            setNotice("This vault already has a withdrawal request. Review it in Activity.");
                            return;
                          }
                          if (operationsAllowed(config) || (supervisedSearchEnabled && v.status === "confirmed" && !!v.funding))
                            setTransaction({ vault: v });
                          else setModal("readiness");
                        }}
                      >
                        {v.status === "unfunded" ? (
                          <ArrowDownLeft size={16} />
                        ) : (
                          <ArrowUpRight size={16} />
                        )}{" "}
                        {v.status === "unfunded" ? "Deposit" : "Withdraw"}
                      </button>
                    </article>
                  ))}
                </div>
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
                <h2>Withdrawal requests</h2>
                <span className="status-label">{jobs.length} requests</span>
              </div>
              {jobs.length === 0 ? (
                <div className="empty-vault">
                  <Activity size={36} strokeWidth={1.4} />
                  <h3>No activity yet.</h3>
                  <p>
                    Deposit confirmations and withdrawal searches will appear
                    here. Compute time and miner confirmation are tracked
                    separately.
                  </p>
                  <button
                    className="secondary"
                    onClick={() => setPage("vaults")}
                  >
                    Back to vaults <ArrowRight size={16} />
                  </button>
                </div>
              ) : (
                jobs.map((j) => (
                  <article className="job" key={j.id}>
                    <div>
                      <h3>{short(j.id)}</h3>
                      <p>
                        {j.stage} · {j.computeSeconds.toLocaleString()} compute
                        seconds
                      </p>
                    </div>
                    <span className="status-label">
                      {j.status.replaceAll("_", " ")}
                    </span>
                    {j.error && <p role="status">{j.error}</p>}
                    {j.txid && (
                      <a
                        href={`${NETWORK_CONFIG.explorerUrl}/tx/${j.txid}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View transaction
                      </a>
                    )}
                    {j.status === "awaiting_authorization" && (
                      <button
                        className="primary"
                        onClick={() => {
                          const execution = (j as Job & { execution?: { kind?: string; profile?: { id?: string } } }).execution;
                          if (execution !== undefined) {
                            if (mainnetRecoveryEnabled && execution?.kind === "qsb-supervised-service-v1" && execution.profile?.id === MAINNET_SEARCH_PROFILE)
                              setMainnetRecovery(j);
                            else setModal("readiness");
                            return;
                          }
                          const vault = vaults.find((v) => v.id === j.vaultId);
                          if (vault && operationsAllowed(config))
                            setTransaction({ vault, job: j });
                          else setModal("readiness");
                        }}
                      >
                        Review and authorize
                      </button>
                    )}
                    {legacySearchControls(j).resume && (
                      <button
                        className="secondary"
                        onClick={() =>
                          action("Resuming", async () => {
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
                    {j.txid && (
                      <button
                        className="secondary"
                        onClick={() =>
                          action("Checking confirmation", async () => {
                            const observation = await api<{ status: string }>(
                              `/transactions/${j.txid}/status`,
                            );
                            if (observation.status !== "confirmed") {
                              setNotice(
                                `Withdrawal transaction: ${observation.status}. No transaction was resubmitted.`,
                              );
                              return;
                            }
                            const updated = await api<{ job: Job }>(
                              `/jobs/${j.id}/status`,
                            );
                            setJobs((js) =>
                              js.map((x) => (x.id === j.id ? updated.job : x)),
                            );
                            setVaults(
                              (await api<{ vaults: PublicVault[] }>("/vaults"))
                                .vaults,
                            );
                          })
                        }
                      >
                        Refresh confirmation
                      </button>
                    )}
                    {legacySearchControls(j).pause && (
                      <button
                        className="secondary"
                        onClick={() =>
                          action("Pausing", async () => {
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
                  </article>
                ))
              )}
              <div className="info-note">
                <BookOpen size={20} />
                <p>
                  Customer billing and spending-limit enforcement are not
                  enabled. Recorded execution time is not an invoice. You can
                  pause a search; completed work is retained. See Costs &
                  billing for the itemized policy.
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
                    text: "Runpod searches public transaction data. The GPU never needs your recovery secrets.",
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
              <OfflineFixture
                key={`offline-${wallet?.address || "disconnected"}`}
                wallet={wallet}
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
          <div className="readiness-banner">
            <div>
              <span className="amber-dot" />
              <strong>
                {operationsAllowed(config)
                  ? `${NETWORK_CONFIG.label} rehearsal operations are enabled.`
                  : `${NETWORK_CONFIG.label} funding is not enabled yet.`}
              </strong>
              <span>Wallet and transaction validation are in progress.</span>
            </div>
            <button onClick={() => setModal("readiness")}>
              View readiness <ArrowUpRight size={15} />
            </button>
          </div>
          <footer>
            <span>QSB / PROOF OF CONCEPT</span>
            <span>Bitcoin-native. Noncustodial. Experimental.</span>
            <button onClick={() => setPage("protocol")}>
              Protocol notes <ArrowUpRight size={13} />
            </button>
          </footer>
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
              <div className="eyebrow">RELEASE READINESS</div>
              <h2>Verify first. Fund second.</h2>
              <p>
                Local key generation and backup are available. Deposits and
                withdrawals require a matching network and an enabled server.
                Mainnet remains disabled.
              </p>
              <div className="checklist">
                {config.checks?.map((c: any) => (
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
              <button className="primary full" onClick={closeModal}>
                Got it
              </button>
            </>
          ) : (
            <>
              <div className="eyebrow">NEW VAULT · STEP {step} OF 3</div>
              <h2>
                {step === 1
                  ? "Make it yours."
                  : step === 2
                    ? "Save your way back."
                    : "Your vault is ready."}
              </h2>
              <div className="steps">
                {[1, 2, 3].map((s) => (
                  <span key={s} className={s <= step ? "done" : ""} />
                ))}
              </div>
              {error && (
                <p className="inline-error" role="alert">
                  {error}
                </p>
              )}
              {step === 1 && <CostDisclosure />}
              {step === 1 ? (
                <>
                  <p>
                    Generate QSB keys on this device, then encrypt them with a
                    passphrase only you know.
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
                          value={pass}
                          onChange={(e) => setPass(e.target.value)}
                          placeholder="At least 14 characters"
                        />
                      </label>
                      <label>
                        Confirm passphrase
                        <input
                          type="password"
                          autoComplete="new-password"
                          value={confirmPass}
                          onChange={(e) => setConfirmPass(e.target.value)}
                        />
                      </label>
                      <div className="info-note compact">
                        <LockKeyhole size={17} />
                        <p>
                          This is separate from your Xverse password. We cannot
                          recover it.
                        </p>
                      </div>
                      <button
                        className="primary full"
                        onClick={generate}
                        disabled={!!busy}
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
                    Download your encrypted backup, then select that file again
                    to confirm you can recover the vault.
                  </p>
                  <button
                    className="secondary full"
                    onClick={() =>
                      downloadBackup(encrypted, recovery!.vault.id)
                    }
                  >
                    <Download size={18} />
                    Download encrypted backup
                  </button>
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
                    Your backup is verified. Only public vault metadata was
                    saved to the service.
                  </p>
                  <div className="info-note compact">
                    <AlertCircle size={19} />
                    <p>
                      No Bitcoin has moved. Funding becomes available after the
                      transaction pipeline is verified.
                    </p>
                  </div>
                  <button className="primary full" onClick={closeModal}>
                    Return to my vaults <ArrowRight size={17} />
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </dialog>
      {mainnetRecovery && wallet && mainnetRecoveryEnabled && (
        <MainnetRecoveryRoute job={mainnetRecovery} wallet={wallet} walletEpoch={generation.current} onClose={() => setMainnetRecovery(undefined)} />
      )}
      {transaction && wallet && !conflictingCreation && (
        <TransactionDialog
          vault={transaction.vault}
          wallet={wallet}
          job={transaction.job}
          supervisedSearch={supervisedSearchEnabled && !transaction.job && !conflictingCreation && transaction.vault.status === "confirmed" && transaction.vault.funding ? { releaseId: MAINNET_SEARCH_PROFILE, sessionEpoch: readSessionEpoch() } : undefined}
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
