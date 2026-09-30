import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const json = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
const root = json("../package.json");
const sdk = json("../sdk/package.json");

describe("SDK workspace package", () => {
  it("stays private until the project has a licence", () => {
    // npm refuses to publish a private package; lift this only with a licence chosen and reviewed.
    expect(sdk.private).toBe(true);
    expect(sdk.license).toBeUndefined();
    expect(root.workspaces).toEqual(["sdk"]);
  });

  it("depends on exactly the versions the repository pins", () => {
    for (const [name, version] of Object.entries(sdk.dependencies)) expect(root.dependencies[name]).toBe(version);
  });

  it("ships only the bundles, declarations, pinned Python sources and README", () => {
    expect(sdk.files).toEqual(["dist", "public/qsb", "README.md"]);
    expect(sdk.bin).toEqual({ qsb: "./dist/cli.js" });
    expect(sdk.exports).toEqual({ ".": { types: "./dist/types/sdk/index.d.ts", default: "./dist/index.js" } });
  });
});
