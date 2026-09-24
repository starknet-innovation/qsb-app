import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import type { Store } from "../../server/store";
import type { Launcher } from "../archive/work/yukon-mainnet-service-enrollment-20260923/dispatch";
import { consumeTicket } from "./bridge";
/** One message per process, one inherited credential pipe per invocation. Never an in-process retry loop. */
export async function receiveOne(
  store: Store,
  launch: Launcher,
  queueUrl: string,
  client = new SQSClient({ maxAttempts: 3 }),
) {
  const { Messages = [] } = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 20,
      VisibilityTimeout: 2100,
    }),
  );
  if (!Messages.length) return { idle: true };
  const m = Messages[0];
  if (!m.Body || !m.ReceiptHandle) throw Error("Incomplete queue envelope");
  const result = await consumeTicket(store, m.Body, launch);
  // Existing/unknown invocation is explicitly retained for reconciliation, never relaunched by delivery retry.
  await client.send(
    new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: m.ReceiptHandle,
    }),
  );
  return result;
}
