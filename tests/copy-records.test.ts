import { afterEach, describe, expect, it, vi } from "vitest";
import { BatchWriteItemCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonical,
  clientFor,
  copyRecords,
  digest,
  parseTarget,
  type Item,
  type TableClient,
} from "../scripts/copy-records";

/** An in-memory table that pages scans and can drop or delay writes. */
class FakeTable implements TableClient {
  items: Item[] = [];
  writes = 0;
  unprocessedOnce = 0;
  dropKey?: string;
  onScan?: () => void;
  constructor(private name: string, private pageSize = 7) {}
  private key = (item: Item) => `${item.pk?.S}|${item.sk?.S}`;
  put(item: Item) {
    if (this.dropKey === this.key(item)) return;
    this.items = this.items.filter((existing) => this.key(existing) !== this.key(item));
    this.items.push(item);
  }
  async send(command: ScanCommand | BatchWriteItemCommand): Promise<unknown> {
    if (command instanceof ScanCommand) {
      this.onScan?.();
      const start = Number(command.input.ExclusiveStartKey?.i?.N ?? 0);
      const end = start + this.pageSize;
      return {
        Items: this.items.slice(start, end),
        LastEvaluatedKey: end < this.items.length ? { i: { N: String(end) } } : undefined,
      };
    }
    this.writes++;
    const puts = command.input.RequestItems![this.name];
    const accepted = this.unprocessedOnce-- > 0 ? puts.slice(0, 1) : puts;
    for (const put of accepted) this.put(put.PutRequest!.Item as Item);
    const rest = puts.slice(accepted.length);
    return { UnprocessedItems: rest.length ? { [this.name]: rest } : {} };
  }
}

const rows = (n: number): Item[] =>
  Array.from({ length: n }, (_, i) => ({
    pk: { S: i % 3 === 0 ? `SYSTEM#s${i}` : `OWNER#placeholder${i % 2}` },
    sk: { S: `VAULT#${i}` },
    version: { N: String(i) },
    tags: { SS: ["b", "a"] },
  }));
const tables = (n = 30) => {
  const source = new FakeTable("old"), dest = new FakeTable("new");
  source.items = rows(n);
  return { source, dest };
};
const noPause = async () => {};

describe("copyRecords", () => {
  it("only counts without --apply", async () => {
    const { source, dest } = tables();
    const result = await copyRecords(source, "old", dest, "new", false, noPause);
    expect(result).toMatchObject({ items: 30, copied: false, prefixes: { SYSTEM: 10, OWNER: 20 } });
    expect(dest.writes).toBe(0);
    expect(result.digest).toBe(digest(source.items));
  });

  it("copies every page in batches of 25 and verifies the result", async () => {
    const { source, dest } = tables(30);
    const result = await copyRecords(source, "old", dest, "new", true, noPause);
    expect(result.copied).toBe(true);
    expect(dest.writes).toBe(2);
    expect(digest(dest.items)).toBe(digest(source.items));
  });

  it("resumes safely over a partial earlier copy", async () => {
    const { source, dest } = tables();
    dest.items = source.items.slice(0, 5);
    expect((await copyRecords(source, "old", dest, "new", true, noPause)).copied).toBe(true);
    expect(dest.items).toHaveLength(30);
  });

  it("refuses a destination row whose key isn't in the source", async () => {
    const { source, dest } = tables();
    dest.items = [{ pk: { S: "OWNER#other" }, sk: { S: "x" } }];
    await expect(copyRecords(source, "old", dest, "new", true, noPause)).rejects.toThrow("keys aren't in the source (OWNER)");
    expect(dest.writes).toBe(0);
  });

  it("resumes over a stale copy of a row the source has since changed", async () => {
    const { source, dest } = tables();
    dest.items = [{ ...source.items[4], version: { N: "999" } }];
    expect((await copyRecords(source, "old", dest, "new", true, noPause)).copied).toBe(true);
    expect(digest(dest.items)).toBe(digest(source.items));
  });

  it("retries unprocessed items with a pause", async () => {
    const { source, dest } = tables();
    dest.unprocessedOnce = 1;
    const pauses: number[] = [];
    await copyRecords(source, "old", dest, "new", true, async (ms) => void pauses.push(ms));
    expect(pauses).toEqual([200]);
    expect(dest.items).toHaveLength(30);
  });

  it("fails if the source changes during the copy", async () => {
    const { source, dest } = tables();
    let scans = 0;
    source.onScan = () => {
      if (++scans === 6) source.items.push({ pk: { S: "OWNER#late" }, sk: { S: "x" } });
    };
    await expect(copyRecords(source, "old", dest, "new", true, noPause)).rejects.toThrow("source changed");
  });

  it("fails verification if an item didn't land", async () => {
    const { source, dest } = tables();
    dest.dropKey = "SYSTEM#s0|VAULT#0";
    await expect(copyRecords(source, "old", dest, "new", true, noPause)).rejects.toThrow("Verification failed");
  });
});

