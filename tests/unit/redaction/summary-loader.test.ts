import { describe, expect, test, vi } from "vitest";

vi.mock("@/lib/redaction/client-api", () => ({
  redactionApi: {
    getSummaries: vi.fn(async (ids: number[]) => ({
      ok: true,
      data: ids
        .filter((id) => id % 2 === 0)
        .map((id) => ({ messageRequestId: id, newCount: 1, totalCount: 2 })),
    })),
  },
}));

import {
  createSummaryLoader,
  redactionSummaryLoader,
} from "@/app/[locale]/dashboard/logs/_components/redaction/summary-loader";

describe("redaction summary loader", () => {
  test("batches lookups and caches results", async () => {
    const fetcher = vi.fn(async (ids: number[]) =>
      ids
        .filter((id) => id !== 2)
        .map((id) => ({ messageRequestId: id, newCount: id, totalCount: id }))
    );
    let now = 0;
    const loader = createSummaryLoader(fetcher, () => now);
    const [a, b, c] = await Promise.all([loader.load(1), loader.load(2), loader.load(1)]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith([1, 2]);
    expect(a?.newCount).toBe(1);
    expect(b).toBeNull();
    expect(c).toEqual(a);

    expect(loader.peek(1)?.newCount).toBe(1);
    expect(loader.peek(2)).toBeNull();
    expect(loader.peek(3)).toBeUndefined();
    await loader.load(1);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Empty results expire so in-flight requests are looked up again.
    now = 20_000;
    expect(loader.peek(2)).toBeUndefined();
    await loader.load(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("fetch errors resolve to null", async () => {
    const loader = createSummaryLoader(async () => {
      throw new Error("offline");
    });
    expect(await loader.load(5)).toBeNull();
  });

  test("default loader uses the server action", async () => {
    expect(await redactionSummaryLoader.load(4)).toMatchObject({ messageRequestId: 4 });
    expect(await redactionSummaryLoader.load(3)).toBeNull();
  });
});
