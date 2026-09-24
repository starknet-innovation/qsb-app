import { readFileSync } from "node:fs";
import { DynamoStore } from "../../server/store";
import { createHostLauncher } from "../host/process";
import { HOST, hostRegistry } from "../host/claim";
import { receiveOne } from "./queue";
/** Protected deployment config, fixed entrypoint, inherited private FIFO fd 3. No CLI-provided request. */
async function main() {
  const bytes = readFileSync("/etc/qsb/host.json", "utf8");
  if (bytes.length > 16384) throw Error("Host config exceeds limit");
  const cfg = JSON.parse(bytes);
  if (
    cfg.executionEnabled !== true ||
    cfg.region !== "eu-west-1" ||
    typeof cfg.table !== "string" ||
    !/^QsbYukonIsolated[A-Za-z0-9-]+$/.test(cfg.table) ||
    typeof cfg.dispatchQueue !== "string" ||
    !/^https:\/\/sqs\.eu-west-1\.amazonaws\.com\/\d{12}\/[A-Za-z0-9_-]+\.fifo$/.test(
      cfg.dispatchQueue,
    )
  )
    throw Error("Runtime deployment is not enrolled");
  if (process.env.AWS_REGION && process.env.AWS_REGION !== cfg.region)
    throw Error("AWS region differs");
  process.env.AWS_REGION = cfg.region;
  const store = new DynamoStore(cfg.table),
    registry = hostRegistry(await store.get(HOST.pk, HOST.sk));
  if (registry.table !== cfg.table || registry.region !== cfg.region)
    throw Error("Host deployment binding differs");
  const host = createHostLauncher(store, 3);
  let invocationId: string | undefined;
  try {
    await receiveOne(
      store,
      async (request) => {
        invocationId = request.invocationId;
        return host.launch(request);
      },
      cfg.dispatchQueue,
    );
  } finally {
    if (invocationId) {
      try {
        await host.wait(invocationId);
      } catch {
        /* No owned child was created; durable claim remains authoritative. */
      }
    }
  }
}
main().catch(() => {
  console.error(
    "Dispatcher stopped; inspect durable invocation and host evidence before any replacement.",
  );
  process.exitCode = 1;
});