describe("TTL rows", () => {
  const NOW = 1_900_000_000;

  it("skips sessions and challenges, which the new stack doesn't need", async () => {
    const { source, dest } = tables(10);
    source.items.push({ pk: { S: "SESSION#s" }, sk: { S: "x" }, expiresAt: { N: String(NOW + 86400) } });
    dest.items.push({ pk: { S: "CHALLENGE#c" }, sk: { S: "y" }, expiresAt: { N: String(NOW + 300) } });
    const result = await copyRecords(source, "old", dest, "new", true, noPause, NOW);
    expect(result).toMatchObject({ items: 10, skipped: 1, copied: true });
    expect(dest.items.filter((item) => item.pk?.S?.startsWith("SESSION#"))).toHaveLength(0);
  });

  it("copies other rows with a TTL, such as owner events and API keys", async () => {
    const { source, dest } = tables(5);
    const event = { pk: { S: "OWNER#placeholder" }, sk: { S: "EVENT#1" }, expiresAt: { N: String(NOW + 30 * 86400) } };
    const key = { pk: { S: "APIKEY#placeholder" }, sk: { S: "KEY" }, expiresAt: { N: String(NOW + 90 * 86400) } };
    source.items.push(event, key);
    const result = await copyRecords(source, "old", dest, "new", true, noPause, NOW);
    expect(result).toMatchObject({ items: 7, skipped: 0, copied: true });
    expect(dest.items).toContainEqual(event);
    expect(dest.items).toContainEqual(key);
  });

  it("leaves out rows DynamoDB may delete mid-copy, so a TTL delete can't fail it", async () => {
    const { source, dest } = tables(10);
    // Already expired but not yet deleted, and expiring within the margin.
    source.items.push({ pk: { S: "OWNER#placeholder" }, sk: { S: "EVENT#old" }, expiresAt: { N: String(NOW - 60) } });
    source.items.push({ pk: { S: "OWNER#placeholder" }, sk: { S: "EVENT#soon" }, expiresAt: { N: String(NOW + 600) } });
    let scans = 0;
    // A TTL delete in the source between scans must not fail the copy.
    source.onScan = () => {
      if (++scans === 3) source.items = source.items.filter((item) => item.sk?.S !== "EVENT#old");
    };
    const result = await copyRecords(source, "old", dest, "new", true, noPause, NOW);
    expect(result).toMatchObject({ items: 10, skipped: 2, copied: true });
    expect(dest.items.filter((item) => item.sk?.S?.startsWith("EVENT#"))).toHaveLength(0);
  });
});

describe("canonical encoding", () => {
  it("ignores key and set order, and encodes binary values", () => {
    const a: Item = { sk: { S: "1" }, pk: { S: "p" }, s: { SS: ["x", "y"] }, b: { B: Uint8Array.of(1, 2) } };
    const b: Item = { pk: { S: "p" }, b: { B: Uint8Array.of(1, 2) }, s: { SS: ["y", "x"] }, sk: { S: "1" } };
    expect(canonical(a)).toBe(canonical(b));
    expect(canonical(a)).not.toBe(canonical({ ...a, b: { B: Uint8Array.of(2, 1) } }));
  });
});

describe("clientFor", () => {
  const dir = mkdtempSync(join(tmpdir(), "copy-records-"));
  afterEach(() => vi.unstubAllEnvs());
  it("gives each side the credentials of its own profile", async () => {
    // Two fake profiles whose credential_process prints different placeholder keys; nothing real is read.
    const script = join(dir, "fake-credentials.sh");
    writeFileSync(script, `#!/bin/sh\nprintf '{"Version":1,"AccessKeyId":"AKIAFAKE%s","SecretAccessKey":"placeholder"}' "$1"\n`);
    chmodSync(script, 0o755);
    const config = join(dir, "config");
    writeFileSync(config, `[profile side-a]\ncredential_process = ${script} AAAA\n[profile side-b]\ncredential_process = ${script} BBBB\n`);
    for (const name of ["AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) vi.stubEnv(name, "");
    vi.stubEnv("AWS_CONFIG_FILE", config);
    vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", join(dir, "none"));
    const a = await clientFor("eu-west-1", "side-a").config.credentials();
    const b = await clientFor("eu-west-2", "side-b").config.credentials();
    expect([a.accessKeyId, b.accessKeyId]).toEqual(["AKIAFAKEAAAA", "AKIAFAKEBBBB"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("parseTarget", () => {
  it("accepts REGION:TABLE only", () => {
    expect(parseTarget("eu-west-2:qsb-app-records", "--to")).toEqual({ region: "eu-west-2", table: "qsb-app-records" });
    for (const bad of [undefined, "", "qsb-app-records", "eu-west-2", "London:qsb", "eu-west-2:a b"])
      expect(() => parseTarget(bad, "--to")).toThrow("REGION:TABLE");
  });
});
