import { beforeEach, describe, expect, it, vi } from "vitest";
// The resolver's DNS client is replaced: no query leaves the process.
const dns = vi.hoisted(() => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
  cancel: vi.fn(),
  options: [] as unknown[],
  lookup: vi.fn(() => {
    throw Error("getaddrinfo must not be used");
  }),
}));
vi.mock("node:dns/promises", () => ({
  Resolver: class {
    constructor(options: unknown) {
      dns.options.push(options);
    }
    resolve4 = dns.resolve4;
    resolve6 = dns.resolve6;
    cancel = dns.cancel;
  },
  lookup: dns.lookup,
  default: { lookup: dns.lookup },
}));
import { systemResolver } from "../server/webhook-transport";

const code = (value: string) => Object.assign(new Error(value), { code: value });
beforeEach(() => {
  vi.clearAllMocks();
  dns.options.length = 0;
});
describe("webhook host resolution", () => {
  it("returns every A and AAAA answer through c-ares, with a bounded per-query timeout", async () => {
    dns.resolve4.mockResolvedValue(["93.184.215.14"]);
    dns.resolve6.mockResolvedValue(["2606:4700:4700::1111"]);
    expect(await systemResolver("hooks.example.com", 3000)).toEqual([
      { address: "93.184.215.14", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    expect(dns.options).toEqual([{ timeout: 1000, tries: 1 }]);
    expect(dns.cancel).toHaveBeenCalledOnce();
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it("leaves out a family with no records", async () => {
    dns.resolve4.mockResolvedValue(["93.184.215.14"]);
    dns.resolve6.mockRejectedValue(code("ENODATA"));
    expect(await systemResolver("hooks.example.com", 3000)).toEqual([{ address: "93.184.215.14", family: 4 }]);
  });

  it("gives up at its timeout and cancels the outstanding queries", async () => {
    dns.resolve4.mockReturnValue(new Promise(() => {}));
    dns.resolve6.mockReturnValue(new Promise(() => {}));
    const started = Date.now();
    await expect(systemResolver("slow.example.com", 100)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(500);
    expect(dns.cancel).toHaveBeenCalledOnce();
  });

  it("fails when no family answered and a lookup failed", async () => {
    dns.resolve4.mockRejectedValue(code("ESERVFAIL"));
    dns.resolve6.mockRejectedValue(code("ENODATA"));
    await expect(systemResolver("broken.example.com", 3000)).rejects.toThrow();
    dns.resolve4.mockRejectedValue(code("ENOTFOUND"));
    expect(await systemResolver("gone.example.com", 3000)).toEqual([]);
  });
});
