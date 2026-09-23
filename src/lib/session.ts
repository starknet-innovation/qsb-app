export function createSessionClient(fetcher: typeof fetch = fetch) {
let token: string | undefined;
let epoch = 0;
function clearSession() {
  epoch++;
  token = undefined;
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetcher(`/api${path}`, {
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
    throw new Error(
      r.ok
        ? "The API returned an invalid response. Please try again."
        : "The app API is unavailable. Please check that the local API server is running and try again.",
    );
  }
  if (!r.ok)
    throw new Error(data.error || "The request could not be completed.");
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
  if (typeof result.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.token)) throw new Error("Invalid authentication response.");
  token = result.token;
}

return { api, authenticate, clearSession, currentToken: () => token, currentEpoch: () => epoch };
}
