import { describe, expect, it } from "vitest";
import { BatchWriteItemCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import {
  canonical,
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

  it("refuses a destination holding anything that isn't in the source", async () => {
    const { source, dest } = tables();
    dest.items = [{ pk: { S: "SESSION#other" }, sk: { S: "x" } }];
    await expect(copyRecords(source, "old", dest, "new", true, noPause)).rejects.toThrow("aren't in the source");
    expect(dest.writes).toBe(0);
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
  it("skips sessions and challenges, which DynamoDB may delete on its own at any time", async () => {
    const { source, dest } = tables(10);
    source.items.push({ pk: { S: "SESSION#s" }, sk: { S: "x" }, expiresAt: { N: "1" } });
    dest.items.push({ pk: { S: "CHALLENGE#c" }, sk: { S: "y" }, expiresAt: { N: "2" } });
    let scans = 0;
    // A TTL delete in the source between scans must not fail the copy.
    source.onScan = () => {
      if (++scans === 3) source.items = source.items.filter((item) => !item.expiresAt);
    };
    const result = await copyRecords(source, "old", dest, "new", true, noPause);
    expect(result).toMatchObject({ items: 10, skippedEphemeral: 1, copied: true });
    expect(dest.items.filter((item) => item.pk?.S?.startsWith("SESSION#"))).toHaveLength(0);
  });
});

describe("unexpected TTL rows", () => {
  it("stops instead of skipping a durable row that carries a TTL", async () => {
    const { source, dest } = tables(5);
    source.items.push({ pk: { S: "OWNER#placeholder" }, sk: { S: "VAULT#x" }, expiresAt: { N: "9" } });
    await expect(copyRecords(source, "old", dest, "new", false, noPause)).rejects.toThrow("OWNER row has a TTL");
    expect(dest.writes).toBe(0);
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

describe("parseTarget", () => {
  it("accepts REGION:TABLE only", () => {
    expect(parseTarget("eu-west-2:qsb-app-records", "--to")).toEqual({ region: "eu-west-2", table: "qsb-app-records" });
    for (const bad of [undefined, "", "qsb-app-records", "eu-west-2", "London:qsb", "eu-west-2:a b"])
      expect(() => parseTarget(bad, "--to")).toThrow("REGION:TABLE");
  });
});
