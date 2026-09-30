import {fingerprint} from './lib/provenance';
import {readSessionEpoch} from './lib/api';
import { operationsAllowed } from "./lib/readiness";
import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, X } from "lucide-react";
import "./styles.css";
import { CostDisclosure } from "./Costs";
import { base64, hex } from "@scure/base";
import { api } from "./lib/api";
import { signPsbt, type Wallet } from "./lib/wallet";
import {
  fundingFeeForRate,
  fundingPsbt,
  helperPsbt,
  belowMinerFloor,
  ceilMilliSatPerVb,
  formatFeeRate,
  minerMinimumRate,
  nestedPaymentAddress,
  parseFeeRate,
  transactionVsize,
  withdrawalFeeForRate,
  withdrawalVsize,
  verifySignedPsbt,
  verifyWithdrawalCommitment,
  outputScript,
  type FundingInput,
} from "./lib/transactions";
import {
  decryptRecovery,
  encryptRecovery,
  downloadBackup,
  recoveryBackupFilename,
  assertRecoveryAuthorization,
  bindRecoveryAssembly,
  assertRecoveryAssembly,
} from "./lib/backup";
import { assembleQsb, validateRecovery, lockQsb } from "./lib/qsb";
import {
  rebuildWithdrawalFromSolvedResult,
  signedCoordinatorResult,
} from "./mainnet/localSignature";
import type { CoordinatorSignedResult } from "./mainnet/coordinatorResult";
import {
  parseBtc,
  formatBtc,
  canonicalManifest,
  withdrawalSchema,
  type PublicVault,
  type Recovery,
  type Withdrawal,
  type Job,
} from "./lib/model";

type Point = { txid: string; vout: number; value: string };
const digest = async (text: string) =>
  hex.encode(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  );
