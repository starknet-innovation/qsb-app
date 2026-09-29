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

/** How long a sign-in challenge and a session last, in seconds. */
export const CHALLENGE_SECONDS = 300;
export const SESSION_SECONDS = 3600;
