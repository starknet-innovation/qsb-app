import type { QsbMethod } from "./qsb-runtime";
type Run = (method: QsbMethod, args?: string[]) => Promise<string>;
/** Typed bridge calls over a runtime: this browser worker, or the Node SDK's loader. */
export function qsbOperations(run: Run) {
  return {
    async generateQsb() {
      return JSON.parse(await run("generate")) as {
        stateJson: string;
        publicStateJson: string;
        scriptHex: string;
        scriptHash: string;
      };
    },
    validateRecovery: (stateJson: string) => run("validate", [stateJson]),
    assembleQsb: (state: string, manifest: unknown, solution: unknown) =>
      run("assemble", [
        state,
        JSON.stringify(manifest),
        JSON.stringify(solution),
      ]),
  };
}

/**
 * What `prepareAssembly` returns. `transaction` is T in hex: the spending transaction in legacy
 * serialization with every scriptSig empty and no witness. `round0` and `round1` are the indices of
 * the 8 and 7 HORS secrets the solution discloses, in the order the pipeline signs with them (it sorts
 * each subset): keep that order, never reorder them. The other fields are what `finishAssembly`
 * needs to assemble the same transaction again. `manifest` is the caller's input passed through, shape
 * checked only: assembly pays its `outputScript` and never checks `destination` or `fee`. A key manager
 * shows and approves what it derives from `transaction` and the verified previous outputs, never the
 * manifest's values.
 */
export type PreparedAssembly = {
  transaction: string;
  round0: number[];
  round1: number[];
  scriptHash: string;
  publicStateJson: string;
  manifest: unknown;
  solution: unknown;
};

/**
 * Typed calls for HORS secrets that a key manager outside the runtime holds (the BIP draft "QSB
 * Wallet Secret Management"). The runtime gets the 2 × 150 commitments, and at `finishAssembly`
 * only the 15 preimages that `prepareAssembly` named; it never gets the secret set.
 */
export function commitmentOperations(run: Run) {
  return {
    /** The public part of `generateQsb` for secrets whose HASH160s are `commitments`, in setup's order. */
    async setupFromCommitments(commitments: string[][]) {
      return JSON.parse(
        await run("setup_from_commitments", [JSON.stringify(commitments)]),
      ) as { publicStateJson: string; scriptHex: string; scriptHash: string };
    },
    /** The transaction and indices to record before releasing any preimage; holds no secret. */
    async prepareAssembly(
      publicStateJson: string,
      manifest: unknown,
      solution: unknown,
    ) {
      return JSON.parse(
        await run("prepare", [
          publicStateJson,
          JSON.stringify(manifest),
          JSON.stringify(solution),
        ]),
      ) as PreparedAssembly;
    },
    /**
     * What `assembleQsb` returns for the same vault, manifest and solution, given the `preimages`
     * of round0's and then round1's indices, in their order. Refused unless each matches its commitment.
     */
    finishAssembly: (prepared: PreparedAssembly, preimages: string[]) =>
      run("finish", [JSON.stringify(prepared), JSON.stringify(preimages)]),
  };
}
