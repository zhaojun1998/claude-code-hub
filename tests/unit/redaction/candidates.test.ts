import { describe, expect, test } from "vitest";
import {
  deriveTokenPattern,
  describeCandidateShape,
  extractCandidates,
  hashCandidateValue,
  isPlausibleSecretValue,
  maskValue,
} from "@/lib/redaction/candidates";

describe("discovery candidates", () => {
  test("finds secret-looking assignments, random tokens and URL passwords", () => {
    const text = [
      "INTERNAL_SERVICE_TOKEN=q8Zr3Kd7Lm2Np9Xw4Yv6",
      "trace blob 7fGh2Jk9Lm4Np6Qr8St0Uv2Wx4Yz6Ab8Cd0Ef end",
      "redis://default:Sup3rS3cretPw@cache.local:6379",
    ].join("\n");
    const candidates = extractCandidates(text, "messages[0].content");
    const hints = candidates.map((candidate) => candidate.hint).sort();
    expect(hints).toEqual(["assignment", "high_entropy", "url_credential"]);
    const assignment = candidates.find((candidate) => candidate.hint === "assignment")!;
    expect(assignment.keyName).toBe("INTERNAL_SERVICE_TOKEN");
    expect(assignment.value).toBe("q8Zr3Kd7Lm2Np9Xw4Yv6");
    expect(text.slice(assignment.start, assignment.end)).toBe(assignment.value);
    expect(assignment.valueHash).toBe(hashCandidateValue(assignment.value));
    const url = candidates.find((candidate) => candidate.hint === "url_credential")!;
    expect(url.value).toBe("Sup3rS3cretPw");
  });

  test("skips covered spans and masks them in context", () => {
    const text = "a sk-proj-xyz then token=Zq8vN2kLm4Pt7Rx1Wc9Y";
    const coveredStart = text.indexOf("sk-proj-xyz");
    const candidates = extractCandidates(text, "p", [
      { start: coveredStart, end: coveredStart + "sk-proj-xyz".length, ruleIndex: 0 },
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].contextBefore).toContain("[MASKED]");
    expect(candidates[0].contextBefore).not.toContain("sk-proj-xyz");
    const value = "Zq8vN2kLm4Pt7Rx1Wc9Y";
    const fully = extractCandidates(text, "p", [
      { start: text.indexOf(value), end: text.indexOf(value) + value.length, ruleIndex: 0 },
    ]);
    expect(fully).toHaveLength(0);
  });

  test.each([
    ["uuid", "id: 123e4567-e89b-12d3-a456-426614174000"],
    ["git sha", "commit 3f9a2c7e1b5d8f0a4c6e2b9d7f1a3c5e8b0d2f4a"],
    ["path", "see /usr/local/lib/node_modules/some-package/dist/index.js"],
    ["identifier", "useCallbackWithDependencyTracking"],
    ["placeholder", "API_KEY=your_api_key_here"],
    ["env reference", "password=$DB_PASSWORD"],
    ["dotted name", "token = request.headers.authorization"],
    ["version", "version: v1.2.3-beta.4+build.5"],
    ["short text", "abc"],
  ])("ignores %s", (_label, text) => {
    expect(extractCandidates(text, "p")).toEqual([]);
  });

  test("isPlausibleSecretValue edge cases", () => {
    expect(isPlausibleSecretValue("short", "assignment")).toBe(false);
    expect(isPlausibleSecretValue("true", "assignment")).toBe(false);
    expect(isPlausibleSecretValue("abcdefgh", "assignment")).toBe(false);
    expect(isPlausibleSecretValue("Xk9#mQ2$vL7pR4wT", "assignment")).toBe(true);
    expect(isPlausibleSecretValue("Xk9#mQ2$vL7pR4wT", "url_credential")).toBe(true);
    expect(isPlausibleSecretValue("a".repeat(300), "high_entropy")).toBe(false);
  });

  test("shape description never contains the middle of the value", () => {
    const value = "acme_live_Q8zR3kD7lM2nP9xW4yV6bT1c";
    const shape = describeCandidateShape(value);
    expect(shape).toContain('starts with "acme"');
    expect(shape).toContain(`${value.length} chars`);
    expect(shape).not.toContain(value.slice(5, 20));
    expect(describeCandidateShape("abc123")).toContain('starts with "a"');
  });

  test("maskValue", () => {
    expect(maskValue("abc")).toBe("a***");
    expect(maskValue("sk-proj-" + "Ab3dE5gH7jK9mN1pQ3sT5vW7")).toMatch(
      /^sk-p…[A-Za-z0-9]{3} \(32\)$/
    );
  });

  test("deriveTokenPattern generalizes vendor-prefixed tokens", () => {
    const pattern = deriveTokenPattern("acme_Q8zR3kD7lM2nP9xW4yV6bT1c");
    expect(pattern).not.toBeNull();
    const regex = new RegExp(pattern!);
    expect(regex.test("x acme_Z9yX8wV7uT6sR5qP4oN3mL2k y")).toBe(true);
    expect(regex.test("acme_short")).toBe(false);
    expect(deriveTokenPattern("no-prefix-but-long-value")).toBeNull();
    expect(deriveTokenPattern("ab_aaaaaaaaaaaaaaaaaaaa")).toBeNull();
  });
});
