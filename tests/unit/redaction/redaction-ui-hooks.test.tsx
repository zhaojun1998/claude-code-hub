/**
 * @vitest-environment happy-dom
 */

import { afterEach, describe, expect, test } from "vitest";
import { useRedactionRuleName } from "@/app/[locale]/dashboard/logs/_components/redaction/use-rule-name";
import { useRedactionError } from "@/app/[locale]/settings/redaction/_components/use-redaction-error";
import { BUILTIN_RULES } from "@/lib/redaction/builtin-rules";
import { cleanup, redactionMessages, render } from "./ui-helpers";

afterEach(async () => {
  expect(await cleanup()).toEqual([]);
});

function HookProbe({ useValue }: { useValue: () => unknown }) {
  return <output>{JSON.stringify(useValue())}</output>;
}

/** Renders a hook result as JSON so the test can read it back from the DOM. */
async function evaluate<T>(useValue: () => T): Promise<T> {
  const { container } = await render(<HookProbe useValue={useValue} />);
  return JSON.parse(container.querySelector("output")?.textContent ?? "null") as T;
}

describe("useRedactionError", () => {
  const errorCodes = Object.keys(redactionMessages.errors).filter((code) => code !== "UNKNOWN");

  test("translates every documented error code to its own message", async () => {
    const messages = await evaluate(() => {
      const describeError = useRedactionError();
      return errorCodes.map((errorCode) => describeError({ errorCode }));
    });

    expect(messages).toEqual(errorCodes.map((code) => redactionMessages.errors[code]));
    expect(messages).toContain("Exact values must have at least 4 characters");
    expect(new Set(messages).size).toBe(errorCodes.length);
  });

  test("falls back to UNKNOWN for missing, unknown and raw transport codes", async () => {
    const messages = await evaluate(() => {
      const describeError = useRedactionError();
      return [
        describeError({}),
        describeError({ errorCode: "" }),
        describeError({ errorCode: "NOT_A_CODE" }),
        describeError({ errorCode: "auth.invalid" }),
        describeError({ errorCode: "UNKNOWN" }),
      ];
    });

    expect(messages).toEqual(Array(5).fill("Operation failed"));
  });
});

describe("useRedactionRuleName", () => {
  test("localizes built-in rule ids and keeps stored names for everything else", async () => {
    const names = await evaluate(() => {
      const ruleName = useRedactionRuleName();
      return [
        ruleName("builtin:aws_access_key_id", "server name"),
        ruleName("builtin:cn_id_card", "server name"),
        ruleName("builtin:no_such_rule", "Fallback built-in"),
        ruleName("custom:12", "My custom rule"),
        ruleName("jev:4", "Discovered by Jev"),
        ruleName("aws_access_key_id", "Bare slug is not a built-in id"),
      ];
    });

    expect(names).toEqual([
      "AWS access key ID",
      "China resident ID number",
      "Fallback built-in",
      "My custom rule",
      "Discovered by Jev",
      "Bare slug is not a built-in id",
    ]);
  });

  test("has a translation for every shipped built-in rule", async () => {
    const names = await evaluate(() => {
      const ruleName = useRedactionRuleName();
      return BUILTIN_RULES.map((rule) => ruleName(rule.id, "MISSING"));
    });

    expect(names).not.toContain("MISSING");
    expect(names).toHaveLength(BUILTIN_RULES.length);
  });
});
