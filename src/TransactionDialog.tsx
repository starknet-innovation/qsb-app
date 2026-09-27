import {fingerprint} from './lib/provenance';
import {readSessionEpoch} from './lib/api';
import {prepareMainnetSearchRequest,retainedMainnetSubmission} from './mainnet/submission';
import {retainedRequests} from './mainnet/retainedRequest';
import {supervisedSearchClient,type SupervisedSearch} from './mainnet/submissionClient';
import { operationsAllowed } from "./lib/readiness";
import { useEffect, useRef, useState } from "react";
import "./styles.css";
import { CostDisclosure } from "./Costs";
import { base64, hex } from "@scure/base";
import { api } from "./lib/api";
import { fundFromXverse, signPsbt, type Wallet } from "./lib/wallet";
import {
  fundingFeeForRate,
  fundingPsbt,
  helperPsbt,
  belowMinerFloor,
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
  supervisedSearch,
}: {
  vault: PublicVault;
  wallet: Wallet;
  job?: Job;
  solvedResult?: unknown;
  onClose: () => void;
  onUpdated: () => void;
  supervisedSearch?: SupervisedSearch;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const generation = useRef(0);
  const submission = useRef<ReturnType<typeof retainedMainnetSubmission>|undefined>(undefined);
  const lifetimeKey=fingerprint({vault,wallet,job:job?.id,supervisedSearch,solved:solvedResult??null});
  const lifetime=useRef(lifetimeKey);
  if(lifetime.current!==lifetimeKey){lifetime.current=lifetimeKey;generation.current++;}

  const [points, setPoints] = useState<Point[]>([]),
    [selection, setSelection] = useState<string[]>([]),
    [amount, setAmount] = useState(""),
    [feeRate, setFeeRate] = useState(""),
    // MARA's submission floor in sat/vB: undefined while loading, null if unavailable.
    [minerFloor, setMinerFloor] = useState<number | null>(),
    [destination, setDestination] = useState(wallet.address),
    [solverId, setSolverId] = useState<string | null>(null),
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
    }>();
  const [signedReview, setSignedReview] = useState<{rawTxHex: string; txid: string; manifest: Withdrawal; generation: number; epoch: number}>();
  const [signedDownload, setSignedDownload] = useState<string>();
  const [submitAllowed, setSubmitAllowed] = useState(false);
  const submitAttempted = useRef(false);
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
      try {
        const response = await api<{txid: string; status: string}>(`/jobs/${job.id}/submit`, {rawTxHex: signedReview.rawTxHex});
        assertCurrent();
        if (response.txid !== signedReview.txid || !["submitted", "uncertain", "confirmed"].includes(response.status)) throw Error("Unexpected submission response.");
        setResult(`${response.status}: ${response.txid}. Keep the signed result and check Activity for chain confirmation. Do not submit another transaction.`);
        onUpdated();
      } catch (error) {
        assertCurrent();
        const message = error instanceof Error ? error.message : "Submission response unavailable.";
        setResult(/disabled/i.test(message)
          ? "Submission is disabled. Keep the downloaded signed result; no submission was accepted by this route."
          : "Submission outcome is uncertain. Keep the downloaded signed result and reconcile it from Activity. Do not submit again.");
        throw error;
      }
    });
  }
  const deposit = vault.status === "unfunded";
  const fundingKey = `qsb-funding:${vault.id}`;
  function rememberFunding(next?: { txid: string; amount: string }) {
    setPendingFunding(next);
    if (next) localStorage.setItem(fundingKey, JSON.stringify(next));
    else localStorage.removeItem(fundingKey);
  }
  function readFundingGuard() {
    const saved = localStorage.getItem(fundingKey);
    if (saved === null) return undefined;
    try {
      const parsed = JSON.parse(saved) as { txid?: unknown; amount?: unknown };
      if (
        typeof parsed.txid === "string" &&
        (parsed.txid === "" || /^[a-f0-9]{64}$/i.test(parsed.txid)) &&
        typeof parsed.amount === "string" &&
        /^(0|[1-9][0-9]*)$/.test(parsed.amount)
      ) return { txid: parsed.txid, amount: parsed.amount };
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
    if (!job && !supervisedSearch && !deposit) {
      const active = generation.current;
      api<{solverReleaseId?: string | null}>("/config").then(config => {
        if (active === generation.current)
          setSolverId(typeof config.solverReleaseId === "string" ? config.solverReleaseId : null);
      }).catch(() => { if (active === generation.current) setSolverId(null); });
    }
    if (!job) {
      const active = generation.current;
      api<{ submit_fee_rate: number }>("/rates")
        .then((r) => { if (active === generation.current) setMinerFloor(Number.isFinite(r.submit_fee_rate) ? r.submit_fee_rate : null); })
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
  const key = (p: Point) => `${p.txid}:${p.vout}`;
  // MARA refuses a rate below its submission floor. The floor is re-read right before a
  // fee is fixed, and nothing proceeds without it.
  async function assertMinerFloor(milliSatPerVb: bigint) {
    let floor: number;
    try {
      floor = (await api<{ submit_fee_rate: number }>("/rates")).submit_fee_rate;
    } catch {
      throw Error("MARA's fee quote is unavailable, so the rate can't be checked against its submission floor. Nothing was submitted; try again shortly.");
    }
    setMinerFloor(floor);
    if (belowMinerFloor(milliSatPerVb, floor))
      throw Error(`The fee rate is below MARA's current submission floor of ${floor} sat/vB. Nothing was submitted.`);
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
      if (generation.current !== active || (supervisedSearch && readSessionEpoch()!==supervisedSearch.sessionEpoch))
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
    if(supervisedSearch){setError("Supervised search cannot deposit or broadcast.");return;}
    await act(
      pendingFunding
        ? "Recording the deposit"
        : "Review and sign the deposit in Xverse",
      async (check) => {
        if (!unlocked || !accepted)
          throw Error("Verify your backup and accept the costs first.");
        await assertOperations();
        check();
        if (pendingFunding) {
          if (!pendingFunding.txid) throw Error("Xverse reported a broadcast without a valid txid. Reconcile it in your wallet before continuing; do not deposit again.");
          await recordFunding(pendingFunding.txid, pendingFunding.amount);
          return;
        }
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
        let broadcastReported = false;
        try {
          const funded = await fundFromXverse(
            wallet.address,
            base64.encode(expected.toPSBT()),
            inputs.map((_, i) => i),
            (txid) => {
              broadcastReported = true;
              rememberFunding({ txid: txid ?? "", amount: amountSats.toString() });
            },
          );
          check();
          const signed = verifySignedPsbt(expected, base64.decode(funded.psbt));
          for (let i = 0; i < signed.inputsLength; i++) {
            const input = signed.getInput(i);
            if (!input.finalScriptWitness?.length && !input.finalScriptSig?.length) signed.finalizeIdx(i);
          }
          if (signed.id !== funded.txid.toLowerCase())
            throw Error("Xverse reported a different funding transaction.");
          const broadcast = {
            txid: signed.id,
            amount: amountSats.toString(),
          };
          await recordFunding(broadcast.txid, broadcast.amount);
        } catch (error) {
          if (!broadcastReported) throw error;
          const detail = error instanceof Error ? error.message.replace(" No transaction was submitted.", "") : "Verification or recording failed.";
          throw Error(`Deposit sent, not verified or recorded. Do not deposit again. ${detail}`);
        }
      },
    );
  }
  async function beginWithdrawal() {
    await act("Saving the withdrawal intent", async (check) => {
      if(supervisedSearch&&(deposit||job||vault.network!=='mainnet'||!vault.funding))throw Error('Supervised creation requires a confirmed mainnet vault and no existing job.');
      const supervisedClient=supervisedSearch?supervisedSearchClient(supervisedSearch):undefined;
      if(supervisedClient)await supervisedClient.assertAllowed();else await assertOperations();
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
          // The parked supervised handoff doesn't submit through MARA from here; keep /rates out of it.
          if (saved) {
            // The saved fee can't change. Refuse to start a paid search MARA wouldn't accept.
            if (!supervisedSearch) {
              const vsize = withdrawalVsize(nestedPaymentAddress(wallet.address), saved.outputScript.length / 2);
              await assertMinerFloor((BigInt(saved.fee) * 1000n) / BigInt(vsize));
              check();
            }
            return BigInt(saved.fee);
          }
          const rate = parseFeeRate(feeRate);
          if (!supervisedSearch) {
            await assertMinerFloor(rate);
            check();
          }
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
      let selectedSolver = previousIntent?.solverReleaseId;
      if (!supervisedSearch) {
        const config = await api<{solverReleaseId?: string | null}>("/config");
        check();
        if (!config.solverReleaseId || config.solverReleaseId !== solverId)
          throw Error("The deployment solver is unavailable or changed. Reopen the withdrawal before saving an intent.");
        if (previousIntent && previousIntent.solverReleaseId !== config.solverReleaseId)
          throw Error("The saved intent uses a different solver. Keep its backup and contact the operator; do not create a new intent.");
        selectedSolver = config.solverReleaseId;
      }
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
        ...(!supervisedSearch && selectedSolver ? { solverReleaseId: selectedSolver } : {}),
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
      if(supervisedClient&&localStorage.getItem(storageKey)!==manifestHash)throw Error('One-time intent was not retained.');
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
      if(supervisedClient){if(!navigator.locks)throw Error('Browser request locking is unavailable.');await navigator.locks.request('qsb-mainnet-assembly:'+vault.scriptHash,{mode:'exclusive'},async()=>{check();supervisedClient.assertCurrent();await preserveBackup();});}else await preserveBackup();
      check();
      let r:{job:Job};
      if(supervisedClient&&supervisedSearch){
        const prepared=prepareMainnetSearchRequest({owner:wallet.address,vault:confirmed.vault,manifest,wallet,releaseId:supervisedSearch.releaseId});
        if(submission.current&&fingerprint(submission.current.request)!==prepared.requestHash)throw Error('The original supervised request must be reconciled before a new search.');
        if(!submission.current)submission.current=retainedMainnetSubmission(prepared,retainedRequests(localStorage,navigator.locks),()=>{try{check();supervisedClient.assertCurrent();return true;}catch{return false;}},supervisedClient.submit);
        r=await submission.current.submit() as {job:Job};
      }else r=await api<{job:Job}>('/jobs',manifest);
      check();

      setResult(
        `Search ${r.job.id} created. Keep the updated withdrawal backup; you will need it to authorize the result.`,
      );
      onUpdated();
    });
  }
  async function authorize() {
    if(supervisedSearch){setError("Use the separately verified recovery flow for this search.");return;}
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
          (await digest(JSON.stringify(job.manifest))) !==
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
          : helperPsbt(raw, helper, previousTxHex);
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
  const payoutPreview = (() => {
    if (deposit || job || !vault.funding) return undefined;
    try {
      const helper = points.find((p) => selection.includes(key(p)));
      if (!helper) return undefined;
      if (typeof withdrawalQuote !== "object") return undefined;
      const value =
        BigInt(vault.funding.value) + BigInt(helper.value) - withdrawalQuote.fee;
      return value > 0n ? formatBtc(value.toString()) : undefined;
    } catch {
      return undefined;
    }
  })();
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
          className="close-dialog"
          disabled={!!busy}
          onClick={onClose}
          aria-label="Close transaction"
        >
          ×
        </button>
        <h2>
          {job
            ? "Authorize withdrawal"
            : deposit
              ? "Deposit into vault"
              : "Prepare withdrawal"}
        </h2>
        <p>{vault.name}</p>
        {job && solvedResult !== undefined && (
          <p>
            The solved result is public. Xverse signs the helper on this
            device. The recovery backup stays in this browser. Signing does not
            broadcast; submission requires your separate approval.
          </p>
        )}
        {result ? (
          <>
            <p role="status">{result}</p>
            {signedReview && <section aria-label="Exact transaction approval">
              <p>Transaction ID: {signedReview.txid}<br />
                Destination: {signedReview.manifest.destination}<br />
                Payout: {formatBtc(signedReview.manifest.outputValue)} BTC<br />
                Miner fee: {formatBtc(signedReview.manifest.fee)} BTC<br />
                {(() => {
                  try {
                    const vsize = transactionVsize(signedReview.rawTxHex);
                    return `Signed size: ${vsize.toLocaleString()} vB · about ${(Number(signedReview.manifest.fee) / vsize).toFixed(2)} sat/vB`;
                  } catch {
                    return "Signed size unavailable.";
                  }
                })()}</p>
              {signedDownload && job && <button className="secondary" onClick={() => downloadPublicResult(signedDownload, job.id)}>Download signed result again</button>}
              <button disabled={!!busy || !submitAllowed || submitAttempted.current || signedReview.generation !== generation.current || signedReview.epoch !== readSessionEpoch()} onClick={approveSigned}>Approve exact transaction and submit</button>
              <button className="secondary" disabled={!!busy} onClick={onClose}>Cancel submission</button>
            </section>}

            {intentBackup && (
              <button
                className="secondary"
                onClick={() =>
                  downloadBackup(intentBackup, `${vault.id}-withdrawal`)
                }
              >
                Download withdrawal backup again
              </button>
            )}
          </>
        ) : (
          <>
            {!unlocked ? (
              <>
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
                <button
                  className="secondary"
                  disabled={!!busy || !file || !pass}
                  onClick={restore}
                >
                  Verify backup locally
                </button>
              </>
            ) : (
              <p>Recovery backup verified on this device.</p>
            )}
            {job ? (
              <div className="info-note">
                <p>
                  Destination: {job.manifest.destination}
                  <br />
                  Payout: {formatBtc(job.manifest.outputValue)} BTC
                  <br />
                  Miner fee: {formatBtc(job.manifest.fee)} BTC
                </p>
              </div>
            ) : (
              <>
                <fieldset>
                  <legend>
                    {deposit
                      ? "Payment outputs (choose up to eight)"
                      : "Helper output (choose one)"}
                  </legend>
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
                      {formatBtc(p.value)} BTC · {p.txid.slice(0, 12)}…:{p.vout}
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
                {!deposit && !supervisedSearch && (
                  <label>
                    Solver release
                    <input value={solverId || "No runnable solver is configured"} readOnly />
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
                        onChange={(e) => setFeeRate(e.target.value)}
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
                      {minerFloor === null
                        ? " MARA's submission floor is unavailable right now; nothing can be submitted until it is."
                        : minerFloor !== undefined
                          ? ` MARA's current submission floor: ${minerFloor} sat/vB.` +
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
                          : ""}
                    </p>
                  </>
                )}
              </>
            )}
            {deposit && pendingFunding && (
              <p role="status">
                Xverse reported a broadcast {pendingFunding.txid ? pendingFunding.txid.slice(0, 12) + "…" : "without a valid txid"}. Do not deposit again. Record
                the deposit once it is visible on the network; withdrawal waits for confirmation.
              </p>
            )}
            <CostDisclosure
              feeBtc={
                job
                  ? formatBtc(job.manifest.fee)
                  : typeof feeQuote === "object"
                    ? formatBtc(feeQuote.fee)
                    : undefined
              }
              job={job}
            />
            {payoutPreview && (
              <p role="status">
                Payout: {payoutPreview} BTC to {destination}. The selected
                helper output is included in this amount.
              </p>
            )}
            {job && intentBackup && !assemblyVerified && (
              <div className="info-note">
                <div>
                  <p>
                    Your signing backup binds the exact QSB solution. Keep this
                    newest file and re-upload it before sending authorization to
                    Xverse.
                  </p>
                  <button
                    className="secondary"
                    onClick={() =>
                      downloadBackup(intentBackup, `${vault.id}-signing`)
                    }
                  >
                    Download signing backup again
                  </button>
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
                </div>
              </div>
            )}
            <label>
              <input
                type="checkbox"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
              />
              I have reviewed the itemized costs and experimental loss risk. Customer compute billing is not enabled; this is not authorization for unlimited charges. I authorize the stated Bitcoin fee only when signing the transaction in Xverse. A withdrawal may take a long time.
              Recovery keys are one-time; the payout cannot be changed after
              authorization.
            </label>
            <button
              className="primary"
              disabled={
                !!busy ||
                !unlocked ||
                !accepted ||
                (!!job && !!intentBackup && !assemblyVerified)
              }
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
                      ? "Record deposit"
                      : "Review deposit in Xverse"
                    : "Save intent and start search")}
            </button>
          </>
        )}
        {error && (
          <p role="alert" className="error-message">
            {error}
          </p>
        )}
      </div>
    </dialog>
  );
}
