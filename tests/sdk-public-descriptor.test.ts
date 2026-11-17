import { expect, it } from "vitest";
import { nodeQsb } from "./recovery-runtime";
import { publicRuntime } from "../sdk/public-runtime";
import { withVaultConfiguration } from "../src/lib/provenance";

it("validates Config A public state with exact integers before it can be registered or funded", async () => {
  const external = nodeQsb();
  const { stateJson: _secret, ...descriptor } = await external.generateQsb();
  external.lockQsb();
  const vault = withVaultConfiguration({ ...descriptor, id: crypto.randomUUID(), name: "public",
    createdAt: new Date().toISOString(), config: "A", network: "mainnet", status: "unfunded",
    paymentAddress: "bc1qxvenxvenxvenxvenxvenxvenxvenxven2ymjt8" });
  const runtime = publicRuntime();
  await expect(runtime.validate(vault)).resolves.toBeUndefined();
  const rounded = JSON.stringify(JSON.parse(vault.publicStateJson));
  expect(rounded).not.toBe(vault.publicStateJson);
  await expect(runtime.validate({ ...vault, publicStateJson: rounded })).rejects.toThrow("exactly match");
  await expect(runtime.validate({ ...vault, scriptHash: "00".repeat(32) })).rejects.toThrow("script hash");
}, 60000);
