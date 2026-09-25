import { afterEach, expect, it, vi } from "vitest";
import { Runpod } from "../server/providers";
import { gpuSpendLimits } from "../server/gpu-spend";

function confirmedLimits() {
  return new Response(
    JSON.stringify({
      id: "endpoint",
      workers: {
        min: gpuSpendLimits.workersMin,
        max: gpuSpendLimits.workersMax,
      },
      timeout: gpuSpendLimits.executionTimeoutMs,
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

it("retries transient status reads with the same ID and total timeout signal", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response("", { status: 500 }))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "job", status: "IN_PROGRESS" })),
    );
  vi.stubGlobal("fetch", fetcher);
  expect(
    (await new Runpod("endpoint", "disposable").status("job")).status,
  ).toBe("IN_PROGRESS");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0][0]).toBe(fetcher.mock.calls[1][0]);
  expect(fetcher.mock.calls[0][1].signal).toBe(fetcher.mock.calls[1][1].signal);
  expect(fetcher.mock.calls[1][1].method).toBe("GET");
});

it.each([401, 402, 403, 404])(
  "never retries status HTTP %s",
  async (status) => {
    const fetcher = vi.fn().mockResolvedValue(new Response("", { status }));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      new Runpod("endpoint", "disposable").status("job"),
    ).rejects.toThrow(String(status));
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

it("bounds persistent status errors to three reads", async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(new Response("", { status: 503 })),
    );
  vi.stubGlobal("fetch", fetcher);
  await expect(
    new Runpod("endpoint", "disposable").status("job"),
  ).rejects.toThrow("503");
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("sets workersMax, workersMin, and the execution timeout before one paid submission", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(confirmedLimits())
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: "job-1" })));
  vi.stubGlobal("fetch", fetcher);
  expect(
    await new Runpod("endpoint", "disposable").run({ stage: "pinning" }),
  ).toEqual({
    id: "job-1",
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  const [patchUrl, patchInit] = fetcher.mock.calls[0];
  expect(patchUrl).toBe("https://api.runpod.io/v2/serverless/endpoint");
  expect(patchInit.method).toBe("PATCH");
  expect(JSON.parse(patchInit.body)).toEqual({
    workers: { min: 0, max: 1 },
    timeout: 900000,
  });
  expect(patchInit.headers.Authorization).toBe("Bearer disposable");
  const [runUrl, runInit] = fetcher.mock.calls[1];
  expect(runUrl).toBe("https://api.runpod.ai/v2/endpoint/run");
  expect(runInit.method).toBe("POST");
  expect(JSON.parse(runInit.body).policy.executionTimeout).toBe(900000);
});

it("does not submit paid work when the endpoint refuses the worker cap", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        id: "endpoint",
        workers: { min: 0, max: 3 },
        timeout: gpuSpendLimits.executionTimeoutMs,
      }),
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  await expect(new Runpod("endpoint", "disposable").run({})).rejects.toThrow(
    "ProviderLimitsUnconfirmed",
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][1].method).toBe("PATCH");
});

it("never retries paid submission errors", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(confirmedLimits())
    .mockResolvedValueOnce(new Response("", { status: 500 }));
  vi.stubGlobal("fetch", fetcher);
  await expect(new Runpod("endpoint", "disposable").run({})).rejects.toThrow(
    "500",
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1][0]).toBe(
    "https://api.runpod.ai/v2/endpoint/run",
  );
});

it("returns deterministic worker failure without retry", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "job",
          status: "FAILED",
          error: "kernel failure",
        }),
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  expect(
    (await new Runpod("endpoint", "disposable").status("job")).status,
  ).toBe("FAILED");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each(["not json", JSON.stringify({ id: "job", status: "UNKNOWN" })])(
  "does not retry malformed successful responses",
  async (body) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(body));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      new Runpod("endpoint", "disposable").status("job"),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

it("does not reset an expired shared deadline for another attempt", async () => {
  const controller = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(controller.signal);
  const fetcher = vi.fn().mockImplementation(async () => {
    controller.abort(new DOMException("Timeout", "TimeoutError"));
    return new Response("", { status: 500 });
  });
  vi.stubGlobal("fetch", fetcher);
  try {
    await expect(
      new Runpod("endpoint", "disposable").status("job"),
    ).rejects.toThrow("Timeout");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledTimes(1);
  } finally {
    timeout.mockRestore();
  }
});

it("prepared submissions perform no second control-plane call and cannot be reused", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(confirmedLimits())
    .mockRejectedValueOnce(new Error("lost POST response"));
  vi.stubGlobal("fetch", fetcher);
  const submit = await new Runpod("endpoint", "disposable").prepareRun();
  expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(submit({})).rejects.toThrow("lost POST response");
  await expect(submit({})).rejects.toThrow("SubmissionAlreadyAttempted");
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each([403, 500])("does not POST after limits HTTP %s", async (status) => {
  const fetcher = vi.fn().mockResolvedValue(new Response("", { status }));
  vi.stubGlobal("fetch", fetcher);
  await expect(
    new Runpod("endpoint", "disposable").prepareRun(),
  ).rejects.toThrow(String(status));
  expect(fetcher).toHaveBeenCalledTimes(1);
});
