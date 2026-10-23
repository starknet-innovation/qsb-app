import { ApiRequestError } from "./session";

/**
 * What the webapp says when `POST /vaults` refuses a vault. The server checks the new script
 * before it saves anything, so each says nothing was saved. Each refusal of the script keeps the
 * downloaded backup: its secrets may be the only ones that spend what was paid. Any other error
 * is returned as it is.
 */
export function registrationError(error: unknown): unknown {
  const code = error instanceof ApiRequestError ? error.code : undefined;
  if (code === "chain_unavailable" || code === "chain_error")
    return new Error("The server couldn't check this vault's script on chain, so it saved nothing. Try again shortly.");
  if (code === "vault_script_paid")
    return new Error(
      "Something has already paid this vault's script on chain, so it can't be a new vault and nothing was saved. Keep the backup you downloaded: it holds the secrets that can spend what was paid. Don't pay into this script.",
    );
  if (code === "vault_script_registered")
    return new Error(
      "Another vault on this server already has this script, so nothing was saved. Don't pay into this script for a new vault, and keep the backup you downloaded.",
    );
  return error;
}

/** Why a vault in `GET /vaults`'s `noDeposit` takes no deposit. */
export const NO_DEPOSIT =
  "Another vault on this server has this vault's script, so this vault takes no deposit. Don't make a deposit for it.";
/** For a vault in `noDeposit` whose deposit was already sent: the app won't resend it, and only the chain shows it. */
export const NO_DEPOSIT_SENT =
  "Another vault on this server has this vault's script, so the app won't resend this deposit. It shows here once it's mined, and until then its checks fail. Keep this vault's recovery backup.";

/**
 * A deposit route's refusal of a vault whose script another vault holds. It comes before this
 * request records or sends anything, and it's final: resending gets it again. An earlier
 * submission of the same bytes may still have reached MARA. `broadcast` is the txid of a deposit
 * Xverse broadcast, which the server refused to record.
 */
export function depositRefusal(error: unknown, broadcast?: string): Error | undefined {
  if (!(error instanceof ApiRequestError && error.status === 409 && error.code === "vault_script_registered")) return;
  return new Error(
    broadcast
      ? `${NO_DEPOSIT} The app won't record the transaction Xverse broadcast, ${broadcast}: it may still confirm, and the app never spends it. Keep this vault's recovery backup: its secrets are what can spend that payment.`
      : `${NO_DEPOSIT} This request sent nothing. If you submitted this deposit before, it may still confirm: the vault shows it once it's mined, so keep this vault's recovery backup.`,
  );
}
