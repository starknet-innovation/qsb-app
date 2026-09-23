import { useState } from "react";
import { base64 } from "@scure/base";
import { signPsbt, type Wallet } from "./lib/wallet";
import {
  walletCheckFixture,
  verifyWalletCheck,
  type WalletCheckKind,
} from "./lib/wallet-check";
import type { PublicVault } from "./lib/model";

export default function WalletCheck({
  wallet,
  vaults,
}: {
  wallet?: Wallet;
  vaults: PublicVault[];
}) {
  const [selected, setSelected] = useState(""),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState(""),
    [accepted, setAccepted] = useState(false);
  const vault = vaults.find((v) => v.id === selected) || vaults[0];
  async function run(kind: WalletCheckKind) {
    if (!wallet || !vault || !accepted) return;
    setBusy(true);
    setResult("");
    try {
      const fixture = walletCheckFixture(wallet, vault.scriptHex, kind);
      const returned = await signPsbt(
        wallet.address,
        base64.encode(fixture.transaction.toPSBT()),
        [0],
      );
      verifyWalletCheck(fixture, base64.decode(returned), wallet);
      setResult(
        kind === "full-stack"
          ? "Complete-stack format check passed: Xverse signature verified and the full QSB-shaped payload preserved. The payload is disposable, not a solved authorization. Real withdrawal signing remains unverified."
          : `${kind === "funding" ? "Funding" : "Helper"} synthetic signing passed: valid signature, transaction unchanged. This does not verify a real deposit or withdrawal.`,
      );
    } catch (e) {
      setResult(
        `Check did not pass: ${e instanceof Error ? e.message : "Wallet request failed"}. A wallet may reject synthetic inputs; this alone does not prove real transactions are unsupported.`,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="panel protocol-caveat"
      aria-labelledby="wallet-check-title"
    >
      <h2 id="wallet-check-title">Wallet compatibility check</h2>
      <p>
        These synthetic transactions use no real Bitcoin. Their parent
        transaction cannot be mined, and broadcasting is disabled. Signing
        results stay in this browser and are discarded after checking.
      </p>
      <p>
        Xverse will show example amounts and fees. This checks a bare QSB
        funding output and a helper signature with placeholder authorization.
        Full withdrawal validation is separate.
      </p>
      <p>
        The complete-stack check includes every Config A stack field using
        disposable data. It tests whether Xverse preserves the larger payload
        before we pay for a fresh proof bound to your wallet. It cannot prove
        that a solved withdrawal is valid or will be accepted.
      </p>
      {!wallet || !vault ? (
        <p>Connect Xverse and create an unfunded vault first.</p>
      ) : (
        <>
          <label>
            Vault for the public script
            <select
              value={vault.id}
              disabled={busy}
              onChange={(e) => setSelected(e.target.value)}
            >
              {vaults.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={accepted}
              disabled={busy}
              onChange={(e) => setAccepted(e.target.checked)}
            />
            I understand these are synthetic signing requests and no transaction
            will be broadcast.
          </label>
          <div className="wallet-check-actions">
            <button
              className="secondary"
              disabled={busy || !accepted}
              onClick={() => run("funding")}
            >
              Check funding signature
            </button>
            <button
              className="secondary"
              disabled={busy || !accepted}
              onClick={() => run("helper")}
            >
              Check helper signature
            </button>
            <button
              className="secondary"
              disabled={busy || !accepted}
              onClick={() => run("full-stack")}
            >
              Check complete-stack signing
            </button>
          </div>
        </>
      )}
      {busy && <p role="status">Waiting for Xverse…</p>}
      {result && <p role="status">{result}</p>}
    </section>
  );
}
