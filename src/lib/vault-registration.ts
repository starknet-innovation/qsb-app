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

/**
 * A deposit route's refusal of a vault whose script another vault holds. It comes before anything
 * is recorded or sent, and it's final: resending the deposit gets it again.
 */
export function depositRefusal(error: unknown): Error | undefined {
  if (error instanceof ApiRequestError && error.status === 409 && error.code === "vault_script_registered")
    return new Error(
      "Another vault on this server has this vault's script, so this vault takes no deposit. Nothing was sent: don't send this deposit or make another for this vault.",
    );
}
