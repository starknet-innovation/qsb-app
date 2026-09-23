import { afterEach, expect, it, vi } from "vitest";
import { Runpod } from "../server/providers";

afterEach(() => vi.unstubAllGlobals());

it("retries transient status reads with the same ID and total timeout signal", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response("", { status: 500 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: "job", status: "IN_PROGRESS" })));
  vi.stubGlobal("fetch", fetcher);
  expect((await new Runpod("endpoint", "disposable").status("job")).status).toBe("IN_PROGRESS");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0][0]).toBe(fetcher.mock.calls[1][0]);
  expect(fetcher.mock.calls[0][1].signal).toBe(fetcher.mock.calls[1][1].signal);
  expect(fetcher.mock.calls[1][1].method).toBe("GET");
});

it.each([401, 402, 403, 404])("never retries status HTTP %s", async (status) => {
  const fetcher = vi.fn().mockResolvedValue(new Response("", { status }));
  vi.stubGlobal("fetch", fetcher);
  await expect(new Runpod("endpoint", "disposable").status("job")).rejects.toThrow(String(status));
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("bounds persistent status errors to three reads", async () => {
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response("", { status: 503 })));
  vi.stubGlobal("fetch", fetcher);
  await expect(new Runpod("endpoint", "disposable").status("job")).rejects.toThrow("503");
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("never retries paid submission errors", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
  vi.stubGlobal("fetch", fetcher);
  await expect(new Runpod("endpoint", "disposable").run({})).rejects.toThrow("500");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("returns deterministic worker failure without retry", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "job", status: "FAILED", error: "kernel failure" })));
  vi.stubGlobal("fetch", fetcher);
  expect((await new Runpod("endpoint", "disposable").status("job")).status).toBe("FAILED");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each(["not json", JSON.stringify({ id: "job", status: "UNKNOWN" })])(
  "does not retry malformed successful responses",
  async (body) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(body));
    vi.stubGlobal("fetch", fetcher);
    await expect(new Runpod("endpoint", "disposable").status("job")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

it("does not reset an expired shared deadline for another attempt", async () => {
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  const fetcher = vi.fn().mockImplementation(async () => {
    controller.abort(new DOMException("Timeout", "TimeoutError"));
    return new Response("", { status: 500 });
  });
  vi.stubGlobal("fetch", fetcher);
  try {
    await expect(new Runpod("endpoint", "disposable").status("job")).rejects.toThrow("Timeout");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledTimes(1);
  } finally {
    timeout.mockRestore();
  }
});
