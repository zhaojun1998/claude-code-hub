import { describe, expect, test } from "vitest";
import { BUILTIN_RULES, isBuiltinRuleEnabled } from "@/lib/redaction/builtin-rules";
import { compileRuleRegex, RedactionEngine } from "@/lib/redaction/engine";

const SALT = "test-salt";

function engineFor(ruleId: string) {
  const rule = BUILTIN_RULES.find((item) => item.id === ruleId);
  if (!rule) throw new Error(`missing rule ${ruleId}`);
  return new RedactionEngine([rule], { salt: SALT });
}

function allEnabledEngine() {
  return new RedactionEngine([...BUILTIN_RULES], { salt: SALT });
}

describe("built-in redaction rules", () => {
  test("ids are unique and every pattern compiles", () => {
    const ids = BUILTIN_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of BUILTIN_RULES) {
      expect(typeof compileRuleRegex(rule), rule.id).not.toBe("string");
      expect(rule.id.startsWith("builtin:")).toBe(true);
      expect(rule.label).toMatch(/^[A-Z0-9_]+$/);
    }
  });

  test.each(BUILTIN_RULES.map((rule) => [rule.id, rule.example] as const))(
    "%s matches its own example",
    (ruleId, example) => {
      expect(example).toBeTruthy();
      const engine = engineFor(ruleId);
      const matches = engine.findMatches(`prefix ${example} suffix`);
      expect(matches.length, ruleId).toBeGreaterThan(0);
    }
  );

  test("defaults: secrets on, noisy rules off", () => {
    const enabled = (id: string) =>
      isBuiltinRuleEnabled(BUILTIN_RULES.find((rule) => rule.id === id)!, {});
    expect(enabled("builtin:openai_api_key")).toBe(true);
    expect(enabled("builtin:cn_id_card")).toBe(true);
    expect(enabled("builtin:email")).toBe(false);
    expect(enabled("builtin:ipv4")).toBe(false);
    const email = BUILTIN_RULES.find((rule) => rule.id === "builtin:email")!;
    expect(isBuiltinRuleEnabled(email, { "builtin:email": true })).toBe(true);
    const openai = BUILTIN_RULES.find((rule) => rule.id === "builtin:openai_api_key")!;
    expect(isBuiltinRuleEnabled(openai, { "builtin:openai_api_key": false })).toBe(false);
  });

  test("assignment rules mask only the value", () => {
    const engine = engineFor("builtin:secret_assignment");
    const { text } = engine.redactText("DB_PASSWORD=Xk9#mQ2$vL7pR4wT\nDEBUG=true");
    expect(text).toMatch(/^DB_PASSWORD=\[REDACTED:SECRET#[0-9a-f]{8}\]\nDEBUG=true$/);
  });

  test("connection URL keeps user and host", () => {
    const engine = engineFor("builtin:connection_string_password");
    const { text } = engine.redactText("postgres://app:S3cr3tPassw0rd@db.internal:5432/app");
    expect(text).toMatch(
      /^postgres:\/\/app:\[REDACTED:PASSWORD#[0-9a-f]{8}\]@db\.internal:5432\/app$/
    );
  });

  test.each([
    ["documentation AWS key", "AKIA" + "IOSFODNN7EXAMPLE"],
    ["placeholder assignment", "api_key = your_api_key_here"],
    ["env reference", "password: ${DB_PASSWORD}"],
    ["code reference", "token = config.auth.token"],
    ["uuid", "id 123e4567-e89b-12d3-a456-426614174000"],
    ["git sha", "commit 3f9a2c7e1b5d8f0a4c6e2b9d7f1a3c5e8b0d2f4a"],
    ["phone-like timestamp", "ts=1712345678901"],
    ["invalid id checksum", "110105194912310021"],
    ["invalid card", "4111 1111 1111 1112"],
    ["sk- word", "use the sk-learn library"],
    ["no-reply email", "Co-Authored-By: Claude <noreply@anthropic.com>"],
  ])("does not mask %s", (_label, text) => {
    expect(allEnabledEngine().findMatches(text)).toEqual([]);
  });

  test("specific vendor rule wins over the generic assignment rule", () => {
    const engine = new RedactionEngine([...BUILTIN_RULES], { salt: SALT });
    const { redactions } = engine.redactText(
      "ANTHROPIC_API_KEY=sk-ant-" + "api03-Zq8vN2kLm4Pt7Rx1Wc9Yb3Hd6Fg0Js5Ue8Ai2Ko4Mn7Qp1Tr"
    );
    expect(redactions).toHaveLength(1);
    expect(redactions[0].ruleId).toBe("builtin:anthropic_api_key");
    expect(redactions[0].replacement).toMatch(/^\[REDACTED:ANTHROPIC_KEY#/);
  });
});
