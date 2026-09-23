import { vaultConfiguration } from "./lib/provenance";
import OfflineSigning from "./OfflineSigning";
import { useEffect, useRef, useState } from "react";
import type { Wallet } from "./lib/wallet";
import { generateQsb, lockQsb } from "./lib/qsb";
import { encryptRecovery } from "./lib/backup";
import { NETWORK_ID } from "./lib/network";
import {
  createOfflineRequest,
  validatedOfflineWallet,
  verifyOfflineBackup,
  downloadOfflineFile,
  type OfflineRequest,
} from "./lib/offline-fixture";

export default function OfflineFixture({ wallet }: { wallet?: Wallet }) {
  const [accepted, setAccepted] = useState(false);
  const [pass, setPass] = useState(""),
    [confirm, setConfirm] = useState("");
  const [request, setRequest] = useState<OfflineRequest>(),
    [encrypted, setEncrypted] = useState("");
  const [downloaded, setDownloaded] = useState(false),
    [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false),
    [result, setResult] = useState("");
  const identity = JSON.stringify(wallet),
    currentIdentity = useRef(identity),
    revision = useRef(0);
  currentIdentity.current = identity;
  useEffect(() => {
    revision.current++;
    lockQsb();
    setRequest(undefined);
    setEncrypted("");
    setPass("");
    setConfirm("");
    setDownloaded(false);
    setVerified(false);
    setBusy(false);
    setResult("");
    setAccepted(false);
    return () => {
      revision.current++;
      lockQsb();
    };
  }, [identity]);
  async function generate() {
    if (!wallet || !accepted) return;
    const activeIdentity = identity,
      generation = revision.current;
    const unchanged = () => {
      if (
        currentIdentity.current !== activeIdentity ||
        generation !== revision.current
      )
        throw new Error("Wallet changed; start a new offline fixture.");
    };
    setBusy(true);
    setResult("Generating disposable keys in this browser…");
    setVerified(false);
    setDownloaded(false);
    setRequest(undefined);
    setEncrypted("");
    try {
      validatedOfflineWallet(wallet);
      if (pass.length < 14 || pass !== confirm)
        throw new Error(
          "Enter matching backup passphrases of at least 14 characters.",
        );
      const generated = await generateQsb();
      unchanged();
      const vault = {
        id: crypto.randomUUID(),
        name: "Offline signing test — never fund",
        createdAt: new Date().toISOString(),
        network: NETWORK_ID,
        config: "A" as const,
        scriptHex: generated.scriptHex,
        scriptHash: generated.scriptHash,
        publicStateJson: generated.publicStateJson,
        paymentAddress: wallet.address,
        status: "unfunded" as const,
      };
      const pinnedVault = {
        ...vault,
        configuration: vaultConfiguration(vault),
      };
      const publicRequest = createOfflineRequest(wallet, pinnedVault);
      const backup = await encryptRecovery(
        {
          format: "qsb-recovery-v1",
          vault: pinnedVault,
          stateJson: generated.stateJson,
        },
        pass,
      );
      unchanged();
      generated.stateJson = "";
      lockQsb();
      setEncrypted(backup);
      setRequest(publicRequest);
      setPass("");
      setConfirm("");
      setResult(
        "Download the private backup, then select that file and re-enter its passphrase to verify it locally.",
      );
    } catch (e) {
      if (generation === revision.current) setResult((e as Error).message);
    } finally {
      lockQsb();
      if (generation === revision.current) setBusy(false);
    }
  }
  async function verify(file?: File) {
    if (!file || !request || !downloaded) return;
    const activeIdentity = identity,
      generation = revision.current;
    setBusy(true);
    setVerified(false);
    try {
      if (file.size > 260000) throw new Error("Backup file is too large.");
      await verifyOfflineBackup(await file.text(), encrypted, pass, request);
      if (
        currentIdentity.current !== activeIdentity ||
        revision.current !== generation
      )
        throw new Error("Wallet changed; start again.");
      setVerified(true);
      setPass("");
      setEncrypted("");
      setResult(
        "Private backup verified. Download and share only the public request with the operator. No signing or GPU search has started.",
      );
    } catch (e) {
      if (generation === revision.current) setResult((e as Error).message);
    } finally {
      if (generation === revision.current) setBusy(false);
    }
  }
  return (
    <section
      className="panel protocol-caveat"
      aria-labelledby="offline-fixture-title"
    >
      <h2 id="offline-fixture-title">
        Prepare the definitive offline signing test
      </h2>
      <p>
        This creates a new disposable vault for an isolated Bitcoin Core regtest
        fixture. Your connected mainnet address identifies the signing key only.
        Never fund this vault. No wallet signature, transaction broadcast, or
        GPU search happens in this step.
      </p>
      <p>
        Your recovery keys stay in this browser and your encrypted private
        backup. Only public commitments and your wallet public key are included
        in the separate public request.
      </p>
      {!wallet && <p>Connect Xverse to prepare the fixture.</p>}
      {!request && (
        <>
          <label>
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
              disabled={busy}
            />
            I understand this is a disposable offline test vault and will never
            fund it.
          </label>
          <label>
            Private backup passphrase
            <input
              type="password"
              autoComplete="new-password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              disabled={busy}
            />
          </label>
          <label>
            Confirm passphrase
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={busy}
            />
          </label>
          <button
            disabled={!wallet || !accepted || busy}
            onClick={() => void generate()}
          >
            Generate offline fixture
          </button>
        </>
      )}
      {request && !verified && (
        <>
          <button
            disabled={busy}
            onClick={() => {
              downloadOfflineFile(
                encrypted,
                `qsb-offline-private-backup-${request.id}.json`,
              );
              setDownloaded(true);
            }}
          >
            Download private backup — keep it private
          </button>
          {downloaded && (
            <>
              <label>
                Backup passphrase
                <input
                  type="password"
                  autoComplete="off"
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                  disabled={busy}
                />
              </label>
              <label>
                Reimport the downloaded private backup
                <input
                  type="file"
                  accept=".json"
                  disabled={busy || !pass}
                  onChange={(e) => {
                    void verify(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </label>
            </>
          )}
        </>
      )}
      {request && verified && (
        <button
          onClick={() =>
            downloadOfflineFile(
              JSON.stringify(
                createOfflineRequest(wallet!, request.vault),
                null,
                2,
              ),
              `qsb-offline-public-request-${request.id}.json`,
            )
          }
        >
          Download public request — share this file only
        </button>
      )}
      <p role="status">{result}</p>
      <OfflineSigning key={identity} wallet={wallet} />
    </section>
  );
}
