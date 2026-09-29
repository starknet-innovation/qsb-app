import { z } from "zod";
import { sats, txid } from "../src/lib/model";

// Request bodies and path parameters the handlers in app.ts parse. The OpenAPI
// document (server/openapi.ts) is built from these same objects. The vault and
// withdrawal bodies are publicVaultSchema and withdrawalSchema, the payment
// input body is outpoint (src/lib/model.ts).

export const challengeRequest = z
  .object({ address: z.string().min(14).max(100) })
  .strict();
export const verifyRequest = z
  .object({ id: z.string().uuid(), signature: z.string().max(4096) })
  .strict();
export const fundRequest = z
  .object({
    txid,
    amount: sats,
    costAccepted: z.literal(true),
  })
  .strict();
export const fundSubmitRequest = z
  .object({
    rawTxHex: z
      .string()
      .regex(/^(?:[0-9a-fA-F]{2})+$/)
      .max(200000),
    amount: sats,
    costAccepted: z.literal(true),
  })
  .strict();
/** The body is optional; a missing or unparsable body counts as `{}`. */
export const fundResubmitRequest = z.object({}).strict();
export const submitRequest = z
  .object({ rawTxHex: z.string().max(150000) })
  .strict();
export const transactionIdParam = z.string().regex(/^[a-f0-9]{64}$/);

/** Owner event types: a job status for `withdrawal.*`, a vault status for `deposit.*`. */
export const EVENT_TYPES = [
  "withdrawal.queued",
  "withdrawal.searching",
  "withdrawal.paused",
  "withdrawal.failed",
  "withdrawal.awaiting_authorization",
  "withdrawal.submitted",
  "withdrawal.confirmed",
  "deposit.submitted",
  "deposit.confirmed",
  "deposit.spent",
  "deposit.dropped",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export const eventType = z.enum(EVENT_TYPES);
/** GET /api/events query parameters, as strings. */
export const eventsCursorParam = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
export const eventsLimitParam = z.string().regex(/^(?:[1-9]\d?|100)$/);
export const webhookRequest = z
  .object({
    url: z.string().max(2048),
    events: z.array(eventType).min(1).max(EVENT_TYPES.length).optional(),
  })
  .strict();

/** How long a sign-in challenge and a session last, in seconds. */
export const CHALLENGE_SECONDS = 300;
export const SESSION_SECONDS = 3600;
