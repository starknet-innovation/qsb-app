import type { Store } from "./store";
import { fingerprint } from "../src/lib/provenance";
import contract from "./mainnet-capability.json";
export const MAINNET_UI_PROFILE = "qsb-supervised-pin-v4-subset-v5" as const;
export type MainnetUiOptions = {
  supervisedSearch?: boolean;
  recovery?: boolean;
};
/** Navigation advertisement only. Not deployment/IAM/migration/readiness certification or transaction authority. */
export async function mainnetUiConfig(
  store: Store,
  network: string,
  options: MainnetUiOptions = {},
  routes: { creation: boolean; admission: boolean } = {
    creation: false,
    admission: false,
  },
) {
  const search = options.supervisedSearch === true && routes.creation === true,
    recovery = options.recovery === true && routes.admission === true;
  const result = {
    supervisedSearch: { enabled: false, releaseId: MAINNET_UI_PROFILE },
    mainnetRecoveryEnabled: false,
  };
  if (network !== "mainnet" || (!search && !recovery)) return result;
  try {
    const row = await store.get("SYSTEM#QSB_MAINNET_SERVICE", "CAPABILITY");
    if (
      !row ||
      !Number.isSafeInteger(row.version) ||
      row.version < 1 ||
      row.enabled !== true ||
      fingerprint(row.contract) !== fingerprint(contract)
    )
      return result;
    return {
      supervisedSearch: { enabled: search, releaseId: MAINNET_UI_PROFILE },
      mainnetRecoveryEnabled: recovery,
    };
  } catch {
    return result;
  }
}
