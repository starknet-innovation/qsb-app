import { z } from "zod";
import { NETWORK_ID } from "../../src/lib/network";
import type { Store } from "../store";
import { GateError } from "./capability";
import { admitSupervisedJob } from "./dispatcher";
import {
  exportSigningHandoff,
  readAdmittedSolvedBundle,
} from "./evidence-reader";

type GetRoutes = {
  get: (path: string, ...handlers: unknown[]) => unknown;
};
type PostRoutes = {
  post: (path: string, ...handlers: unknown[]) => unknown;
};
type RouteContext = {
  req: { json: () => Promise<unknown>; param: (name: string) => string };
  get: (key: "owner") => string;
  json: (body: unknown, status?: number) => Response;
};

function gate(error: unknown): { body: { error: string }; status: 400 | 404 | 409 | 503 } | undefined {
  if (error instanceof GateError)
    return { body: { error: error.message }, status: error.status };
  if (error instanceof z.ZodError) return undefined;
  if (error instanceof Error && error.message === "Invalid request")
    return { body: { error: error.message }, status: 400 };
  return undefined;
}

export function installSupervisedRoutes(
  read: GetRoutes,
  write: PostRoutes,
  store: Store,
  options: { post?: boolean } = {},
): void {
  if (options.post !== false) {
    write.post("/api/jobs/supervised", async (c: RouteContext) => {
      try {
        const admitted = await admitSupervisedJob(
          store,
          c.get("owner"),
          NETWORK_ID,
          await c.req.json(),
        );
        return c.json(
          {
            job: admitted.job,
            runtime: admitted.job.runtime,
          },
          admitted.created ? 201 : 200,
        );
      } catch (error) {
        const refused = gate(error);
        if (refused) return c.json(refused.body, refused.status);
        throw error;
      }
    });
  }
  read.get("/api/jobs/:id/mainnet-solved-state", async (c: RouteContext) => {
    try {
      const admitted = await readAdmittedSolvedBundle(
        store,
        c.get("owner"),
        c.req.param("id"),
      );
      return c.json({
        bundle: admitted.bundle,
        mainnetAuthorized: false,
        record: { bundleSha256: admitted.bundleSha256 },
      });
    } catch (error) {
      const refused = gate(error);
      if (refused) return c.json(refused.body, refused.status);
      throw error;
    }
  });
  read.get("/api/jobs/:id/signing-handoff", async (c: RouteContext) => {
    try {
      return c.json(
        await exportSigningHandoff(store, c.get("owner"), c.req.param("id")),
      );
    } catch (error) {
      const refused = gate(error);
      if (refused) return c.json(refused.body, refused.status);
      throw error;
    }
  });
}
