import { useEffect, useState } from "react";
import { api } from "./lib/api";
import type { Job } from "./lib/model";

export function CostDisclosure({ feeBtc, job }: { feeBtc?: string; job?: Job }) {
  return <section className="cost-disclosure" aria-label="Itemized costs">
    <h3>Know what you would pay</h3>
    <p><strong>Customer billing is not enabled.</strong> This app cannot collect a compute payment, enforce a customer spending limit, or issue a refund yet. Mainnet transactions remain gated.</p>
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

type Rates = { effective_rate: number; submit_fee_rate: number };
export default function Costs() {
  const [rates, setRates] = useState<Rates>();
  const [checked, setChecked] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [rate, setRate] = useState("");
  const [hours, setHours] = useState("");
  const [size, setSize] = useState("");
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
  const positive = (s: string) => s.trim() !== "" && Number.isFinite(Number(s)) && Number(s) > 0;
  const compute = positive(rate) && positive(hours) ? Number(rate) * Number(hours) : undefined;
  const miner = rates && positive(size) && Number.isSafeInteger(Number(size)) ? Math.ceil(Number(size) * rates.effective_rate) : undefined;
  return <div className="cost-page">
    <CostDisclosure />
    <section className="panel">
      <h2>How charging will work</h2>
      <ol>
        <li>Review an itemized quote with a compute range, fixed service fee, separate Bitcoin fees and any processing charges or tax.</li>
        <li>Authorize a maximum compute spend. Reserve the cost of running batches and shutdown before starting more work.</li>
        <li>Pay for attributable billable compute, including disclosed startup and idle overhead. Legitimate unsuccessful searches still consume paid compute.</li>
        <li>Pause before exceeding the authorization. Preserve search progress and request an explicit top-up; a paused search is not a completed withdrawal.</li>
        <li>Receive an itemized usage receipt and unused-credit refund. Costs caused by our bugs, duplicate submissions and development testing will be absorbed by us.</li>
      </ol>
      <div className="cost-planned"><h3>Spending protection · not available yet</h3>
        <label>Maximum compute spend (USD)<input disabled placeholder="Available when budget enforcement is connected" /></label>
        <button disabled className="secondary">Authorize compute budget — coming later</button>
        <p>Payment authorization, in-flight budget reservations, provider billing reconciliation and refunds are not connected. There is no active customer spending cap. This preview does not authorize unlimited charges.</p>
      </div>
    </section>
    <section className="panel">
      <h2>Explore costs · illustration only</h2>
      <p>These inputs do not start a search, set a spending limit or change a transaction. A GPU-hour means one GPU running for one hour; eight GPUs for one hour is eight GPU-hours.</p>
      <div className="cost-inputs">
        <label>Assumed provider rate (USD / GPU-hour)<input inputMode="decimal" value={rate} onChange={e => setRate(e.target.value)} placeholder="Enter a provider quote" /></label>
        <label>Total billable GPU-hours<input inputMode="decimal" value={hours} onChange={e => setHours(e.target.value)} placeholder="Include startup and idle time" /></label>
      </div>
      <p role="status">Illustrative compute subtotal: <strong>{compute !== undefined && Number.isFinite(compute) ? `$${compute.toFixed(2)}` : "Enter a positive rate and duration"}</strong>. Excludes other charges; duration is an assumption, not an ETA.</p>
      <h3>Bitcoin fee reference</h3>
      <button className="secondary" disabled={loading} onClick={() => void refresh()}>{loading ? "Checking MARA rates…" : "Refresh MARA rates"}</button>
      {error && <p role="alert">{error}</p>}
      {rates && <p>MARA effective rate: <strong>{rates.effective_rate} sat/vB</strong>. Submission floor: {rates.submit_fee_rate} sat/vB. Retrieved {checked}; this rate is not locked and can change immediately. Admission does not guarantee mining.</p>}
      <label>Assumed transaction virtual size (vB)<input inputMode="numeric" value={size} onChange={e => setSize(e.target.value)} placeholder="Not the locking-script size" /></label>
      <p role="status">Illustrative miner fee: <strong>{miner !== undefined && Number.isSafeInteger(miner) ? `${miner.toLocaleString()} sats` : "Requires a rate and a positive whole-number size"}</strong>. Calculate funding and withdrawal separately; verify the final signed transaction's weight.</p>
      <p>A fee change during search may require waiting or recomputing a newly authorized transaction. We will not silently change your payout or reuse one-time signing material.</p>
      <p><a href="https://docs.runpod.io/serverless/pricing" target="_blank" rel="noreferrer">Runpod billing rules</a> · <a href="https://slipstream.mara.com/docs/" target="_blank" rel="noreferrer">MARA documentation</a></p>
    </section>
  </div>;
}
