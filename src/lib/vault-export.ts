import type { PublicVault, StrayOutput } from "./model";

/**
 * Each deposit's record for the owner to keep: the vault's QSB version, its one deposit and
 * any stray payments the server flagged. Public fields only; the recovery backup stays separate.
 */
export function vaultExport(vaults: PublicVault[], stray: StrayOutput[], exportedAt = new Date()) {
  return {
    format: "qsb-vault-export-v1",
    exportedAt: exportedAt.toISOString(),
    vaults: vaults.map((v) => ({
      id: v.id,
      name: v.name,
      createdAt: v.createdAt,
      network: v.network,
      protocol: v.configuration.protocol,
      generatorCommit: v.configuration.generatorCommit,
      scriptHash: v.scriptHash,
      status: v.status,
      funding: v.funding ?? null,
      strayOutputs: stray
        .filter((o) => o.vaultId === v.id)
        .map((o) => ({ txid: o.txid, vout: o.vout, value: o.value, firstSeenAt: o.firstSeenAt })),
    })),
  };
}

export function downloadVaultExport(vaults: PublicVault[], stray: StrayOutput[]) {
  const record = vaultExport(vaults, stray);
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(record, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `qsb-vaults-${record.exportedAt.slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
