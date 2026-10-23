import { describe, expect, test, vi } from "vitest";
import { BUILTIN_RULES } from "@/lib/redaction/builtin-rules";
import { RedactionEngine } from "@/lib/redaction/engine";
import {
  findingKey,
  fingerprintText,
  MemorySeenStore,
  RedisSeenStore,
  type RedisLike,
  scopeKey,
  selectNewRedactions,
} from "@/lib/redaction/incremental";
import { redactBodyInPlace, SegmentMatchCache } from "@/lib/redaction/redact-body";

const KEY = "sk-proj-" + "Ab3dE5gH7jK9mN1pQ3sT5vW7yZ9bC2eF4hJ6kL8nP0rS2uV";
const engine = new RedactionEngine([...BUILTIN_RULES], { salt: "salt" });

function turn(messages: Array<{ role: string; content: string }>) {
  return { model: "claude", messages: structuredClone(messages) };
}

describe("incremental findings", () => {
  test("MemorySeenStore reports each key once per scope and expires", async () => {
    let now = 0;
    const store = new MemorySeenStore(2, 2, () => now);
    expect([...(await store.addNew("s1", ["a", "b"], 10))]).toEqual(["a", "b"]);
    expect([...(await store.addNew("s1", ["a", "c"], 10))]).toEqual(["c"]);
    expect([...(await store.addNew("s2", ["a"], 10))]).toEqual(["a"]);
    now = 11_000;
    expect([...(await store.addNew("s1", ["a"], 10))]).toEqual(["a"]);
    // Capacity eviction of scopes
    await store.addNew("s3", ["x"], 10);
    await store.addNew("s4", ["x"], 10);
    expect([...(await store.addNew("s1", ["a"], 10))]).toEqual(["a"]);
  });

  test("RedisSeenStore uses SADD results and falls back on errors", async () => {
    const members = new Set<string>();
    const client: RedisLike = {
      status: "ready",
      pipeline() {
        const ops: Array<() => [Error | null, unknown]> = [];
        return {
          sadd(_key: string, member: string) {
            ops.push(() => {
              const added = !members.has(member);
              members.add(member);
              return [null, added ? 1 : 0];
            });
          },
          expire() {
            ops.push(() => [null, 1]);
          },
          async exec() {
            return ops.map((op) => op());
          },
        };
      },
    };
    const store = new RedisSeenStore(() => client);
    expect([...(await store.addNew("s", ["a", "b"], 60))]).toEqual(["a", "b"]);
    expect([...(await store.addNew("s", ["b", "c"], 60))]).toEqual(["c"]);
    expect([...(await store.addNew("s", [], 60))]).toEqual([]);

    const fallback = { addNew: vi.fn(async () => new Set(["z"])) };
    const broken = new RedisSeenStore(
      () =>
        ({
          status: "ready",
          pipeline() {
            throw new Error("down");
          },
        }) as unknown as RedisLike,
      fallback
    );
    expect([...(await broken.addNew("s", ["z"], 60))]).toEqual(["z"]);
    const offline = new RedisSeenStore(() => null, fallback);
    await offline.addNew("s", ["z"], 60);
    const connecting = new RedisSeenStore(() => ({ ...client, status: "connecting" }), fallback);
    await connecting.addNew("s", ["z"], 60);
    const nullExec = new RedisSeenStore(
      () => ({
        status: "ready",
        pipeline: () => ({ sadd() {}, expire() {}, exec: async () => null }),
      }),
      fallback
    );
    await nullExec.addNew("s", ["z"], 60);
    expect(fallback.addNew).toHaveBeenCalledTimes(4);
    expect(scopeKey("session:abc")).toMatch(/^cch:redaction:seen:[0-9a-f]{32}$/);
  });

  test("a conversation only reports values that are new in each request", async () => {
    const store = new MemorySeenStore();
    const cache = new SegmentMatchCache();
    const scope = "session:abc";

    const history = [{ role: "user", content: `my key is ${KEY}` }];
    const first = redactBodyInPlace(turn(history), engine, cache);
    expect(first.redactions).toHaveLength(1);
    expect(await selectNewRedactions(store, scope, first.redactions, 3600)).toHaveLength(1);

    // Turn 2 re-sends turn 1: the key is redacted again but not reported again.
    history.push({ role: "assistant", content: "ok" }, { role: "user", content: "thanks" });
    const secondBody = turn(history);
    const second = redactBodyInPlace(secondBody, engine, cache);
    expect(second.redactions).toHaveLength(1);
    expect(JSON.stringify(secondBody)).not.toContain(KEY);
    expect(await selectNewRedactions(store, scope, second.redactions, 3600)).toHaveLength(0);

    // Turn 3 pastes the key again in a new message: that new occurrence is reported.
    history.push({ role: "assistant", content: "sure" }, { role: "user", content: `again ${KEY}` });
    const third = redactBodyInPlace(turn(history), engine, cache);
    expect(third.redactions).toHaveLength(2);
    const fresh = await selectNewRedactions(store, scope, third.redactions, 3600);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].path).toBe("messages[4].content");

    // After compaction the summary is new text, so its values are reported again.
    const compacted = [{ role: "user", content: `Summary: the user shared ${KEY} earlier.` }];
    const afterCompaction = redactBodyInPlace(turn(compacted), engine, cache);
    expect(await selectNewRedactions(store, scope, afterCompaction.redactions, 3600)).toHaveLength(
      1
    );
  });

  test("duplicates inside one request are reported once", async () => {
    const body = turn([
      { role: "user", content: `k=${KEY}` },
      { role: "user", content: `k=${KEY}` },
    ]);
    const result = redactBodyInPlace(body, engine);
    expect(result.redactions).toHaveLength(2);
    expect(findingKey(result.redactions[0])).toBe(findingKey(result.redactions[1]));
    expect(
      await selectNewRedactions(new MemorySeenStore(), "s", result.redactions, 60)
    ).toHaveLength(1);
    expect(await selectNewRedactions(new MemorySeenStore(), "s", [], 60)).toEqual([]);
  });

  test("fingerprintText is stable", () => {
    expect(fingerprintText("a")).toBe(fingerprintText("a"));
    expect(fingerprintText("a")).not.toBe(fingerprintText("b"));
  });
});
