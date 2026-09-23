import { createSessionClient } from "./session";

const session = createSessionClient();
export const api = session.api;
export const authenticate = session.authenticate;
export const clearSession = session.clearSession;

// Trusted same-origin application adapters only; never include these in public records.
export const readSessionToken = session.currentToken;
export const readSessionEpoch = session.currentEpoch;