function downloadPublicResult(text: string, jobId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(jobId))
    throw new Error("Invalid solved result.");
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `qsb-coordinator-public-signed-result-${jobId}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function TransactionDialog({
  vault,
  wallet,
  job,
  solvedResult,
  onClose,
  onUpdated,
}: {
  vault: PublicVault;
  wallet: Wallet;
  job?: Job;
  solvedResult?: unknown;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const generation = useRef(0);
  const lifetimeKey=fingerprint({vault,wallet,job:job?.id,solved:solvedResult??null});
  const lifetime=useRef(lifetimeKey);
  if(lifetime.current!==lifetimeKey){lifetime.current=lifetimeKey;generation.current++;}

  const [points, setPoints] = useState<Point[]>([]),
    [selection, setSelection] = useState<string[]>([]),
    [amount, setAmount] = useState(""),
    [feeRate, setFeeRate] = useState(""),
    // MARA's submission floor in sat/vB: undefined while loading, null if unavailable.
    [minerFloor, setMinerFloor] = useState<number | null>(),
    // Manual Slipstream submission needs both: deposits switched on, and the server holding
    // these exact signed bytes as the vault's intent (so no other device can start a deposit).
    [submissionOpen, setSubmissionOpen] = useState(false),
    // The exact bytes the server last confirmed it holds as this vault's intent.
    [confirmedRaw, setConfirmedRaw] = useState<string>(),
    [destination, setDestination] = useState(wallet.address),
    // The deployment's solver release: undefined while loading, null if none is served.
    [solverId, setSolverId] = useState<string | null>(),
    [accepted, setAccepted] = useState(false),
    [file, setFile] = useState(""),
    [pass, setPass] = useState(""),
    [unlocked, setUnlocked] = useState<Recovery>(),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [result, setResult] = useState(""),
    [intentBackup, setIntentBackup] = useState(""),
    [assemblyVerified, setAssemblyVerified] = useState(false),
    [pendingFunding, setPendingFunding] = useState<{
      txid: string;
      amount: string;
      /** The signed deposit, kept before submission so a retry can only resend these bytes. */
      rawTxHex?: string;
    }>();
  const [signedReview, setSignedReview] = useState<{rawTxHex: string; txid: string; manifest: Withdrawal; generation: number; epoch: number}>();
  const [signedDownload, setSignedDownload] = useState<string>();
  const [submitAllowed, setSubmitAllowed] = useState(false);
  const [copyNotice, setCopyNotice] = useState("");
  const submitAttempted = useRef(false);
  // Unlock the backup, choose the details, then review. An authorization, or a deposit that
  // is already signed, has nothing to choose and goes straight to review.
  const [stage, setStage] = useState<"unlock" | "details" | "review">("unlock");
  const feeTouched = useRef(false);
  async function reviewSigned(rawTxHex: string, txid: string, check: () => void) {
    if (!job) throw Error("Withdrawal job is missing.");
    check();
    setSignedReview({rawTxHex, txid, manifest: structuredClone(job.manifest), generation: generation.current, epoch: readSessionEpoch()});
    setResult("Signed locally in Xverse. Nothing was broadcast. Review the exact transaction before submitting.");
    try {
      const config = await api<{exactSubmitEnabled?: boolean}>("/config");
      check();
      setSubmitAllowed(config.exactSubmitEnabled === true);
      if (config.exactSubmitEnabled !== true) setResult("Submission is disabled. Keep the downloaded signed result; nothing was broadcast.");
    } catch {
      check();
      setSubmitAllowed(false);
      setResult("Submission availability could not be verified. Keep the downloaded signed result; nothing was broadcast.");
    }
  }
  async function approveSigned() {
    if (!signedReview || !job || !submitAllowed || submitAttempted.current) return;
    submitAttempted.current = true;
    await act("Submitting the approved exact transaction", async (check) => {
      const assertCurrent = () => {
        check();
        if (signedReview.generation !== generation.current || signedReview.epoch !== readSessionEpoch())
          throw Error("Wallet session changed. Reopen the transaction.");
      };
      assertCurrent();
      const config = await api<{exactSubmitEnabled?: boolean}>("/config");
      assertCurrent();
      if (config.exactSubmitEnabled !== true) {
        setSubmitAllowed(false);
        setResult("Submission is disabled. Keep the downloaded signed result; nothing was broadcast.");
        return;
      }
      // MARA refuses a rate below its floor, and a refused exact submission is never retried
      // automatically. The floor may have risen during the search, so check the signed rate now.
      try {
        const vsize = transactionVsize(signedReview.rawTxHex);
        await assertMinerFloor((BigInt(signedReview.manifest.fee) * 1000n) / BigInt(vsize));
      } catch (error) {
        submitAttempted.current = false;
        throw error;
      }
      assertCurrent();
      // The same wording as Activity's confirmation check for a conflicting spend.
      const conflict = "Funding outpoint was spent by a different transaction. Contact the operator; do not resubmit or spend the helper output.";
      try {
        const response = await api<{txid: string; status: string}>(`/jobs/${job.id}/submit`, {rawTxHex: signedReview.rawTxHex});
        assertCurrent();
        if (response.txid === signedReview.txid && response.status === "conflict") {
          onUpdated();
          throw Error(conflict);
        }
        if (response.txid !== signedReview.txid || !["submitted", "uncertain", "confirmed"].includes(response.status)) throw Error("Unexpected submission response.");
        setResult(`${response.status}: ${response.txid}. Keep the signed result and check Activity for chain confirmation. Do not submit another transaction.`);
        onUpdated();
      } catch (error) {
        assertCurrent();
        const message = error instanceof Error ? error.message : "Submission response unavailable.";
        setResult(message === conflict
          ? `${conflict} Keep the downloaded signed result.`
          : /disabled/i.test(message)
          ? "Submission is disabled. Keep the downloaded signed result; no submission was accepted by this route."
          : "Submission outcome is uncertain. Keep the downloaded signed result and reconcile it from Activity. Do not submit again.");
        throw error;
      }
    });
  }
  const deposit = vault.status === "unfunded";
  const fundingKey = `qsb-funding:${vault.id}`;
  function rememberFunding(next?: { txid: string; amount: string; rawTxHex?: string }) {
    setConfirmedRaw(undefined);
    setPendingFunding(next);
    if (next) localStorage.setItem(fundingKey, JSON.stringify(next));
    else localStorage.removeItem(fundingKey);
  }
  function readFundingGuard() {
    const saved = localStorage.getItem(fundingKey);
    if (saved === null) return undefined;
    try {
      const parsed = JSON.parse(saved) as { txid?: unknown; amount?: unknown; rawTxHex?: unknown };
      if (
        typeof parsed.txid === "string" &&
        (parsed.txid === "" || /^[a-f0-9]{64}$/i.test(parsed.txid)) &&
        typeof parsed.amount === "string" &&
        /^(0|[1-9][0-9]*)$/.test(parsed.amount) &&
        (parsed.rawTxHex === undefined ||
          (typeof parsed.rawTxHex === "string" && /^(?:[0-9a-f]{2})+$/i.test(parsed.rawTxHex)))
      )
        return {
          txid: parsed.txid,
          amount: parsed.amount,
          ...(typeof parsed.rawTxHex === "string" ? { rawTxHex: parsed.rawTxHex } : {}),
        };
    } catch { /* An unreadable guard must not permit another deposit. */ }
    return { txid: "", amount: "0" };
  }
  function refusePendingDeposit() {
    const saved = readFundingGuard();
    if (saved) {
      setPendingFunding(saved);
      throw Error("Another tab reported a deposit. Record or reconcile it before continuing; do not deposit again.");
    }
  }
  useEffect(() => {
    generation.current++;
    dialog.current?.showModal();
    setPendingFunding(readFundingGuard());
    if (!job && !deposit) {
      const active = generation.current;
      api<{solverReleaseId?: string | null}>("/config").then(config => {
        if (active === generation.current)
          setSolverId(typeof config.solverReleaseId === "string" ? config.solverReleaseId : null);
      }).catch(() => { if (active === generation.current) setSolverId(null); });
    }
    if (deposit && !job) {
      const active = generation.current;
      api<{ exactSubmitEnabled?: boolean }>("/config")
        .then((cfg) => { if (active === generation.current) setSubmissionOpen(operationsAllowed(cfg) && cfg.exactSubmitEnabled === true); })
        .catch(() => { if (active === generation.current) setSubmissionOpen(false); });
      const kept = readFundingGuard();
      if (kept?.rawTxHex) void confirmRecorded(kept.rawTxHex);
    }
    if (!job) {
      const active = generation.current;
      api<{ submit_fee_rate: number; market_rate?: number }>("/rates")
        .then((r) => { if (active === generation.current) setMinerFloor(minerMinimumRate(r)); })
        .catch(() => { if (active === generation.current) setMinerFloor(null); });
    }
    if (!job)
      api<{ utxos: Point[] }>("/payment-utxos")
        .then((x) => setPoints(x.utxos))
        .catch((e) => setError(e.message));
    return () => {
      generation.current++;
      lockQsb();
    };
  }, [fundingKey]);
  // Start from a rate MARA accepts: its current minimum for a deposit, and half as much again
  // for a withdrawal, whose search can take hours. Typing a rate replaces it. The rate is
  // rounded up the way belowMinerFloor rounds the floor.
  const suggestedRate = (() => {
    if (typeof minerFloor !== "number") return undefined;
    const milli = ceilMilliSatPerVb(minerFloor * (deposit ? 1 : 1.5));
    return milli > 0n ? formatFeeRate(milli) : undefined;
  })();
  useEffect(() => {
    if (!job && !feeTouched.current && suggestedRate !== undefined) setFeeRate(String(suggestedRate));
  }, [suggestedRate]);
  const key = (p: Point) => `${p.txid}:${p.vout}`;
  const manualReady = !!pendingFunding?.rawTxHex && confirmedRaw === pendingFunding.rawTxHex.toLowerCase();
  // MARA refuses a rate below its current minimum. It's re-read right before a fee is fixed,
  // and nothing proceeds without it.
  async function assertMinerFloor(milliSatPerVb: bigint) {
    let floor: number;
    try {
      floor = minerMinimumRate(await api<{ submit_fee_rate: number; market_rate?: number }>("/rates"));
    } catch {
      throw Error("MARA's fee quote is unavailable, so the rate can't be checked against its minimum. Nothing was submitted; try again shortly.");
    }
    setMinerFloor(floor);
    if (belowMinerFloor(milliSatPerVb, floor))
      throw Error(`The fee rate is below MARA's current minimum of ${floor} sat/vB. Nothing was submitted.`);
  }
  // Deposit fee from a sat/vB rate and the transaction's worst-case signed size.
  const depositQuote = (() => {
    if (!deposit || job) return undefined;
    const selected = points.filter((p) => selection.includes(key(p)));
    if (!selected.length || !amount.trim() || !feeRate.trim()) return undefined;
    try {
      return fundingFeeForRate(
        selected.map((p) => BigInt(p.value)),
        nestedPaymentAddress(wallet.address),
        vault.scriptHex.length / 2,
        parseBtc(amount),
        parseFeeRate(feeRate),
      );
    } catch (e) {
      return e instanceof Error ? e.message : "Unable to estimate the miner fee.";
    }
  })();
  // Withdrawal fee from a sat/vB rate and the upper-bound size of the signed QSB spend.
  // A saved intent already fixed its fee, so reopening it reuses that fee.
  const savedIntentFee = (() => {
    if (deposit || !unlocked?.authorization) return undefined;
    try {
      return BigInt(withdrawalSchema.parse(JSON.parse(unlocked.authorization.manifestJson)).fee);
    } catch {
      return undefined;
    }
  })();
  const withdrawalQuote = (() => {
    if (deposit || job) return undefined;
    if (savedIntentFee !== undefined) return { fee: savedIntentFee, vsize: 0, saved: true as const };
    if (!feeRate.trim()) return undefined;
    let script: Uint8Array;
    try {
      script = outputScript(destination);
    } catch {
      return "Enter a valid destination address to see the miner fee.";
    }
    try {
      return withdrawalFeeForRate(nestedPaymentAddress(wallet.address), script.length, parseFeeRate(feeRate));
    } catch (e) {
      return e instanceof Error ? e.message : "Unable to estimate the miner fee.";
    }
  })();
  const feeQuote = deposit ? depositQuote : withdrawalQuote;
  async function act(label: string, fn: (check: () => void) => Promise<void>) {
    const active = generation.current;
    const check = () => {
      if (generation.current !== active)
        throw Error("Wallet session changed. Reopen the transaction.");
    };
    setBusy(label);
    setError("");
    try {
      await fn(check);
    } catch (e) {
      if(generation.current===active)setError(e instanceof Error ? e.message : "Transaction failed.");
    } finally {
      if(generation.current===active)setBusy("");
    }
  }
  async function restore() {
    await act("Checking recovery backup", async (check) => {
      const r = await decryptRecovery(file, pass);
      if (
        r.vault.id !== vault.id ||
        r.vault.scriptHash !== vault.scriptHash ||
        (await validateRecovery(r.stateJson)) !== vault.scriptHash
      )
        throw Error("This backup belongs to a different vault.");
      check();
      setUnlocked(r);
      setAssemblyVerified(!!r.authorization?.assembly);
      setStage(job || (deposit && pendingFunding) ? "review" : "details");
    });
  }
  async function input(p: Point): Promise<FundingInput> {
    const data = await api<{ previousTxHex: string }>("/payment-input", p);
    return {
      ...p,
      value: BigInt(p.value),
      ...data,
      publicKey: wallet.publicKey,
      address: wallet.address,
    };
  }
  async function assertOperations() {
    if (!operationsAllowed(await api("/config")))
      throw Error("Transactions are disabled or the server network changed. Reopen the rehearsal after it is enabled.");
  }
  // Enable manual submission only once the server confirms it stores exactly these bytes.
  async function confirmRecorded(rawTxHex: string): Promise<boolean> {
    const active = generation.current;
    let held = false;
    try {
      const r = await api<{ rawTxHex?: string }>(`/vaults/${vault.id}/fund/signed`);
      held = r.rawTxHex?.toLowerCase() === rawTxHex.toLowerCase();
    } catch { /* Unknown means not confirmed. */ }
    if (active === generation.current) setConfirmedRaw(held ? rawTxHex.toLowerCase() : undefined);
    return held && active === generation.current;
  }
  // Copy only after re-checking: a still-running server request may have cleared the intent.
  async function copyRecorded(rawTxHex: string) {
    if (!(await confirmRecorded(rawTxHex))) {
      setError("The app no longer has this signed deposit recorded, so don't submit it manually. Press \"Submit deposit again\" first.");
      return;
    }
    await navigator.clipboard?.writeText(rawTxHex).then(
      () => setCopyNotice("Copied the signed deposit."),
      () => setError("Couldn't copy. Select the text and copy it yourself."),
    );
  }
  async function submitDeposit(rawTxHex: string, txid: string, amountSats: string) {
    let result: { vault: PublicVault; submission: "submitted" | "uncertain" | "rejected"; reason?: string };
    try {
      result = await api(`/vaults/${vault.id}/fund/submit`, { rawTxHex, amount: amountSats, costAccepted: true });
    } catch (error) {
      setPendingFunding(readFundingGuard());
      // The server may or may not have recorded the intent before failing; ask it.
      void confirmRecorded(rawTxHex);
      const detail = error instanceof Error ? ` ${error.message}` : "";
      throw Error(`The deposit is signed, but its submission to MARA isn't confirmed. Don't deposit again; use "Submit deposit again".${detail}`);
    }
    if (result.submission === "rejected") {
      rememberFunding(undefined);
      setPendingFunding(undefined);
      throw Error(`MARA refused the deposit: ${result.reason ?? "no reason given"}. Nothing was sent to the network.`);
    }
    if (result.submission === "uncertain") {
      setPendingFunding(readFundingGuard());
      void confirmRecorded(rawTxHex);
      throw Error(`MARA's response to the deposit ${txid.slice(0, 12)}… was lost. Don't deposit again; use "Submit deposit again", which resends the same transaction.`);
    }
    rememberFunding(undefined);
    setPendingFunding(undefined);
    setResult(
      `Deposit submitted to MARA Slipstream: ${txid}. Wait for confirmation before withdrawing.`,
    );
    onUpdated();
  }
  async function recordFunding(txid: string, amountSats: string) {
    const recorded = await api<{ vault: PublicVault }>(
      `/vaults/${vault.id}/fund`,
      { txid, amount: amountSats, costAccepted: true },
    );
    rememberFunding(undefined);
    setResult(
      `Deposit ${recorded.vault.status}: ${recorded.vault.funding?.txid}. Wait for confirmation before withdrawing.`,
    );
    onUpdated();
  }
  async function depositFunds() {
    await act(
      pendingFunding
        ? pendingFunding.rawTxHex
          ? "Submitting the signed deposit to MARA Slipstream"
          : "Recording the deposit"
        : "Review and sign the deposit in Xverse",
      async (check) => {
        if (!unlocked || !accepted)
          throw Error("Verify your backup and accept the costs first.");
        await assertOperations();
        check();
        if (pendingFunding) {
          // A signed deposit whose submission is unknown: resend exactly those bytes.
          if (pendingFunding.rawTxHex) {
            await submitDeposit(pendingFunding.rawTxHex, pendingFunding.txid, pendingFunding.amount);
            return;
          }
          if (!pendingFunding.txid) throw Error("Xverse reported a broadcast without a valid txid. Reconcile it in your wallet before continuing; do not deposit again.");
          await recordFunding(pendingFunding.txid, pendingFunding.amount);
          return;
        }
        // Deposits are submitted to MARA Slipstream; don't ask Xverse to sign one that can't be.
        const submission = await api<{ exactSubmitEnabled?: boolean }>("/config");
        check();
        if (submission.exactSubmitEnabled !== true)
          throw Error("Deposits are submitted to MARA Slipstream, which is switched off right now. Nothing was signed.");
        const selected = points.filter((p) => selection.includes(key(p)));
        if (!selected.length || selected.length > 8)
          throw Error("Select between one and eight payment outputs.");
        const inputs = await Promise.all(selected.map(input));
        const amountSats = parseBtc(amount),
          rate = parseFeeRate(feeRate);
        await assertMinerFloor(rate);
        check();
        const quote = fundingFeeForRate(
            inputs.map((i) => i.value),
            nestedPaymentAddress(wallet.address),
            vault.scriptHex.length / 2,
            amountSats,
            rate,
          ),
          feeSats = quote.fee;
        const expected = fundingPsbt(
          inputs,
          vault.scriptHex,
          amountSats,
          feeSats,
          wallet.address,
        );
        if (expected.outputsLength !== (quote.change ? 2 : 1))
          throw Error("The deposit fee estimate doesn't match the transaction. No transaction was submitted.");
        check();
        refusePendingDeposit();
        const latest = (await api<{ vaults: PublicVault[] }>("/vaults")).vaults.find(
          (item) => item.id === vault.id,
        );
        check();
        // A second tab may have broadcast while the server lookup was pending.
        refusePendingDeposit();
        if (!latest || latest.status !== "unfunded" || latest.funding)
          throw Error("This vault already has a deposit or is unavailable. Reopen it to refresh its funding state; do not deposit again.");
        // This preflight cannot serialize prompts approved simultaneously on two devices.
        // The deposit pays a bare QSB script, which public relay refuses as non-standard.
        // Xverse only signs; the server submits the exact bytes to MARA Slipstream.
        const returned = await signPsbt(
          wallet.address,
          base64.encode(expected.toPSBT()),
          inputs.map((_, i) => i),
        );
        check();
        const signed = verifySignedPsbt(expected, base64.decode(returned));
        for (let i = 0; i < signed.inputsLength; i++) {
          const input = signed.getInput(i);
          if (!input.finalScriptWitness?.length && !input.finalScriptSig?.length) signed.finalizeIdx(i);
        }
        const rawTxHex = signed.hex;
        // Keep the signed bytes before they leave the browser, so an unknown outcome can only be
        // retried with the same transaction and never becomes a second deposit.
        rememberFunding({ txid: signed.id, amount: amountSats.toString(), rawTxHex });
        await submitDeposit(rawTxHex, signed.id, amountSats.toString());
      },
    );
  }
  async function beginWithdrawal() {
    await act("Saving the withdrawal intent", async (check) => {
      await assertOperations();
      check();
      if (!unlocked || !accepted)
        throw Error("Verify your backup and accept the costs first.");
      const helper = points.find((p) => selection.includes(key(p)));
      if (!helper || selection.length !== 1)
        throw Error("Choose one helper payment output.");
      const confirmed = await api<{
        vault: PublicVault;
        status: { confirmed: boolean };
      }>(`/vaults/${vault.id}/funding`);
      if (!confirmed.status.confirmed || !confirmed.vault.funding)
        throw Error("Wait for the deposit to confirm.");
      const funding = confirmed.vault.funding,
        feeSats = await (async () => {
          const saved = unlocked.authorization
            ? withdrawalSchema.parse(JSON.parse(unlocked.authorization.manifestJson))
            : undefined;
          if (saved) {
            // The saved fee can't change. Refuse to start a paid search MARA wouldn't accept.
            const vsize = withdrawalVsize(nestedPaymentAddress(wallet.address), saved.outputScript.length / 2);
            await assertMinerFloor((BigInt(saved.fee) * 1000n) / BigInt(vsize));
            check();
            return BigInt(saved.fee);
          }
          const rate = parseFeeRate(feeRate);
          await assertMinerFloor(rate);
          check();
          return withdrawalFeeForRate(
            nestedPaymentAddress(wallet.address),
            outputScript(destination).length,
            rate,
          ).fee;
        })(),
        outputValue = BigInt(funding.value) + BigInt(helper.value) - feeSats;
      if (outputValue <= 0n)
        throw Error("The miner fee exceeds the available amount.");
      const previousIntent = unlocked.authorization
        ? withdrawalSchema.parse(
            JSON.parse(unlocked.authorization.manifestJson),
          )
        : undefined;
      const config = await api<{solverReleaseId?: string | null}>("/config");
      check();
      if (!config.solverReleaseId || config.solverReleaseId !== solverId)
        throw Error("The deployment solver is unavailable or changed. Reopen the withdrawal before saving an intent.");
      if (previousIntent && previousIntent.solverReleaseId !== config.solverReleaseId)
        throw Error("The saved intent uses a different solver. Keep its backup and contact the operator; do not create a new intent.");
      const selectedSolver = config.solverReleaseId;
      const manifest: Withdrawal = {
        vaultId: vault.id,
        funding,
        helper,
        destination,
        outputScript: hex.encode(outputScript(destination)),
        outputValue: outputValue.toString(),
        fee: feeSats.toString(),
        idempotencyKey: previousIntent?.idempotencyKey || crypto.randomUUID(),
        costAccepted: true,
        solverReleaseId: selectedSolver,
      };
      const manifestJson = JSON.stringify(withdrawalSchema.parse(manifest)),
        manifestHash = await digest(manifestJson),
        storageKey = `qsb-intent:${vault.scriptHash}`;
      const preserveBackup=async()=>{
      const remembered = localStorage.getItem(storageKey);
      await assertRecoveryAuthorization(unlocked, manifestHash);
      if (remembered && remembered !== manifestHash)
        throw Error(
          "A withdrawal intent already exists for this vault. Resume it from Activity; do not reuse its one-time keys.",
        );
      const backup = await encryptRecovery(
        {
          ...unlocked,
          authorization: {
            ...unlocked.authorization,
            manifestJson,
            manifestHash,
          },
        },
        pass,
      );
      // Save recovery before starting billable work. These public fields bind the
      // destination even after the tab or the original device is lost.
      check();
      localStorage.setItem(storageKey, manifestHash);
      setUnlocked({
        ...unlocked,
        authorization: {
          ...unlocked.authorization,
          manifestJson,
          manifestHash,
        },
      });
      setIntentBackup(backup);
      downloadBackup(backup, `${vault.id}-withdrawal`);
      };
      await preserveBackup();
      check();
      const r = await api<{job:Job}>('/jobs',manifest);
      check();

      setResult(
        `Search ${r.job.id} created. Keep the updated withdrawal backup; you will need it to authorize the result.`,
      );
      onUpdated();
    });
  }
  async function authorize() {
    await act(
      "Assembling locally, then signing the helper in Xverse",
      async (check) => {
        if (!job?.solution || !unlocked?.authorization || !accepted)
          throw Error(
            "Restore the updated withdrawal backup and approve the payout first.",
          );
        const intent = unlocked.authorization;
        if (
          (await digest(intent.manifestJson)) !== intent.manifestHash ||
          (await digest(JSON.stringify(canonicalManifest(job.manifest)))) !==
            intent.manifestHash ||
          job.manifestHash !== intent.manifestHash
        )
          throw Error(
            "The job differs from the withdrawal intent in your backup.",
          );
        const old = localStorage.getItem(`qsb-intent:${vault.scriptHash}`);
        if (old && old !== intent.manifestHash)
          throw Error("This device remembers a different authorization.");
        check();
        localStorage.setItem(
          `qsb-intent:${vault.scriptHash}`,
          intent.manifestHash,
        );
        const { previousTxHex } = await api<{ previousTxHex: string }>(
          `/vaults/${vault.id}/funding`,
        );
        const helper = await input(job.manifest.helper);
        const local = solvedResult !== undefined ? await rebuildWithdrawalFromSolvedResult({
          solved: solvedResult,
          job,
          stateJson: unlocked.stateJson,
          helper,
          fundingPreviousTxHex: previousTxHex,
          vaultScriptHex: vault.scriptHex,
          assemble: assembleQsb,
        }) : undefined;
        const raw = local ? local.raw : await assembleQsb(
          unlocked.stateJson,
          job.manifest,
          job.solution,
        );
        if (!local) verifyWithdrawalCommitment(raw, job.manifest, job.solution);
        const solution = local ? local.solved.solution : job.solution;
        const bound = await bindRecoveryAssembly(unlocked, solution, raw);
        const assemblyKey = `qsb-assembly:${vault.scriptHash}`;
        const rememberedAssembly = localStorage.getItem(assemblyKey);
        if (
          rememberedAssembly &&
          rememberedAssembly !== bound.authorization!.assembly!.rawTxHash
        )
          throw Error(
            "This device already bound a different QSB solution. Restore the latest signing backup.",
          );
        check();
        localStorage.setItem(
          assemblyKey,
          bound.authorization!.assembly!.rawTxHash,
        );
        if (!assemblyVerified) {
          const backup = await encryptRecovery(bound, pass);
          check();
          setUnlocked(bound);
          setIntentBackup(backup);
          downloadBackup(backup, `${vault.id}-signing`);
          return;
        }
        await assertRecoveryAssembly(unlocked, solution, raw);
        const expected = local
          ? local.transaction
          : helperPsbt(raw, helper, previousTxHex, {
              value: job.manifest.funding.value,
              scriptHex: vault.scriptHex,
            });
        check();
        if (!local) await assertOperations();
      check();
      const returned = await signPsbt(
          wallet.address,
          base64.encode(expected.toPSBT()),
          [0],
        );
        check();
        if (local) {
          const published: CoordinatorSignedResult = signedCoordinatorResult(
            local.solved,
            expected,
            base64.decode(returned),
            wallet,
          );
          const publicText = JSON.stringify(published);
          setSignedDownload(publicText);
          downloadPublicResult(publicText, published.jobId);
          await reviewSigned(published.rawTxHex, published.txid, check);
          return;
        }
        const signed = verifySignedPsbt(expected, base64.decode(returned));
        signed.finalize();
        const rawTxHex = hex.encode(signed.extract());
        const publicText = JSON.stringify({jobId: job.id, txid: signed.id, rawTxHex});
        setSignedDownload(publicText);
        downloadPublicResult(publicText, job.id);
        await reviewSigned(rawTxHex, signed.id, check);
      },
    );
  }
  async function verifyAssemblyBackup(file: File | undefined) {
    if (!file || !unlocked?.authorization?.assembly) return;
    await act("Verifying the signing backup", async (check) => {
      if (file.size > 260000) throw Error("Recovery file is too large.");
      const r = await decryptRecovery(await file.text(), pass);
      if (
        r.vault.id !== vault.id ||
        r.stateJson !== unlocked.stateJson ||
        JSON.stringify(r.authorization) !==
          JSON.stringify(unlocked.authorization)
      )
        throw Error("Select the updated signing backup just downloaded.");
      check();
      setAssemblyVerified(true);
    });
  }
  const btc = (n: bigint | string) => `${formatBtc(n)} BTC`;
  const sats = (n: bigint) => `${n.toLocaleString()} sats (${btc(n)})`;
  const selected = points.filter((p) => selection.includes(key(p)));
  const payout = (() => {
    if (deposit || job || !vault.funding || !selected[0] || typeof withdrawalQuote !== "object") return undefined;
    try {
      return BigInt(vault.funding.value) + BigInt(selected[0].value) - withdrawalQuote.fee;
    } catch {
      return undefined;
    }
  })();
  // What the transaction moves, from the same quote the signing step recomputes.
  const summary = ((): [string, string][] | undefined => {
    try {
      if (job)
        return [
          ["Destination", job.manifest.destination],
          ["Payout", btc(job.manifest.outputValue)],
          ["Miner fee", btc(job.manifest.fee)],
        ];
      if (typeof feeQuote !== "object") return undefined;
      if (deposit) {
        const amountSats = parseBtc(amount);
        const change = selected.reduce((n, p) => n + BigInt(p.value), 0n) - amountSats - feeQuote.fee;
        return [
          ["Deposit to the vault", btc(amountSats)],
          ["Miner fee", sats(feeQuote.fee)],
          [
            "Change back to your wallet",
            "change" in feeQuote && feeQuote.change
              ? btc(change)
              : "None: it would be below the dust limit, so it goes to the fee",
          ],
          ["Leaves your wallet", btc(amountSats + feeQuote.fee)],
        ];
      }
      if (!vault.funding || !selected[0] || payout === undefined) return undefined;
      return [
        ["Vault balance", btc(vault.funding.value)],
        ["Helper output", `+ ${btc(selected[0].value)}`],
        ["Miner fee", `− ${sats(feeQuote.fee)}`],
        // The whole address: this is the last look before the search binds the payout to it.
        ["Destination", destination],
        ["You receive", payout > 0n ? btc(payout) : "Nothing: the fee is larger than the amount"],
      ];
    } catch {
      return undefined;
    }
  })();
  const summaryTable = summary && (
    <dl className="summary">
      {summary.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
  // Why "Review" is disabled, shown next to it.
  const detailsBlocker = deposit
    ? selection.length > 8
      ? "Choose at most eight payment outputs."
      : typeof depositQuote === "object"
      ? ""
      : depositQuote ?? "Select payment outputs, then enter an amount and a fee rate."
    : solverId === null
      ? "No solver is available on this server, so a withdrawal can't start."
      : solverId === undefined
        ? "Checking the server's solver…"
        : selection.length !== 1
          ? "Choose one helper output."
          : typeof withdrawalQuote !== "object"
            ? withdrawalQuote ?? "Enter a fee rate."
            : payout === undefined || payout <= 0n
              ? "The miner fee is larger than the amount."
              : "";
  const stages = job ? (["unlock", "review"] as const) : (["unlock", "details", "review"] as const);
  const stageIndex = (stages as readonly string[]).indexOf(stage) + 1;
  const stageName = {
    unlock: "Unlock your backup",
    details: deposit ? "Choose the amount" : "Choose where it goes",
    review: "Review",
  }[stage];
  const feeBtc = job
    ? formatBtc(job.manifest.fee)
    : typeof feeQuote === "object"
      ? formatBtc(feeQuote.fee)
      : undefined;
  const blocked = !!job && !!intentBackup && !assemblyVerified;
  const blocker = !accepted
    ? "Tick the box above to continue."
    : blocked
      ? "Select the signing backup you just saved to continue."
      : "";
  const errorLine = error && (
    <p role="alert" className="error-message">
      {error}
    </p>
  );
  const verifiedLine = (
    <p className="verified">
      <Check size={15} /> Recovery backup verified on this device.
    </p>
  );
  return (
    <dialog
      ref={dialog}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="dialog-content transaction-dialog">
        <button
          className="close"
          disabled={!!busy}
          onClick={onClose}
          aria-label="Close transaction"
        >
          <X size={20} />
        </button>
        <div className="eyebrow">
          {result
            ? signedReview
              ? "LAST STEP · APPROVE AND SUBMIT"
              : "RESULT"
            : `STEP ${stageIndex} OF ${stages.length} · ${stageName.toUpperCase()}`}
        </div>
        <h2>
          {job
            ? "Authorize withdrawal"
            : deposit
              ? "Deposit into vault"
              : "Prepare withdrawal"}
        </h2>
        <p className="dialog-vault">{vault.name}</p>
        <div className="steps">
          {stages.map((s, i) => (
            <span key={s} className={result || i < stageIndex ? "done" : ""} />
          ))}
        </div>
        {result ? (
          <>
            <p role="status" className="result-message">{result}</p>
            {signedReview && (
              <section aria-label="Exact transaction approval">
                <dl className="summary">
                  <div><dt>Transaction ID</dt><dd>{signedReview.txid}</dd></div>
                  <div><dt>Destination</dt><dd>{signedReview.manifest.destination}</dd></div>
                  <div><dt>Payout</dt><dd>{formatBtc(signedReview.manifest.outputValue)} BTC</dd></div>
                  <div><dt>Miner fee</dt><dd>{formatBtc(signedReview.manifest.fee)} BTC</dd></div>
                  <div>
                    <dt>Signed size</dt>
                    <dd>
                      {(() => {
                        try {
                          const vsize = transactionVsize(signedReview.rawTxHex);
                          return `${vsize.toLocaleString()} vB · about ${(Number(signedReview.manifest.fee) / vsize).toFixed(2)} sat/vB`;
                        } catch {
                          return "Unavailable";
                        }
                      })()}
                    </dd>
                  </div>
                </dl>
                <div className="dialog-actions">
                  <button className="secondary" disabled={!!busy} onClick={onClose}>Cancel submission</button>
                  {signedDownload && job && <button className="secondary" onClick={() => downloadPublicResult(signedDownload, job.id)}>Download signed result again</button>}
                  <button className="primary" disabled={!!busy || !submitAllowed || submitAttempted.current || signedReview.generation !== generation.current || signedReview.epoch !== readSessionEpoch()} onClick={approveSigned}>Approve exact transaction and submit</button>
                </div>
              </section>
            )}
            {intentBackup && (
              <button
                className="secondary"
                onClick={() =>
                  downloadBackup(intentBackup, `${vault.id}-${job ? "signing" : "withdrawal"}`)
                }
              >
                Download {job ? "signing" : "withdrawal"} backup again
              </button>
            )}
            {errorLine}
            {!signedReview && (
              <div className="dialog-actions">
                <button className="secondary" disabled={!!busy} onClick={onClose}>
                  Close
                </button>
                {!deposit && !job && (
                  <a className="primary" href="#/activity" onClick={onClose}>
                    Go to Activity
                  </a>
                )}
              </div>
            )}
          </>
        ) : stage === "unlock" || !unlocked ? (
          <>
            <p>
              Select this vault's recovery backup and enter its passphrase.
              It's checked on this device; neither the file nor the passphrase
              is uploaded.
            </p>
            <label>
              Recovery backup
              <input
                type="file"
                accept="application/json"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    if (f.size > 260000) {
                      setError("Recovery file is too large.");
                      return;
                    }
                    setFile(await f.text());
                  }
                }}
              />
            </label>
            <label>
              Backup passphrase
              <input
                type="password"
                autoComplete="off"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
              />
            </label>
            {errorLine}
            <div className="dialog-actions">
              <button
                className="primary"
                disabled={!!busy || !file || !pass}
                onClick={restore}
              >
                Verify backup locally
              </button>
            </div>
          </>
        ) : stage === "details" ? (
          <>
            {verifiedLine}
            <fieldset>
              <legend>
                {deposit
                  ? "Pay from (choose up to eight outputs)"
                  : "Helper output (choose one)"}
              </legend>
              {!deposit && (
                <p className="hint">
                  A small output from your wallet that the withdrawal also
                  spends. Its value is added to your payout.
                </p>
              )}
              {points.length === 0 && (
                <p>No confirmed payment outputs available.</p>
              )}
              {points.map((p) => (
                <label key={key(p)}>
                  <input
                    type={deposit ? "checkbox" : "radio"}
                    name="payment-output"
                    checked={selection.includes(key(p))}
                    onChange={(e) =>
                      setSelection(
                        deposit
                          ? e.target.checked
                            ? [...selection, key(p)]
                            : selection.filter((x) => x !== key(p))
                          : [key(p)],
                      )
                    }
                  />
                  <span>
                    {formatBtc(p.value)} BTC{" "}
                    <span className="muted">
                      · {p.txid.slice(0, 12)}…:{p.vout}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            {deposit ? (
              <label>
                Deposit amount (BTC)
                <input
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </label>
            ) : (
              <label>
                Withdrawal destination
                <input
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                />
              </label>
            )}
            {typeof feeQuote === "object" && "saved" in feeQuote ? (
              <p className="fee-estimate">
                Miner fee {feeQuote.fee.toLocaleString()} sats ({formatBtc(feeQuote.fee)} BTC), fixed by the saved intent.
              </p>
            ) : (
              <>
                <label>
                  Miner fee rate (sat/vB)
                  <input
                    inputMode="decimal"
                    aria-describedby="fee-estimate"
                    value={feeRate}
                    onChange={(e) => {
                      feeTouched.current = true;
                      setFeeRate(e.target.value);
                    }}
                  />
                </label>
                <p className="fee-estimate" id="fee-estimate">
                  {typeof feeQuote === "object"
                    ? `${deposit ? "Estimated size" : "Size at most"} ${feeQuote.vsize.toLocaleString()} vB · miner fee ${feeQuote.fee.toLocaleString()} sats (${formatBtc(feeQuote.fee)} BTC)` +
                      ("change" in feeQuote && !feeQuote.change
                        ? ` · no change output: the change would be below the dust limit, so the leftover goes to the fee, about ${(Number(feeQuote.fee) / feeQuote.vsize).toFixed(2)} sat/vB`
                        : "")
                    : feeQuote ??
                      (deposit
                        ? "Select payment outputs and enter an amount and a fee rate to see the miner fee."
                        : "Enter a fee rate to see the miner fee. It's fixed when you save the intent, before the search.")}
                </p>
                <p className="hint">
                  {minerFloor === null
                    ? "MARA's minimum rate is unavailable right now; nothing can be submitted until it is."
                    : minerFloor !== undefined
                      ? `MARA's current minimum: ${minerFloor} sat/vB.` +
                        (() => {
                          try {
                            return feeRate.trim() && belowMinerFloor(parseFeeRate(feeRate), minerFloor)
                              ? " This rate is below it."
                              : "";
                          } catch {
                            return "";
                          }
                        })() +
                        (deposit ? "" : " Leave a margin: the search can take hours before the withdrawal is submitted.")
                      : "Checking MARA's minimum rate…"}
                </p>
              </>
            )}
            {summaryTable}
            {errorLine}
            <div className="dialog-actions">
              <button
                className="primary"
                disabled={!!detailsBlocker}
                onClick={() => {
                  // The reviewed rate is final: a later change of MARA's minimum never rewrites it.
                  feeTouched.current = true;
                  setError("");
                  setStage("review");
                }}
              >
                {deposit ? "Review deposit" : "Review withdrawal"}
              </button>
            </div>
            {detailsBlocker && <p className="blocker">{detailsBlocker}</p>}
          </>
        ) : (
          <>
            {job && solvedResult !== undefined && (
              <p>
                The solved result is public. Xverse signs the helper on this
                device. The recovery backup stays in this browser. Signing does not
                broadcast; submission requires your separate approval.
              </p>
            )}
            {verifiedLine}
            {!(deposit && pendingFunding) && summaryTable}
            {deposit && pendingFunding && (
              <p role="status">
                {pendingFunding.rawTxHex
                  ? <>A signed deposit {pendingFunding.txid.slice(0, 12)}… is waiting for MARA Slipstream. Do not deposit again. Submit it again: it resends the same transaction, which can only confirm once.</>
                  : <>Xverse reported a broadcast {pendingFunding.txid ? pendingFunding.txid.slice(0, 12) + "…" : "without a valid txid"}. Do not deposit again. Record
                the deposit once it is visible on the network; withdrawal waits for confirmation.</>}
              </p>
            )}
            {deposit && pendingFunding?.rawTxHex && !(manualReady && submissionOpen) && (
              <p className="hint">
                Manual submission on MARA Slipstream becomes available once the app has recorded this signed deposit and
                deposits are switched on. Press "Submit deposit again" first.
              </p>
            )}
            {deposit && pendingFunding?.rawTxHex && manualReady && submissionOpen && (
              <details
                className="manual-slipstream"
                onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) void confirmRecorded(pendingFunding.rawTxHex!); }}
              >
                <summary>Submit it yourself on MARA Slipstream</summary>
                <p>
                  If the app can't reach MARA, paste this signed deposit into the "Transaction/Package Hex" field on{" "}
                  <a href="https://slipstream.mara.com/" target="_blank" rel="noreferrer">slipstream.mara.com</a> and submit it
                  there (that means accepting MARA's terms). It's the same deposit, so it can only confirm once: don't create
                  another. Afterwards, press "Submit deposit again" here so the app records it.
                </p>
                <textarea readOnly rows={4} aria-label="Signed deposit transaction (hex)" value={pendingFunding.rawTxHex} />
                <button type="button" className="secondary" onClick={() => void copyRecorded(pendingFunding.rawTxHex!)}>
                  Copy transaction
                </button>
                {copyNotice && <p className="hint">{copyNotice}</p>}
              </details>
            )}
            {!(deposit && pendingFunding) && (
              <div className="cost-summary">
                <p>
                  {!summary && <><strong>Miner fee: {feeBtc ? `${feeBtc} BTC` : "not set yet"}.</strong>{" "}</>}
                  GPU compute, service and processing fees aren't billed yet.
                </p>
                <details>
                  <summary>See itemized costs</summary>
                  <CostDisclosure feeBtc={feeBtc} job={job} />
                </details>
              </div>
            )}
            {deposit && !pendingFunding && (
              <div className="info-note compact warning">
                <AlertCircle size={17} />
                <p>
                  QSB is experimental: a research construction, not a
                  guarantee. Lost recovery material can mean permanently lost
                  Bitcoin, and there is no service-held recovery key.
                </p>
              </div>
            )}
            {!deposit && !job && (
              <p className="hint">
                Starting the search downloads{" "}
                <code>{recoveryBackupFilename(`${vault.id}-withdrawal`)}</code>.
                Keep it: you need it to authorize this withdrawal, and it
                includes everything in your earlier backup.
              </p>
            )}
            {job && !assemblyVerified && !intentBackup && (
              <p className="hint">
                Saving downloads{" "}
                <code>{recoveryBackupFilename(`${vault.id}-signing`)}</code>,
                which binds this exact solution. You then select that file here
                so it's checked before Xverse signs.
              </p>
            )}
            {blocked && (
              <div className="info-note">
                <div>
                  <p>
                    Select the file you just saved,{" "}
                    <code>{recoveryBackupFilename(`${vault.id}-signing`)}</code>,
                    to check it. Keep this newest backup: it includes everything
                    in the earlier ones.
                  </p>
                  <label>
                    Verify updated signing backup
                    <input
                      type="file"
                      accept="application/json"
                      disabled={!!busy}
                      onChange={(e) =>
                        verifyAssemblyBackup(e.target.files?.[0])
                      }
                    />
                  </label>
                  <button
                    className="text-button"
                    onClick={() =>
                      downloadBackup(intentBackup, `${vault.id}-signing`)
                    }
                  >
                    Download signing backup again
                  </button>
                </div>
              </div>
            )}
            <div className="consent">
              <ul>
                <li>
                  <strong>
                    Recovery keys are one-time; the payout cannot be changed
                    after authorization.
                  </strong>
                </li>
                <li>I have reviewed the itemized costs and experimental loss risk.</li>
                <li>
                  Customer compute billing is not enabled; this is not
                  authorization for unlimited charges.
                </li>
                <li>
                  I authorize the stated Bitcoin fee only when signing the
                  transaction in Xverse.
                </li>
                <li>A withdrawal may take a long time.</li>
              </ul>
              <label>
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(e) => setAccepted(e.target.checked)}
                />
                I have read these statements and accept them.
              </label>
            </div>
            {errorLine}
            <div className="dialog-actions">
              {!job && !(deposit && pendingFunding) && (
                <button
                  className="secondary"
                  disabled={!!busy}
                  onClick={() => {
                    setError("");
                    setAccepted(false);
                    setStage("details");
                  }}
                >
                  Back
                </button>
              )}
              <button
                className="primary"
                disabled={!!busy || !unlocked || !accepted || blocked}
                onClick={
                  job ? authorize : deposit ? depositFunds : beginWithdrawal
                }
              >
                {busy ||
                  (job
                    ? assemblyVerified
                      ? "Authorize and sign"
                      : "Save signing backup"
                    : deposit
                      ? pendingFunding
                        ? pendingFunding.rawTxHex
                          ? "Submit deposit again"
                          : "Record deposit"
                        : "Review deposit in Xverse"
                      : "Save backup and start search")}
              </button>
            </div>
            {blocker && !busy && <p className="blocker">{blocker}</p>}
          </>
        )}
      </div>
    </dialog>
  );
}
