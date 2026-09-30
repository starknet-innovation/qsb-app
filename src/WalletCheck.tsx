import { useEffect, useRef, useState } from "react";
import { base64 } from "@scure/base";
import { signPsbt, type Wallet } from "./lib/wallet";
import {
  walletCheckFixture,
  verifyWalletCheck,
  type WalletCheckKind,
} from "./lib/wallet-check";
import type { PublicVault } from "./lib/model";

const kinds: { kind: WalletCheckKind; label: string; passed: string }[] = [
  {
    kind: "funding",
    label: "Funding signature",
    passed: "Funding synthetic signing passed: valid signature, transaction unchanged.",
  },
  {
    kind: "helper",
    label: "Helper signature",
    passed: "Helper synthetic signing passed: valid signature, transaction unchanged.",
  },
  {
    kind: "full-stack",
    label: "Complete-stack signing",
    passed:
      "Complete-stack format check passed: Xverse signature verified and the full QSB-shaped payload preserved.",
  },
];
type Outcome = { kind: WalletCheckKind; ok: boolean; text: string };

export default function WalletCheck({
  wallet,
  vaults,
}: {
  wallet?: Wallet;
  vaults: PublicVault[];
}) {
  const [selected, setSelected] = useState(""),
    [running, setRunning] = useState<WalletCheckKind>(),
    [outcomes, setOutcomes] = useState<Outcome[]>([]),
    [accepted, setAccepted] = useState(false);
  const vault = vaults.find((v) => v.id === selected) || vaults[0];
  const busy = running !== undefined;
  // Each check is built from one vault's script, so another vault starts with no results.
  useEffect(() => setOutcomes([]), [vault?.id]);
  // Leaving the page, or disconnecting (which remounts this section), stops the checks.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const indexOf = (kind: WalletCheckKind) => kinds.findIndex((k) => k.kind === kind);
  // After a failure, the first later check that hasn't run yet, if any.
  const lastFailed = outcomes.filter((o) => !o.ok).at(-1);
  const resumeAt = lastFailed
    ? kinds.findIndex((k, i) => i > indexOf(lastFailed.kind) && !outcomes.some((o) => o.kind === k.kind))
    : -1;
  // Runs the synthetic signing requests in order from `from`, and stops at the first that
  // fails so a declined request isn't followed by two more. The rest can then be continued.
  async function run(from = 0) {
    if (!wallet || !vault || !accepted) return;
    setOutcomes((o) => o.filter((x) => indexOf(x.kind) < from));
    try {
      for (const { kind, passed } of kinds.slice(from)) {
        if (!mounted.current) return;
        setRunning(kind);
        try {
          const fixture = walletCheckFixture(wallet, vault.scriptHex, kind);
          const returned = await signPsbt(
            wallet.address,
            base64.encode(fixture.transaction.toPSBT()),
            [0],
          );
          verifyWalletCheck(fixture, base64.decode(returned), wallet);
          if (!mounted.current) return;
          setOutcomes((o) => [...o, { kind, ok: true, text: passed }]);
        } catch (e) {
          if (!mounted.current) return;
          setOutcomes((o) => [
            ...o,
            {
              kind,
              ok: false,
              text: `Check did not pass: ${e instanceof Error ? e.message : "Wallet request failed"}. A wallet may reject synthetic inputs; this alone does not prove real transactions are unsupported.`,
            },
          ]);
          return;
        }
      }
    } finally {
      if (mounted.current) setRunning(undefined);
    }
  }
  return (
    <section
      className="panel protocol-caveat"
      aria-labelledby="wallet-check-title"
    >
      <h2 id="wallet-check-title">Wallet compatibility check</h2>
      <p>
        Checks that Xverse can sign the kinds of transaction a QSB vault uses.
        Xverse asks you to sign three synthetic transactions with example
        amounts. They use no real Bitcoin, can't be mined, and nothing is
        broadcast; the signatures are discarded after checking.
      </p>
      <p>
        Passing doesn't prove that a solved withdrawal is valid or will be
        accepted: real withdrawal signing remains unverified.
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
              onClick={() => void run()}
            >
              Run wallet check
            </button>
            {!busy && resumeAt >= 0 && (
              <button
                className="secondary"
                disabled={!accepted}
                onClick={() => void run(resumeAt)}
              >
                Continue with the remaining checks
              </button>
            )}
          </div>
        </>
      )}
      {(busy || outcomes.length > 0) && (
        <ul className="wallet-check-results" role="status">
          {kinds.map(({ kind, label }) => {
            const outcome = outcomes.find((o) => o.kind === kind);
            return (
              <li key={kind} className={outcome ? (outcome.ok ? "ok" : "bad") : ""}>
                <strong>{label}</strong>
                <span>
                  {outcome
                    ? outcome.text
                    : running === kind
                      ? "Waiting for Xverse…"
                      : busy
                        ? "Waiting"
                        : "Not run"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
