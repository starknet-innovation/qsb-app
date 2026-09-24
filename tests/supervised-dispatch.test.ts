import { describe, it, expect, vi } from "vitest";
import { MemoryStore, Conflict } from "../server/store";
import { fingerprint } from "../src/lib/provenance";
import {
  withCreationOutbox,
  publishPending,
  consumeTicket,
  parseTicket,
  OUTBOX,
  ticketId,
} from "../supervised/dispatch/bridge";
const job = {
  id: "synthetic-job",
  owner: "synthetic-owner",
  status: "queued",
  revision: 0,
};
const row = { pk: "OWNER#" + job.owner, sk: "JOB#" + job.id, version: 0, job };
async function fixture() {
  const store = new MemoryStore();
  await withCreationOutbox(store).atomicPut([{ row }]);
  const pending = (await store.list(OUTBOX, "PENDING#"))[0];
  const ticket = parseTicket(JSON.stringify(pending.ticket));
  await store.put({
    pk: row.pk,
    sk: "DISPATCH_CONFIG#" + job.id,
    version: 1,
    enabled: true,
    jobHash: fingerprint(job),
  });
  return { store, ticket };
}
describe("durable dispatch handoff", () => {
  it("atomically saves the job and notification", async () => {
    const { store, ticket } = await fixture();
    expect(await store.get(row.pk, row.sk)).toEqual(row);
    expect((await store.list(OUTBOX, "PENDING#"))[0].sk).toBe(
      "PENDING#" + ticketId(ticket),
    );
  });
  it("failed reservation saves neither job nor notification", async () => {
    const s = new MemoryStore();
    await s.put({ pk: "reserved", sk: "point", version: 0 });
    await expect(
      withCreationOutbox(s).atomicPut([
        { row },
        { row: { pk: "reserved", sk: "point", version: 0 } },
      ]),
    ).rejects.toBeInstanceOf(Conflict);
    expect(await s.get(row.pk, row.sk)).toBeUndefined();
    expect(await s.list(OUTBOX, "PENDING#")).toHaveLength(0);
  });
  it("uncertain queue acknowledgement retains notification and stable deduplication identity", async () => {
    const { store, ticket } = await fixture();
    const ids: string[] = [];
    await expect(
      publishPending(store, async (_, id) => {
        ids.push(id);
        throw Error("ack lost");
      }),
    ).rejects.toThrow();
    await publishPending(store, async (_, id) => {
      ids.push(id);
    });
    expect(ids).toEqual([ticketId(ticket), ticketId(ticket)]);
    expect(await store.list(OUTBOX, "PENDING#")).toHaveLength(0);
    expect(await store.list(OUTBOX, "SENT#")).toHaveLength(1);
  });
  it("waits for trusted configuration without losing the notification", async () => {
    const { store } = await fixture();
    await store.delete(row.pk, "DISPATCH_CONFIG#" + job.id, 1);
    const send = vi.fn();
    expect(await publishPending(store, send)).toEqual({ published: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(await store.list(OUTBOX, "PENDING#")).toHaveLength(1);
  });
  it("recovers a crash after send and receipt but before pending deletion", async () => {
    const { store } = await fixture();
    const original = store.delete.bind(store);
    store.delete = async () => {
      throw Error("crash");
    };
    await expect(publishPending(store, async () => {})).rejects.toThrow();
    store.delete = original;
    await publishPending(store, async () => {});
    expect(await store.list(OUTBOX, "SENT#")).toHaveLength(1);
    expect(await store.list(OUTBOX, "PENDING#")).toHaveLength(0);
  });
  it("concurrent publishers can duplicate delivery but retain one receipt", async () => {
    const { store } = await fixture();
    const sent = vi.fn(async () => {});
    await Promise.all([
      publishPending(store, sent),
      publishPending(store, sent),
    ]);
    expect(await store.list(OUTBOX, "SENT#")).toHaveLength(1);
  });
  it("rejects queued job mutation before launch", async () => {
    const { store, ticket } = await fixture();
    await store.put(
      { ...row, version: 1, job: { ...job, status: "paused" } },
      0,
    );
    const launch = vi.fn();
    await expect(
      consumeTicket(store, JSON.stringify(ticket), launch),
    ).rejects.toThrow("changed");
    expect(launch).not.toHaveBeenCalled();
  });
  it("duplicate or uncertain invocation never calls the launcher", async () => {
    const { store, ticket } = await fixture();
    await store.put({
      pk: row.pk,
      sk: "V5_INVOCATION#" + job.id,
      version: 1,
      status: "unknown",
      invocationId: "test",
    });
    await store.put({
      pk: row.pk,
      sk: "DISPATCH_BINDING#" + job.id,
      version: 0,
      invocationId: "test",
      ticketId: ticketId(ticket),
    });
    const launch = vi.fn();
    expect(
      (await consumeTicket(store, JSON.stringify(ticket), launch)).state,
    ).toBe("reconcile_existing");
    expect(launch).not.toHaveBeenCalled();
  });
  it("rejects an unbound pre-existing invocation", async () => {
    const { store, ticket } = await fixture();
    await store.put({
      pk: row.pk,
      sk: "V5_INVOCATION#" + job.id,
      version: 1,
      invocationId: "test",
    });
    await expect(
      consumeTicket(store, JSON.stringify(ticket), vi.fn()),
    ).rejects.toThrow("Unbound");
  });
  it("cannot execute without actual capability even when configuration is marked enabled", async () => {
    const { store, ticket } = await fixture();
    const launch = vi.fn();
    await expect(
      consumeTicket(store, JSON.stringify(ticket), launch),
    ).rejects.toThrow();
    expect(launch).not.toHaveBeenCalled();
  });
  it("dormant tickets do not starve an eligible ticket after the batch limit", async () => {
    const { store, ticket } = await fixture();
    const original = store.list.bind(store);
    const ready = (await original(OUTBOX, "PENDING#"))[0];
    const dormant = Array.from({ length: 101 }, (_, i) => {
      const t = { ...ticket, jobId: "dormant-" + i };
      return {
        pk: OUTBOX,
        sk: "PENDING#" + ticketId(t),
        version: 0,
        ticket: t,
      };
    });
    store.list = async (pk, prefix) =>
      pk === OUTBOX && prefix === "PENDING#"
        ? [...dormant, ready]
        : original(pk, prefix);
    const send = vi.fn(async () => {});
    expect(await publishPending(store, send, 1)).toEqual({ published: 1 });
    expect(send).toHaveBeenCalledOnce();
  });
  it("rejects paths, keys and additional queue fields", async () => {
    const { ticket } = await fixture();
    expect(() =>
      parseTicket(JSON.stringify({ ...ticket, command: "/tmp/start" })),
    ).toThrow();
    expect(() => parseTicket("x".repeat(4097))).toThrow();
  });
});
