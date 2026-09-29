import { readFileSync } from "node:fs";
import { inspectRoutes } from "hono/dev";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app";
import { deployedApiApp } from "../server/lambda";
import { API_ERROR_CODES, apiErrorCodes } from "../server/api-errors";
import { MemoryStore } from "../server/store";
import type { Esplora } from "../server/chain";
import type { Slipstream } from "../server/providers";
import { idempotentPosts } from "../server/idempotency";
import {
  acceptsIdempotencyKey,
  apiRoutes,
  errorSources,
  flaglessPattern,
  openApiDocument,
  openApiPath,
  routeErrors,
  unreachedErrorSites,
  serializeOpenApi,
} from "../server/openapi";

// The deployed app uses the process-wide chain and miner. Neither can reach a
// provider from this file.
vi.mock("../server/chain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/chain")>();
  return {
    ...actual,
    chain: new actual.Esplora("https://chain.test", async (url) => {
      throw Error(`Unexpected chain lookup ${url}`);
    }),
  };
});
vi.mock("../server/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/providers")>();
  return {
    ...actual,
    slipstream: new actual.Slipstream("https://miner.test", async () => {
      throw Error("Unexpected miner credential read");
    }),
  };
});

type Json = Record<string, any>;
const document = openApiDocument() as Json;
const operations = Object.entries(document.paths as Json).flatMap(
  ([path, methods]) =>
    Object.entries(methods as Json).map(([method, operation]) => ({
      path,
      method,
      operation: operation as Json,
    })),
);
// Hermetic: no chain or miner request can leave the process.
const offline = () =>
  createApp(new MemoryStore(), {
    chain: {} as Esplora,
    miner: {
      rates: async () => {
        throw new Error("offline");
      },
    } as unknown as Slipstream,
  });

