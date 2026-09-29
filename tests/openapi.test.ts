import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { API_ERROR_CODES, apiErrorCodes } from "../server/api-errors";
import { MemoryStore } from "../server/store";
import type { Esplora } from "../server/chain";
import type { Slipstream } from "../server/providers";
import {
  apiRoutes,
  openApiDocument,
  openApiPath,
  routeErrors,
  serializeOpenApi,
} from "../server/openapi";

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

  it("documents exactly the routes createApp serves", () => {
    const served = createApp(new MemoryStore())
      .routes.filter((r) => r.method !== "ALL" && r.method !== "OPTIONS")
      .map((r) => `${r.method} ${openApiPath(r.path)}`);
    const documented = operations.map(
      ({ method, path }) => `${method.toUpperCase()} ${path}`,
    );
    expect(new Set(documented).size).toBe(documented.length);
    expect(documented.sort()).toEqual([...new Set(served)].sort());
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
      "components",
    ]);
    expect(document.openapi).toBe("3.1.0");
    expect(document.info).toMatchObject({
      title: expect.any(String),
      version: expect.any(String),
    });
    expect(document.servers).toEqual([{ url: "/" }]);
    const schemes = Object.keys(document.components.securitySchemes);
    const ids = operations.map(({ operation }) => operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { path, method, operation } of operations) {
      expect(path).toMatch(/^\/api\//);
      expect(["get", "post"]).toContain(method);
      expect(operation.summary).toEqual(expect.any(String));
      const templated = [...path.matchAll(/\{(\w+)\}/g)].map(([, n]) => n);
      const params = (operation.parameters ?? []) as Json[];
      expect(params.map((p) => p.name)).toEqual(templated);
      for (const p of params)
        expect(p).toMatchObject({ in: "path", required: true, schema: {} });
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
