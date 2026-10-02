# First mainnet withdrawal

The first end-to-end QSB run, #22: one small deposit into a new vault, then a withdrawal from that vault, both on Bitcoin mainnet. It ran on the earlier eu-west-1 stack, through the Step Functions coordinator, AWS Batch GPUs and the CPU verifier ([README](../README.md#how-a-withdrawal-runs)).

## On chain

Read from mempool.space on 30 September 2026, with the tip at block 969313.

| | Deposit | Withdrawal |
|---|---|---|
| Txid | [`1378dd5c26aa027b329e7a0645a4087e9cc9e0e619cf605135f76b5a27ad5750`](https://mempool.space/tx/1378dd5c26aa027b329e7a0645a4087e9cc9e0e619cf605135f76b5a27ad5750) | [`fb46f6092560cbf3b254a8125644e42db3a361b94a2b3bafee4454d84297d13a`](https://mempool.space/tx/fb46f6092560cbf3b254a8125644e42db3a361b94a2b3bafee4454d84297d13a) |
| Block | 969054 | 969183 |
| Block time | 2026-09-28 22:10 UTC | 2026-09-29 16:54 UTC |
| Mined by | MARA Pool | MARA Pool |
| Weight | 40,174 WU | 5,287 WU |
| Fee | 70,308 sats (about 7.0 sat/vB) | 9,366 sats (about 7.1 sat/vB) |

**The deposit** has two outputs:
- `:0`, 100,000 sats: the vault, a bare 9,923-byte QSB script with no address.
- `:1`, 1,449 sats: the helper output, P2WPKH at the owner's address.

**The withdrawal:**
- spends exactly those two outputs: the vault with a 1,169-byte scriptSig, and the helper with a two-item witness;
- has one output of 92,083 sats, to the owner's address;
- pays a fee of 100,000 + 1,449 − 92,083 = 9,366 sats.

The chain data shows:
- **The exact-spend shape** (#20): two inputs, the vault and its helper, and a single output.
- **One deposit per vault:** the vault script has been paid once (100,000 sats) and spent once, and nothing else was sent to it. The mempool.space script-hash lookup lists only these two transactions.
- **Where it was mined:** the app submits to MARA Slipstream, and MARA Pool mined both blocks.

## Kept in the private deployment record

These stay out of Git, like the other deployment settings and records (see the [README](../README.md)):
- the vault id, the withdrawal job id and the Batch job ids;
- the CPU verifier's result;
- the solver release and image digest the job pinned;
- the mainnet switch approvals and changes;
- the owner's authorization of the exact transaction, amount and fee.

## Not confirmed here

Both items are tracked under Open in [STATUS.md](STATUS.md#open).

- **Image pull by digest:** that Batch pulled the solver image by digest. It would come from this run's Batch job record.
- **Legal:** whether the redistribution approval covers the combined solver images; see the legal item in [STATUS.md](STATUS.md#open). It is still open and needs legal review.
