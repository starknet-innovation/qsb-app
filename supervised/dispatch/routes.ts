import { withCreationOutbox } from "./bridge";
import { createApp, type AuthenticatedJobPostRoutes } from "../../server/app";
import type { Store } from "../../server/store";
import { NETWORK_ID } from "../../src/lib/network";
import { fingerprint } from "../../src/lib/provenance";
import { outputScript } from "../../src/lib/transactions";
import { chain, type Esplora } from "../../server/chain";
import { createExplicitJob } from "../archive/work/yukon-mainnet-service-enrollment-20260923/dispatch";
import { capability } from "../archive/work/yukon-mainnet-service-enrollment-20260923/capability";
type Options = {
  enabled?: boolean;
  chain?: Pick<Esplora, "assertNetwork" | "unspent">;
};
/** Trusted server constructor only. This creates a queued job; it never dispatches work. */
export function installSupervisedCreation(
  routes: AuthenticatedJobPostRoutes,
  store: Store,
  options: Options = {},
) {
  const enabled = options.enabled === true,
    ledger = options.chain ?? chain;
  routes.post("/api/jobs/supervised", async (c) => {
    if (!enabled || NETWORK_ID !== "mainnet")
      return c.json({ error: "Supervised job creation is disabled." }, 503);
    try {
      const owner = c.get("owner");
      if (typeof owner !== "string" || !owner) throw Error("Owner absent");
      const cap = await capability(store);
      const guarded: Store = {
        get: store.get.bind(store),
        list: store.list.bind(store),
        put: async () => {
          throw Error("Unexpected single write");
        },
        delete: async () => {
          throw Error("Unexpected delete");
        },
        atomicPut: async (w) =>
          store.atomicPut([...w, { row: cap, expected: cap.version }]),
      };
      const result = await createExplicitJob(
        withCreationOutbox(guarded),
        owner,
        await c.req.json(),
        async (o, v, m) => {
          if (
            v.network !== "mainnet" ||
            !v.funding ||
            fingerprint(v.funding) !== fingerprint(m.funding) ||
            Buffer.from(outputScript(m.destination)).toString("hex") !==
              m.outputScript ||
            BigInt(m.outputValue) <= 0n ||
            BigInt(m.fee) <= 0n ||
            BigInt(m.funding.value) + BigInt(m.helper.value) !==
              BigInt(m.outputValue) + BigInt(m.fee)
          )
            throw Error("Public transaction differs");
          await ledger.assertNetwork();
          await ledger.unspent(m.funding, v.scriptHex);
          await ledger.unspent(
            m.helper,
            Buffer.from(outputScript(o)).toString("hex"),
          );
        },
      );
      if (fingerprint(await capability(store)) !== fingerprint(cap))
        throw Error("Capability changed");
      return c.json(
        { job: result.job, created: result.created, launched: false },
        result.created ? 201 : 200,
      );
    } catch {
      return c.json(
        { error: "Supervised request unavailable or changed." },
        409,
      );
    }
  });
}
export function createSupervisedCreationApp(
  store: Store,
  options: Options = {},
) {
  return createApp(store, {
    mainnetUi: { supervisedSearch: options.enabled === true },
    installAuthenticatedJobPostRoutes: (r) =>
      installSupervisedCreation(r, store, options),
  });
}
