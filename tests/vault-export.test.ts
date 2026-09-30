import { describe, expect, it } from "vitest";
import { vaultExport } from "../src/lib/vault-export";
import { withVaultConfiguration } from "../src/lib/provenance";
import type { StrayPayments } from "../src/lib/model";

const vault = (id: string, funded: boolean) =>
  withVaultConfiguration({
    id,
    name: `vault ${id.slice(0, 1)}`,
    createdAt: "2026-09-28T00:00:00.000Z",
    network: "mainnet",
    config: "A",
    scriptHex: "51".repeat(100),
    scriptHash: "aa".repeat(32),
    paymentAddress: "bc1qxxxxxxxxxxxxxxxx",
    publicStateJson: JSON.stringify({ config: "A", full_script_hex: "51".repeat(100) }),
    status: funded ? "confirmed" : "unfunded",
    ...(funded ? { funding: { txid: "11".repeat(32), vout: 0, value: "100000" } } : {}),
  });

describe("vault export", () => {
  const a = vault("1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a", true);
  const b = vault("2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b", false);
  const output = { txid: "cd".repeat(32), vout: 3, value: "25000", firstSeenAt: "2026-09-29T00:00:00.000Z" };
  const stray: StrayPayments = { vaultId: a.id, count: 1, sats: "25000", outputs: [output] };
  const record = vaultExport([a, b], [stray], new Date("2026-09-30T12:00:00.000Z"));

  it("gives each deposit its QSB version, funding, status and stray payments", () => {
    expect(record).toEqual({
      format: "qsb-vault-export-v1",
      exportedAt: "2026-09-30T12:00:00.000Z",
      vaults: [
        {
          id: a.id,
          name: a.name,
          createdAt: a.createdAt,
          network: "mainnet",
          protocol: "qsb-config-a-v1",
          generatorCommit: a.configuration.generatorCommit,
          scriptHash: a.scriptHash,
          status: "confirmed",
          funding: a.funding,
          strayPayments: { count: 1, sats: "25000", outputs: [output] },
        },
        expect.objectContaining({ id: b.id, status: "unfunded", funding: null, strayPayments: null }),
      ],
    });
  });

  it("carries public fields only", () => {
    const text = JSON.stringify(record);
    for (const field of ["scriptHex", "publicStateJson", "stateJson", "paymentAddress"])
      expect(text).not.toContain(field);
  });
});
