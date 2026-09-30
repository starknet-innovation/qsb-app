import { useEffect, useState } from "react";
import { api } from "./lib/api";
import { minerMinimumRate } from "./lib/transactions";
import type { Job } from "./lib/model";

export function CostDisclosure({ feeBtc, job }: { feeBtc?: string; job?: Job }) {
  return <section className="cost-disclosure" aria-label="Itemized costs">
    <h3>Know what you would pay</h3>
    <p><strong>Customer billing is not enabled.</strong> This app cannot collect a compute payment, enforce a customer spending limit, or issue a refund yet.</p>
    <dl className="cost-lines">
      <div><dt>Bitcoin miner fee</dt><dd>{feeBtc ? `${feeBtc} BTC · transaction amount, not a paid receipt` : "Not specified"}</dd></div>
      <div><dt>GPU search</dt><dd>Final cost unknown · no fixed-price quote</dd></div>
      <div><dt>Service fee (AWS, support and margin)</dt><dd>Not configured · not included in an estimate</dd></div>
      <div><dt>Separate MARA charge</dt><dd>Not confirmed · miner fees must not be counted twice</dd></div>
      <div><dt>Payment processing / applicable tax</dt><dd>Not configured</dd></div>
      <div><dt>Total payable</dt><dd>Unavailable until all charges are quoted</dd></div>
    </dl>
    {job && <p>Recorded execution: {job.computeSeconds.toLocaleString()} GPU-seconds. This excludes some billable overhead and is <strong>not an invoice</strong>. No reconciled usage receipt is available.</p>}
    <p>Funding and withdrawal each have a Bitcoin fee. Compute payment will be separate from your vault. Your deposit amount is not a service charge.</p>
    <p>Before funding: withdrawal compute may cost more than a small deposit. Today's estimate cannot guarantee the cost of a future withdrawal.</p>
  </section>;
}

type Rates = { effective_rate: number; submit_fee_rate: number; market_rate?: number };
export default function Costs() {
  const [rates, setRates] = useState<Rates>();
  const [checked, setChecked] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function refresh() {
    setLoading(true); setError(""); setRates(undefined); setChecked("");
    try {
      const r = await api<Rates>("/rates");
      if (![r.effective_rate, r.submit_fee_rate].every(v => Number.isFinite(v) && v >= 0)) throw Error();
      setRates(r); setChecked(new Date().toLocaleString());
    } catch { setError("MARA rates unavailable. No fee quote can be calculated."); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  return <div className="cost-page">
    <CostDisclosure />
    <section className="panel">
      <h2>Bitcoin fees today</h2>
      <p>The deposit and withdrawal dialogs work out each transaction's miner fee from its size and the rate you choose. These are MARA's current rates.</p>
      {error && <p role="alert">{error}</p>}
      {rates && <p>MARA effective rate: <strong>{rates.effective_rate} sat/vB</strong>. Minimum accepted now: {minerMinimumRate(rates)} sat/vB. Retrieved {checked}; this rate is not locked and can change immediately. Admission does not guarantee mining.</p>}
      <button className="secondary" disabled={loading} onClick={() => void refresh()}>{loading ? "Checking MARA rates…" : "Refresh MARA rates"}</button>
      <p>A fee change during search may require waiting or recomputing a newly authorized transaction. We will not silently change your payout or reuse one-time signing material.</p>
      <p><a href="https://slipstream.mara.com/docs/" target="_blank" rel="noreferrer">MARA documentation</a></p>
    </section>
    <section className="panel">
      <h2>How charging will work</h2>
      <ol>
        <li>Review an itemized quote with a compute range, fixed service fee, separate Bitcoin fees and any processing charges or tax.</li>
        <li>Authorize a maximum compute spend. Reserve the cost of running batches and shutdown before starting more work.</li>
        <li>Pay for attributable billable compute, including disclosed startup and idle overhead. Legitimate unsuccessful searches still consume paid compute.</li>
        <li>Pause before exceeding the authorization. Preserve search progress and request an explicit top-up; a paused search is not a completed withdrawal.</li>
        <li>Receive an itemized usage receipt and unused-credit refund. Costs caused by our bugs, duplicate submissions and development testing will be absorbed by us.</li>
      </ol>
      <p>None of this is connected yet: there is no payment authorization and no customer spending cap, and nothing here authorizes unlimited charges.</p>
    </section>
  </div>;
}
