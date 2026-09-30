// tests/setup/network-guard.ts runs before every test file. These cases pin what
// it blocks and what it leaves open; without the guard the first two would reach
// the network.
import http from "node:http";
import https from "node:https";
import { request as esmRequest } from "node:https";
import net from "node:net";
import tls from "node:tls";
import { expect, it } from "vitest";

const blocked = /Network access is blocked in unit tests/;

it("rejects a fetch to a public host before any socket opens", async () => {
  await expect(fetch("https://blockstream.info/api/blocks/tip/height")).rejects.toThrow(blocked);
  await expect(fetch(new URL("https://slipstream.mara.com/api/rates"))).rejects.toThrow(blocked);
  await expect(fetch(new Request("https://example.com/"))).rejects.toThrow(blocked);
});

it("refuses http and https requests to public hosts, through every import form", () => {
  expect(() => https.request({ hostname: "example.com", path: "/" })).toThrow(blocked);
  expect(() => https.request("https://example.com/")).toThrow(blocked);
  expect(() => https.get(new URL("https://example.com/"))).toThrow(blocked);
  expect(() => http.request({ host: "169.254.169.254", path: "/latest/meta-data/" })).toThrow(blocked);
  expect(() => esmRequest({ hostname: "example.com" })).toThrow(blocked);
  // In the (url, options) form the options override the URL's host.
  expect(() => http.request("http://127.0.0.1/", { hostname: "example.com" })).toThrow(blocked);
  expect(() => https.request(new URL("https://localhost/"), { host: "example.com" })).toThrow(blocked);
  expect(() => http.get("http://127.0.0.1/", { host: "169.254.169.254" })).toThrow(blocked);
});

it("refuses raw TCP and TLS sockets to public hosts, in every connect form", () => {
  expect(() => net.connect({ host: "example.com", port: 443 })).toThrow(blocked);
  expect(() => net.connect(80, "example.com")).toThrow(blocked);
  expect(() => net.createConnection({ host: "169.254.169.254", port: 80 })).toThrow(blocked);
  expect(() => new net.Socket().connect({ host: "example.com", port: 443 })).toThrow(blocked);
  expect(() => tls.connect({ host: "example.com", port: 443 })).toThrow(blocked);
  expect(() => tls.connect(443, "example.com")).toThrow(blocked);
});

it("leaves loopback open and tells the AWS SDK not to probe instance metadata", async () => {
  const server = http.createServer((_, res) => res.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ok");
    expect(await (await fetch(`http://localhost:${port}/`)).text()).toBe("ok");
    const body = await new Promise<string>((resolve, reject) => {
      http.get({ hostname: "127.0.0.1", port, path: "/" }, (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve(text));
      }).on("error", reject);
    });
    expect(body).toBe("ok");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  expect(process.env.AWS_EC2_METADATA_DISABLED).toBe("true");
});
