import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { store } from "../../server/store";
import { publishPending } from "./bridge";
const queue = new SQSClient({ maxAttempts: 3 });
export async function handler() {
  const QueueUrl = process.env.SUPERVISED_DISPATCH_QUEUE_URL;
  if (!QueueUrl || process.env.SUPERVISED_EXECUTION_ENABLED !== "true")
    return { disabled: true };
  return publishPending(store, async (t, id) => {
    await queue.send(
      new SendMessageCommand({
        QueueUrl,
        MessageBody: JSON.stringify(t),
        MessageGroupId: "qsb-single-supervisor",
        MessageDeduplicationId: id,
      }),
    );
  });
}