describe("OpenAPI document", () => {
  it("matches docs/api/openapi.json (npm run openapi regenerates it)", () => {
    const committed = readFileSync(
      new URL("../docs/api/openapi.json", import.meta.url),
      "utf8",
    );
    expect(committed).toBe(serializeOpenApi(openApiDocument()));
  });

  it("documents exactly the routes the mainnet Lambda serves", () => {
    // Hono's own test for middleware: a handler that takes `next`. An app.all
    // route stays in as ALL, which no documented operation matches.
    const served = inspectRoutes(deployedApiApp("mainnet", new MemoryStore()))
      .filter((r) => !r.isMiddleware && r.method !== "OPTIONS");
    // Every route is registered once, under /api; /v1 is a rewrite and adds none.
    for (const r of served) expect(r.path).toMatch(/^\/api\//);
    const servedPaths = served.map(
      (r) => `${r.method} ${openApiPath(r.path)}`,
    );
    const documented = operations.map(
      ({ method, path }) => `${method.toUpperCase()} ${path}`,
    );
    expect(new Set(documented).size).toBe(documented.length);
    expect(documented.sort()).toEqual([...new Set(servedPaths)].sort());
  });

  it("serves every documented operation under each server", async () => {
    const app = deployedApiApp("mainnet", new MemoryStore());
    expect(document.servers.map((s: Json) => s.url)).toEqual(["/v1", "/api"]);
    for (const { path, method } of operations)
      for (const { url } of document.servers as Json[]) {
        const response = await app.request(
          `${url}${path.replace(/\{\w+\}/g, "ab".repeat(32))}`,
          {
            method: method.toUpperCase(),
            headers: { "content-type": "application/json" },
            body: method === "post" ? "{}" : undefined,
          },
        );
        // Hono's plain-text 404 means no route; every documented one answers JSON.
        expect(
          { at: `${method} ${url}${path}`, type: response.headers.get("content-type") },
        ).toEqual({ at: `${method} ${url}${path}`, type: expect.stringMatching(/^application\/json/) });
      }
  });

  it("documents the Idempotency-Key header on exactly the routes that accept it", () => {
    expect(apiRoutes.filter(acceptsIdempotencyKey).map((r) => r.path).sort()).toEqual(
      idempotentPosts.map((path) => `/api${path}`).sort(),
    );
    for (const route of apiRoutes) {
      const operation = document.paths[openApiPath(route.path)][route.method];
      const header = ((operation.parameters ?? []) as Json[]).filter((p) => p.in === "header");
      expect({ route: route.operationId, header: header.map((p) => p.name) }).toEqual({
        route: route.operationId,
        header: acceptsIdempotencyKey(route) ? ["Idempotency-Key"] : [],
      });
      if (acceptsIdempotencyKey(route))
        expect(routeErrors(route)[409]).toEqual(
          expect.arrayContaining(["idempotency_conflict", "idempotency_in_progress"]),
        );
    }
  });

  it("lists only codes from apiErrorCodes", () => {
    const known = Object.keys(apiErrorCodes);
    for (const route of apiRoutes)
      for (const codes of Object.values(routeErrors(route)))
        for (const code of codes ?? []) expect(known).toContain(code);
    for (const { operation } of operations)
      for (const [status, response] of Object.entries(
        operation.responses as Json,
      )) {
        if (Number(status) < 400) continue;
        const codes = response.content["application/json"].schema.allOf[1]
          .properties.code.enum as string[];
        expect(codes.length).toBeGreaterThan(0);
        for (const code of codes) expect(known).toContain(code);
      }
    expect(document.components.schemas.ApiErrorCode.enum).toEqual(
      API_ERROR_CODES,
    );
  });

  it("is structurally valid OpenAPI 3.1", () => {
    expect(Object.keys(document)).toEqual([
      "openapi",
      "info",
      "servers",
      "paths",
      "webhooks",
      "components",
    ]);
    expect(document.openapi).toBe("3.1.0");
    expect(document.info).toMatchObject({
      title: expect.any(String),
      version: expect.any(String),
    });
    expect(document.servers).toEqual([
      { url: "/v1" },
      { url: "/api", description: "webapp alias" },
    ]);
    const schemes = Object.keys(document.components.securitySchemes);
    const ids = operations.map(({ operation }) => operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { path, method, operation } of operations) {
      // Relative to the servers: no /api or /v1 prefix.
      expect(path).toMatch(/^\/(?!api\/|v1\/)/);
      expect(["get", "post"]).toContain(method);
      expect(operation.summary).toEqual(expect.any(String));
      const templated = [...path.matchAll(/\{(\w+)\}/g)].map(([, n]) => n);
      const params = (operation.parameters ?? []) as Json[];
      const inPath = params.filter((p) => p.in === "path");
      expect(inPath.map((p) => p.name)).toEqual(templated);
      for (const p of inPath)
        expect(p).toMatchObject({ required: true, schema: {} });
      // The others are optional query parameters and the optional Idempotency-Key header.
      for (const p of params.filter((p) => p.in !== "path"))
        expect(p).toMatchObject(
          p.in === "query"
            ? { required: false, schema: {} }
            : {
                name: "Idempotency-Key",
                in: "header",
                required: false,
                schema: { type: "string", pattern: expect.any(String) },
              },
        );
      for (const requirement of operation.security ?? [])
        for (const name of Object.keys(requirement))
          expect(schemes).toContain(name);
      const responses = Object.entries(operation.responses as Json);
      expect(responses.some(([status]) => /^2\d\d$/.test(status))).toBe(true);
      for (const [status, response] of responses) {
        expect(status).toMatch(/^[1-5]\d\d$/);
        expect(response.description).toEqual(expect.any(String));
        expect(Object.keys(response.content)).toEqual(["application/json"]);
      }
    }
    // The outbound webhook: a POST of one OwnerEvent, signed, with an id to drop duplicates by.
    expect(Object.keys(document.webhooks)).toEqual(["ownerEvent"]);
    const hook = document.webhooks.ownerEvent.post as Json;
    expect(hook.requestBody.content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/OwnerEvent",
    });
    expect((hook.parameters as Json[]).map((p) => [p.name, p.in, p.required])).toEqual([
      ["QSB-Signature", "header", true],
      ["QSB-Event-Id", "header", true],
    ]);
    expect(Object.keys(hook.responses)).toEqual(["2XX"]);
    // Every reference resolves, and every component is referenced.
    const refs = [
      ...JSON.stringify(document).matchAll(/"\$ref":"([^"]+)"/g),
    ].map(([, ref]) => ref);
    const components = Object.keys(document.components.schemas);
    for (const ref of refs)
      expect(components).toContain(ref.replace("#/components/schemas/", ""));
    for (const id of components)
      expect(refs).toContain(`#/components/schemas/${id}`);
  });

  it("requires a session exactly where the server does", async () => {
    const app = offline();
    for (const route of apiRoutes) {
      const response = await app.request(
        route.path.replace(/:\w+/g, "ab".repeat(32)),
        {
          method: route.method.toUpperCase(),
          headers: { "content-type": "application/json" },
          body: route.method === "post" ? "{}" : undefined,
        },
      );
      const body = await response.json();
      expect({
        route: route.operationId,
        auth: body.code === "auth_required",
      }).toEqual({ route: route.operationId, auth: route.auth });
    }
  });

  it("lists every error site in tests/api-error-sites.json", () => {
    const classStatus: Record<string, number> = {
      ChainError: 409,
      ChainNotFound: 409,
      WithdrawalConflict: 409,
      MinerInclusionError: 409,
      Conflict: 409,
      ConsensusError: 409,
      SubmitDisabled: 503,
      MinerAuthenticationError: 503,
      OwnerLimitsInvalid: 503,
    };
    const lines = JSON.parse(
      readFileSync(new URL("./api-error-sites.json", import.meta.url), "utf8"),
    ) as string[];
    const sites = lines.map((line) => {
      const [file, where, kind, code] = line.split(" | ");
      // An HTTP status, or the status app.onError gives the thrown class.
      const status = /^\d{3}$/.test(kind) ? Number(kind) : classStatus[kind];
      return {
        line,
        key: `${file} | ${where}`,
        file,
        where,
        kind,
        code,
        status,
      };
    });
    const listed = (
      errors: Partial<Record<number, readonly string[]>>,
      status?: number,
    ) =>
      status === undefined
        ? Object.values(errors).flatMap((codes) => codes ?? [])
        : (errors[status] ?? []);
    const byRoute = new Map(
      apiRoutes.map((r) => [`${r.method.toUpperCase()} ${r.path}`, r]),
    );
    for (const site of sites) {
      if (site.file === "app.ts") {
        // A route's own sites, the auth and body-limit middleware, and onError's
        // class mappings (which the sources below account for).
        const routes =
          site.where === "auth"
            ? apiRoutes.filter((r) => r.auth)
            : site.where === "bodyLimit"
              ? apiRoutes.filter((r) => r.method === "post")
              : [byRoute.get(site.where)];
        if (site.where === "onError") continue;
        expect(routes[0], site.line).toBeDefined();
        for (const route of routes)
          expect(listed(routeErrors(route!), site.status), site.line).toContain(
            site.code,
          );
        continue;
      }
      if (
        site.key in unreachedErrorSites ||
        `${site.key} | ${site.kind}` in unreachedErrorSites
      )
        continue;
      // A helper's site: a code attached to any error class can have any status.
      if (site.kind !== "attached")
        expect(site.status, site.line).toBeDefined();
      const covering = errorSources().filter((s) => s.sites.includes(site.key));
      expect(covering.length, site.line).toBeGreaterThan(0);
      expect(
        covering.some((s) => listed(s.errors, site.status).includes(site.code)),
        site.line,
      ).toBe(true);
    }
    const keys = sites.flatMap((site) => [
      site.key,
      `${site.key} | ${site.kind}`,
    ]);
    for (const key of [
      ...errorSources().flatMap((s) => s.sites),
      ...Object.keys(unreachedErrorSites),
    ])
      expect(keys).toContain(key);
  });

  it("emits a case-insensitive pattern without its flag, or refuses it", () => {
    for (const [regex, emitted] of [
      [/^[a-f0-9]{64}$/, "^[a-f0-9]{64}$"],
      [/^[a-f0-9]{64}$/i, "^[a-f0-9A-F]{64}$"],
      [/^(?:[a-f0-9]{2})+$/i, "^(?:[a-f0-9A-F]{2})+$"],
      [/^\d[\-a-c]\.$/i, "^\\d[\\-a-cA-C]\\.$"],
    ] as const) {
      expect(flaglessPattern(regex)).toBe(emitted);
      // The emitted pattern accepts exactly what the flagged regex does.
      for (const sample of [
        "ab".repeat(32),
        "AB".repeat(32),
        "aB09",
        "1B.",
        "1-.",
        "x",
      ])
        expect(new RegExp(emitted).test(sample)).toBe(regex.test(sample));
    }
    for (const regex of [
      /^abc$/i,
      /^[\x61-\x66]$/i,
      /^[\u0041]$/i,
      new RegExp("^\\p{Lu}$", "i"),
      /^\p{Lu}$/iu,
      /^(?<n>[a-f])\k<n>$/i,
      /^([a-f])\1$/i,
      /^[\A]$/i,
      /^\cA$/i,
      /^[a-f]$/g,
    ])
      expect(() => flaglessPattern(regex), String(regex)).toThrow(
        "No flagless form",
      );
  });

  it("describes every field /api/health and /api/config return", async () => {
    const app = offline();
    for (const [path, id] of [
      ["/api/health", "GetHealthResponse"],
      ["/api/config", "GetConfigResponse"],
    ]) {
      const body = await (await app.request(path)).json();
      const schema = document.components.schemas[id];
      expect(Object.keys(body).sort()).toEqual(
        Object.keys(schema.properties).sort(),
      );
      expect([...schema.required].sort()).toEqual(Object.keys(body).sort());
    }
  });
});
