import { useEffect, useRef, useState } from "react";
import { base64, hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { signPsbt, type Wallet } from "./lib/wallet";
import { downloadOfflineFile } from "./lib/offline-fixture";
import {
  prepareOfflineSigning,
  unlockVerifiedOfflineSigning,
  validateOfflineSigningBundle,
  type OfflineSigningBundle,
} from "./lib/offline-signing";
import { verifyWithdrawalCommitment } from "./lib/transactions";
import { lockQsb } from "./lib/qsb";
import { finalizeVerifiedOfflineHelper } from "./lib/offline-signed-result";
const digest = (s: string) => hex.encode(sha256(new TextEncoder().encode(s)));
function remember(key: string, value: string) {
  const previous = localStorage.getItem(key);
  if (previous && previous !== value)
    throw Error(
      "This device already bound a different authorization. Restore its latest signing backup.",
    );
  localStorage.setItem(key, value);
}
export default function OfflineSigning({ wallet }: { wallet?: Wallet }) {
  const [bundle, setBundle] = useState<OfflineSigningBundle>(),
    [backup, setBackup] = useState<File>(),
    [pass, setPass] = useState(""),
    [sealed, setSealed] = useState(""),
    [downloaded, setDownloaded] = useState(false),
    [reimport, setReimport] = useState<File>(),
    [accepted, setAccepted] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [signedResult, setSignedResult] = useState("");
  const identity = JSON.stringify(wallet),
    live = useRef(identity),
    revision = useRef(0);
  live.current = identity;
  useEffect(() => {
    revision.current++;
    setBundle(undefined);
    setBackup(undefined);
    setPass("");
    setSealed("");
    setDownloaded(false);
    setReimport(undefined);
    setAccepted(false);
    setBusy(false);
    setMessage("");
    setSignedResult("");
    return () => {
      revision.current++;
      lockQsb();
    };
  }, [identity]);
  async function act(fn: (check: () => void) => Promise<void>) {
    if (busy) return;
    const rev = revision.current,
      id = identity;
    const check = () => {
      if (revision.current !== rev || live.current !== id)
        throw Error(
          "Wallet changed. Reconnect and restore the signing backup.",
        );
    };
    setBusy(true);
    setMessage("");
    try {
      await fn(check);
    } catch (e) {
      if (revision.current === rev) setMessage((e as Error).message);
    } finally {
      if (revision.current === rev) {
        lockQsb();
        setBusy(false);
      }
    }
  }
  async function load(file?: File) {
    if (!file || !wallet) return;
    await act(async (check) => {
      if (file.size > 2200000) throw Error("Bundle is too large.");
      const parsed = validateOfflineSigningBundle(
        JSON.parse(await file.text()),
        wallet,
      );
      check();
      setBundle(parsed);
      setBackup(undefined);
      setPass("");
      setSealed("");
      setDownloaded(false);
      setReimport(undefined);
      setAccepted(false);
      setSignedResult("");
      setMessage(
        "Public bundle validated. Restore the matching private backup locally.",
      );
    });
  }
  async function prepare() {
    if (!wallet || !bundle || !backup || !accepted) return;
    await act(async (check) => {
      if (backup.size > 260000) throw Error("Backup is too large.");
      const manifestHash = digest(JSON.stringify(bundle.fixture.manifest)),
        key = bundle.request.vault.scriptHash;
      check();
      remember(`qsb-intent:${key}`, manifestHash);
      const prepared = await prepareOfflineSigning(
        bundle,
        wallet,
        await backup.text(),
        pass,
      );
      check();
      remember(`qsb-assembly:${key}`, prepared.rawTxHash);
      setSealed(prepared.encryptedSigningBackup);
      setBackup(undefined);
      setPass("");
      setDownloaded(false);
      setReimport(undefined);
      setMessage(
        "Authorization assembled locally. Download the new private signing backup and reimport it before requesting Xverse signing.",
      );
    });
  }
  async function sign() {
    if (!wallet || !bundle || !sealed || !reimport || !downloaded || !accepted)
      return;
    await act(async (check) => {
      if (reimport.size > 260000) throw Error("Backup is too large.");
      const key = bundle.request.vault.scriptHash;
      remember(
        `qsb-intent:${key}`,
        digest(JSON.stringify(bundle.fixture.manifest)),
      );
      const ready = await unlockVerifiedOfflineSigning(
        bundle,
        wallet,
        await reimport.text(),
        sealed,
        pass,
      );
      check();
      const expected = ready.transaction;
      remember(
        `qsb-assembly:${key}`,
        hex.encode(sha256(expected.toBytes(true, true))),
      );
      setPass("");
      const returned = await signPsbt(
        wallet.address,
        base64.encode(expected.toPSBT()),
        [0],
      );
      check();
      const { rawTxHex, txid } = finalizeVerifiedOfflineHelper(
        expected,
        base64.decode(returned),
        wallet,
      );
      verifyWithdrawalCommitment(
        rawTxHex,
        bundle.fixture.manifest,
        bundle.solution,
      );
      check();
      setSignedResult(
        JSON.stringify(
          {
            format: "qsb-offline-signed-result-v1",
            fixtureChain: "regtest",
            requestId: bundle.request.id,
            scriptHash: key,
            manifestHash: digest(JSON.stringify(bundle.fixture.manifest)),
            rawTxHex,
            txid,
            helperSignatureVerified: true,
            broadcast: false,
          },
          null,
          2,
        ),
      );
      setSealed("");
      setReimport(undefined);
      setMessage(
        "Xverse signature verified and the QSB authorization preserved. Export the signed result for offline Bitcoin Core verification. Nothing was broadcast; consensus acceptance remains unverified.",
      );
    });
  }
  return (
    <div>
      <h3>Sign a solved offline fixture</h3>
      <p>
        Only use the operator’s solved regtest bundle for this disposable vault.
        This step reveals its one-time authorization to Xverse and in the
        exported result. It does not broadcast a transaction. The bundle’s
        regtest label alone does not prove chain inclusion.
      </p>
      <label>
        Public solved bundle
        <input
          type="file"
          accept=".json"
          disabled={!wallet || busy}
          onChange={(e) => {
            void load(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </label>
      {bundle && (
        <>
          <p>
            Fixture {bundle.request.id}. Two test inputs: 100,000 and 10,000
            sats. Returns 90,000 test sats to {bundle.request.wallet.address};
            fee: 20,000 test sats.
          </p>
          <label>
            <input
              type="checkbox"
              checked={accepted}
              disabled={busy}
              onChange={(e) => setAccepted(e.target.checked)}
            />
            I authorize this disposable offline test only and understand its
            one-time keys cannot be reused.
          </label>
          {!sealed && !signedResult && (
            <>
              <label>
                Matching private backup
                <input
                  type="file"
                  accept=".json"
                  disabled={busy}
                  onChange={(e) => setBackup(e.target.files?.[0])}
                />
              </label>
              <label>
                Private signing passphrase
                <input
                  type="password"
                  value={pass}
                  autoComplete="off"
                  disabled={busy}
                  onChange={(e) => setPass(e.target.value)}
                />
              </label>
              <button
                disabled={busy || !backup || !pass || !accepted}
                onClick={() => void prepare()}
              >
                Prepare private signing backup
              </button>
            </>
          )}
          {sealed && (
            <>
              <button
                disabled={busy}
                onClick={() => {
                  downloadOfflineFile(
                    sealed,
                    `qsb-offline-private-signing-backup-${bundle.request.id}.json`,
                  );
                  setDownloaded(true);
                }}
              >
                Download private signing backup
              </button>
              {downloaded && (
                <>
                  <label>
                    Reimport private signing backup
                    <input
                      type="file"
                      accept=".json"
                      disabled={busy}
                      onChange={(e) => setReimport(e.target.files?.[0])}
                    />
                  </label>
                  <label>
                    Signing backup passphrase
                    <input
                      type="password"
                      autoComplete="off"
                      disabled={busy}
                      value={pass}
                      onChange={(e) => setPass(e.target.value)}
                    />
                  </label>
                  <button
                    disabled={busy || !reimport || !pass || !accepted}
                    onClick={() => void sign()}
                  >
                    Sign offline fixture in Xverse — no broadcast
                  </button>
                </>
              )}
            </>
          )}
          {signedResult && (
            <button
              onClick={() =>
                downloadOfflineFile(
                  signedResult,
                  `qsb-offline-signed-result-${bundle.request.id}.json`,
                )
              }
            >
              Download signed public result
            </button>
          )}
        </>
      )}
      <p role="status">{message}</p>
    </div>
  );
}
