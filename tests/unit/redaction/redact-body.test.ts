import { describe, expect, test } from "vitest";
import { BUILTIN_RULES } from "@/lib/redaction/builtin-rules";
import { RedactionEngine } from "@/lib/redaction/engine";
import {
  applyBodyScan,
  redactBodyInPlace,
  scanBody,
  SegmentMatchCache,
} from "@/lib/redaction/redact-body";

const engine = new RedactionEngine([...BUILTIN_RULES], { salt: "salt" });
const TOKEN = "ghp_" + "R4nD0mT0k3nV4lu3F0rT3st1ng0nlyAbCdEf";

describe("redactBodyInPlace", () => {
  test("rewrites content strings and leaves protocol fields alone", () => {
    const body = {
      model: "claude",
      messages: [
        { role: "user", content: `push with ${TOKEN} please` },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Bash",
              input: { command: `git push https://x:${TOKEN}@github.com/a/b` },
            },
          ],
        },
      ],
    };
    const result = redactBodyInPlace(body, engine);
    expect(result.changed).toBe(true);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(body.messages[1].content[0].id).toBe("toolu_1");
    expect(result.redactions.map((r) => r.path)).toEqual([
      "messages[0].content",
      "messages[1].content[0].input.command",
    ]);
    const first = result.redactions[0];
    expect(first.contextBefore).toBe("push with ");
    expect(first.contextAfter).toBe(" please");
    expect(first.original).toBe(TOKEN);
    expect(result.segmentCount).toBe(2);
  });

  test("cache: second scan of the same text is not fresh", () => {
    const cache = new SegmentMatchCache(2);
    const body = () => ({ messages: [{ role: "user", content: `t ${TOKEN}` }] });
    expect(redactBodyInPlace(body(), engine, cache).freshSegments).toHaveLength(1);
    expect(redactBodyInPlace(body(), engine, cache).freshSegments).toHaveLength(0);
    expect(cache.size).toBe(1);
    cache.set("a", []);
    cache.set("b", []);
    expect(cache.size).toBe(2);
    cache.set("b", []);
    expect(cache.get("a")).toEqual([]);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  test("scan then apply; unchanged bodies report nothing", () => {
    const body = { messages: [{ role: "user", content: "nothing secret here" }] };
    const scan = scanBody(body, engine);
    expect(scan.freshSegments).toHaveLength(1);
    expect(applyBodyScan(scan)).toEqual({ changed: false, redactions: [] });
  });
});
