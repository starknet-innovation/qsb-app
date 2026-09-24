import { createHash } from "node:crypto";
import type { Store, Row } from "../../server/store";
import { fingerprint } from "../../src/lib/provenance";
import { dispatchExplicitJob } from "../archive/entry";
import type { Launcher } from "../archive/work/yukon-mainnet-service-enrollment-20260923/dispatch";
export const OUTBOX = "OUTBOX#QSB_DISPATCH";
export type Ticket = {
  format: "qsb-dispatch-ticket-v1";
  owner: string;
  jobId: string;
  jobHash: string;
};
export const ticketId = (t: Ticket) =>
  createHash("sha256").update(JSON.stringify(t)).digest("hex");
export function parseTicket(raw: string): Ticket {
  if (Buffer.byteLength(raw) > 4096)
    throw Error("Dispatch ticket exceeds limit");
  const t = JSON.parse(raw);
  if (
    !t ||
    Object.keys(t).sort().join(",") !== "format,jobHash,jobId,owner" ||
    t.format !== "qsb-dispatch-ticket-v1" ||
    typeof t.owner !== "string" ||
    !t.owner ||
    t.owner.length > 256 ||
    typeof t.jobId !== "string" ||
    !t.jobId ||
    t.jobId.length > 128 ||
    !/^([a-f0-9]{64})$/.test(t.jobHash)
  )
    throw Error("Invalid dispatch ticket");
  return {
    format: t.format,
    owner: t.owner,
    jobId: t.jobId,
    jobHash: t.jobHash,
  };
}
/** Creation and its outgoing notification are one transaction. No second write after HTTP response. */
export function withCreationOutbox(store: Store): Store {
  return {
    get: store.get.bind(store),
    list: store.list.bind(store),
    reservationRows: store.reservationRows.bind(store),
    put: store.put.bind(store),
    delete: store.delete.bind(store),
    atomicPut: async (writes) => {
      const outgoing = writes
        .filter((w) => w.expected === undefined && w.row.sk.startsWith("JOB#"))
        .map((w) => {
          const j = w.row.job as any;
          if (
            j?.status !== "queued" ||
            j.revision !== 0 ||
            w.row.pk !== "OWNER#" + j.owner ||
            w.row.sk !== "JOB#" + j.id
          )
            throw Error("Unexpected job creation");
          const ticket = parseTicket(
            JSON.stringify({
              format: "qsb-dispatch-ticket-v1",
              owner: j.owner,
              jobId: j.id,
              jobHash: fingerprint(j),
            }),
          );
          return {
            row: {
              pk: OUTBOX,
              sk: "PENDING#" + ticketId(ticket),
              version: 0,
              ticket,
            },
          };
        });
      await store.atomicPut([...writes, ...outgoing]);
    },
  };
}
/** Send may be repeated after an uncertain SQS acknowledgement. It never directly submits GPU work. */
export async function publishPending(
  store: Store,
  send: (ticket: Ticket, id: string) => Promise<void>,
  limit = 100,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw Error("Invalid batch limit");
  let published = 0;
  for (const row of await store.list(OUTBOX, "PENDING#")) {
    if (published >= limit) break;
    const t = parseTicket(JSON.stringify(row.ticket)),
      id = ticketId(t);
    if (row.sk !== "PENDING#" + id || row.version !== 0)
      throw Error("Outbox binding changed");
    const enrollment = await store.get(
      "OWNER#" + t.owner,
      "DISPATCH_CONFIG#" + t.jobId,
    );
    if (
      !enrollment ||
      enrollment.enabled !== true ||
      enrollment.jobHash !== t.jobHash
    )
      continue;
    await send(t, id);
    // An acknowledged send is audit evidence, never search completion. Retain it before removing pending.
    const receipt = { pk: OUTBOX, sk: "SENT#" + id, version: 0, ticket: t };
    const prior = await store.get(OUTBOX, receipt.sk);
    if (!prior) {
      try {
        await store.put(receipt);
      } catch (e) {
        const raced = await store.get(OUTBOX, receipt.sk);
        if (fingerprint(raced) !== fingerprint(receipt)) throw e;
      }
    } else if (fingerprint(prior) !== fingerprint(receipt))
      throw Error("Outbox acknowledgement differs");
    try {
      await store.delete(row.pk, row.sk, row.version);
    } catch (e) {
      if (await store.get(row.pk, row.sk)) throw e;
    }
    published++;
  }
  return { published };
}
export async function consumeTicket(
  store: Store,
  raw: string,
  launch: Launcher,
) {
  const t = parseTicket(raw),
    pk = "OWNER#" + t.owner;
  const job = await store.get(pk, "JOB#" + t.jobId);
  if (!job) throw Error("Dispatch job missing");
  const prior = await store.get(pk, "V5_INVOCATION#" + t.jobId);
  if (prior) {
    // Only this bridge can bind a queue ticket to an invocation. Uncertain claims never respawn.
    const binding = await store.get(pk, "DISPATCH_BINDING#" + t.jobId);
    if (
      !binding ||
      binding.ticketId !== ticketId(t) ||
      binding.invocationId !== prior.invocationId
    )
      throw Error("Unbound existing invocation");
    const key = { pk: "SYSTEM#QSB_DISPATCH_RECONCILE", sk: ticketId(t) };
    if (!(await store.get(key.pk, key.sk))) {
      try {
        await store.atomicPut([
          {
            row: {
              ...key,
              version: 0,
              ticket: t,
              invocationId: prior.invocationId,
              reason: "existing_invocation_requires_inspection",
              automaticRelaunchAllowed: false,
            },
          },
          { row: prior, expected: prior.version, conditionOnly: true },
        ]);
      } catch (e) {
        if (!(await store.get(key.pk, key.sk))) throw e;
      }
    }
    return {
      state: "reconcile_existing" as const,
      invocationId: prior.invocationId,
    };
  }
  if (fingerprint(job.job) !== t.jobHash) throw Error("Queued job changed");
  // Operator enrollment is stored, immutable by browser/API. Runtime paths/credentials cannot come from SQS.
  const enrollment = await store.get(pk, "DISPATCH_CONFIG#" + t.jobId);
  if (
    !enrollment ||
    !Number.isSafeInteger(enrollment.version) ||
    enrollment.version < 1 ||
    enrollment.enabled !== true ||
    enrollment.jobHash !== t.jobHash
  )
    throw Error("Dispatch configuration not enrolled");
  const wrapped: Store = {
    ...store,
    get: store.get.bind(store),
    list: store.list.bind(store),
    reservationRows: store.reservationRows.bind(store),
    put: store.put.bind(store),
    delete: store.delete.bind(store),
    atomicPut: async (writes) => {
      const inv = writes.find(
        (w) =>
          w.row.sk === "V5_INVOCATION#" + t.jobId && w.expected === undefined,
      );
      if (!inv) throw Error("Unexpected dispatch transaction");
      await store.atomicPut([
        ...writes,
        { row: enrollment, expected: enrollment.version, conditionOnly: true },
        {
          row: {
            pk,
            sk: "DISPATCH_BINDING#" + t.jobId,
            version: 0,
            ticketId: ticketId(t),
            invocationId: inv.row.invocationId,
          },
        },
      ]);
    },
  };
  const result = await dispatchExplicitJob(
    wrapped,
    t.owner,
    t.jobId,
    enrollment.config as any,
    launch,
  );
  return {
    state: result.launched
      ? ("accepted" as const)
      : ("reconcile_existing" as const),
    invocationId: (result.receipt as Row).invocationId,
  };
}
