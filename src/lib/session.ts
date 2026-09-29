import { API_BASE_PATH, type ApiBasePath } from "./network";

/**
 * A non-OK API response, for the webapp and the SDK. `code` is the API's machine-readable
 * error code, when it sent one.
 */
export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "ApiRequestError";
  }
}
const sessionToken = /^[A-Za-z0-9_-]{43}$/;
/** `basePath` prefixes every route: the webapp's own (`API_BASE_PATH`), or the SDK's choice. */
export function createSessionClient(fetcher: typeof fetch = fetch, basePath: ApiBasePath = API_BASE_PATH) {
let token: string | undefined;
let epoch = 0;
function clearSession() {
  epoch++;
  token = undefined;
}
/** Reuse a token from an earlier sign-in by the same owner, e.g. a CLI's session cache. */
function restoreSession(value: string) {
  if (!sessionToken.test(value)) throw new Error("Invalid session token.");
  epoch++;
  token = value;
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetcher(`${basePath}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    if (r.ok)
      throw new Error("The API returned an invalid response. Please try again.");
  }
  // A failure whose body isn't a JSON object (a gateway 502, a plain-text 404, `null`)
  // still reports its status.
  if (!r.ok && (typeof data !== "object" || data === null))
    throw new ApiRequestError(
      "The app API is unavailable. Please check that the local API server is running and try again.",
      r.status,
    );
  if (!r.ok)
    throw new ApiRequestError(
      data.error || "The request could not be completed.",
      r.status,
      typeof data.code === "string" ? data.code : undefined,
    );
  return data as T;
}
async function authenticate(
  address: string,
  sign: (message: string) => Promise<string>,
) {
  const attempt = ++epoch;
  token = undefined;
  const current = () => { if (epoch !== attempt) throw new Error("Wallet session changed during sign-in."); };
  const c = await api<{ id: string; message: string }>("/auth/challenge", {
    address,
  });
  current();
  const signature = await sign(c.message);
  current();
  const result = await api<{ token: string }>("/auth/verify", {
    id: c.id,
    signature,
  });
  current();
  if (typeof result.token !== 'string' || !sessionToken.test(result.token)) throw new Error("Invalid authentication response.");
  token = result.token;
}

return { api, authenticate, clearSession, restoreSession, currentToken: () => token, currentEpoch: () => epoch };
}
