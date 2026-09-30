import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import type { SecretBox, SecretContext } from "./webhooks";

/** What a ciphertext is for. The key policy and the runtime boundary require it on every call. */
export const SECRET_PURPOSE = "qsb-webhook-signing-secret";
/** A single-region key ARN, as terraform/compute.tf passes it. */
const KEY_ARN = /^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:key\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/**
 * The KMS encryption context. KMS opens a ciphertext only with the context it was sealed with, so
 * a ciphertext copied to another owner's row, or to another webhook, doesn't open. The context is
 * not secret: CloudTrail records it with each call.
 */
export function encryptionContext({ owner, webhook }: SecretContext): Record<string, string> {
  return { purpose: SECRET_PURPOSE, owner, webhook };
}

/**
 * Webhook signing secrets sealed with KMS Encrypt and opened with Decrypt, under the one key
 * named by QSB_WEBHOOK_SECRET_KEY_ARN. Terraform sets it on the API Lambda only, and only with
 * webhook_secret_kms_enabled. Unset, this is undefined and secrets are stored as before.
 *
 * The secret is 49 bytes, so it goes to KMS directly rather than through a data key: that is one
 * KMS call per registration and one per delivery round, the same count as envelope encryption
 * with a data key per secret, with no local cipher to get wrong.
 *
 * A malformed value never throws here, since the API also serves funds routes: every seal and
 * open fails instead, so registration fails and sealed webhooks wait.
 */
export function kmsWebhookSecrets(
  keyArn = process.env.QSB_WEBHOOK_SECRET_KEY_ARN,
  client?: Pick<KMSClient, "send">,
): SecretBox | undefined {
  if (!keyArn) return;
  if (!KEY_ARN.test(keyArn)) {
    const refuse = async (): Promise<string> => {
      throw new Error("InvalidConfiguration");
    };
    return { seal: refuse, open: refuse };
  }
  // Two attempts at most: a round's deadline bounds each call anyway, and cancels it.
  const kms = client ?? new KMSClient({ region: process.env.AWS_REGION, maxAttempts: 2 });
  return {
    async seal(plaintext, context, signal) {
      const input = Buffer.from(plaintext, "utf8");
      try {
        const { CiphertextBlob } = await kms.send(
          new EncryptCommand({ KeyId: keyArn, Plaintext: input, EncryptionContext: encryptionContext(context) }),
          { abortSignal: signal },
        );
        if (!CiphertextBlob?.length) throw new Error("EmptyCiphertext");
        return Buffer.from(CiphertextBlob).toString("base64");
      } finally {
        input.fill(0);
      }
    },
    async open(ciphertext, context, signal) {
      // Naming the key refuses a ciphertext sealed under any other key.
      const { Plaintext } = await kms.send(
        new DecryptCommand({
          KeyId: keyArn,
          CiphertextBlob: Buffer.from(ciphertext, "base64"),
          EncryptionContext: encryptionContext(context),
        }),
        { abortSignal: signal },
      );
      if (!Plaintext?.length) throw new Error("EmptyPlaintext");
      try {
        return Buffer.from(Plaintext).toString("utf8");
      } finally {
        Plaintext.fill(0);
      }
    },
  };
}
