import { describe, expect, test } from "vitest";
import {
  charsetClassCount,
  hasLettersAndDigits,
  isCredentialValue,
  isJwt,
  isNotReservedIpv4,
  isPlausibleChinesePhone,
  isPlausibleEmail,
  isValidChineseId,
  isValidIban,
  isValidUscc,
  looksLikePlaceholder,
  looksReal,
  passesLuhn,
  shannonEntropy,
} from "@/lib/redaction/validators";

describe("redaction validators", () => {
  test("shannonEntropy", () => {
    expect(shannonEntropy("")).toBe(0);
    expect(shannonEntropy("aaaa")).toBe(0);
    expect(shannonEntropy("ab")).toBeCloseTo(1);
    expect(shannonEntropy("9fK2mQ9vL4pX7rT1wZ3yB6nC")).toBeGreaterThan(4);
  });

  test("passesLuhn", () => {
    expect(passesLuhn("4111 1111 1111 1111")).toBe(true);
    expect(passesLuhn("4111-1111-1111-1112")).toBe(false);
    expect(passesLuhn("1234")).toBe(false);
  });

  test("isValidChineseId", () => {
    expect(isValidChineseId("11010519491231002X")).toBe(true);
    expect(isValidChineseId("11010519491231002x")).toBe(true);
    expect(isValidChineseId("110105194912310021")).toBe(false);
    expect(isValidChineseId("990105194912310026")).toBe(false);
    expect(isValidChineseId("110105194902300021")).toBe(false);
    expect(isValidChineseId("12345")).toBe(false);
  });

  test("isPlausibleChinesePhone", () => {
    expect(isPlausibleChinesePhone("13912345678")).toBe(true);
    expect(isPlausibleChinesePhone("13800000000")).toBe(false);
  });

  test("isValidUscc and isValidIban", () => {
    expect(isValidUscc("91350100M000100Y43")).toBe(true);
    expect(isValidUscc("91350100M000100Y44")).toBe(false);
    expect(isValidUscc("short")).toBe(false);
    expect(isValidIban("GB82 WEST 1234 5698 7654 32")).toBe(true);
    expect(isValidIban("GB82 WEST 1234 5698 7654 33")).toBe(false);
    expect(isValidIban("not an iban")).toBe(false);
  });

  test("looksLikePlaceholder", () => {
    for (const value of [
      "",
      "your_api_key_here",
      "${API_KEY}",
      "{{token}}",
      "$TOKEN",
      "%TOKEN%",
      "<token>",
      "process.env.TOKEN",
      "aaaaaaaa",
      "abababab",
      "changeme",
      "[REDACTED:SECRET#abcd1234]",
    ]) {
      expect(looksLikePlaceholder(value), value).toBe(true);
    }
    expect(looksLikePlaceholder("Xk9#mQ2$vL7pR4wT")).toBe(false);
  });

  test("looksReal / hasLettersAndDigits / charsetClassCount", () => {
    expect(looksReal("AKIA" + "IOSFODNN7EXAMPLE")).toBe(false);
    expect(looksReal("sk-xxxxxxxxxxxxxxxx")).toBe(false);
    expect(looksReal("9fK2mQ9vL4pX")).toBe(true);
    expect(hasLettersAndDigits("abc123")).toBe(true);
    expect(hasLettersAndDigits("abcdef")).toBe(false);
    expect(charsetClassCount("aB1")).toBe(3);
    expect(charsetClassCount("----")).toBe(0);
  });

  test("isCredentialValue", () => {
    expect(isCredentialValue("Xk9#mQ2$vL7pR4wT")).toBe(true);
    expect(isCredentialValue("password")).toBe(false);
    expect(isCredentialValue("short")).toBe(false);
    expect(isCredentialValue("${DB_PASSWORD}")).toBe(false);
    expect(isCredentialValue("config.database.password")).toBe(false);
    expect(isCredentialValue("getPassword()")).toBe(false);
    expect(isCredentialValue("os.environ.get")).toBe(false);
    expect(isCredentialValue("abcdefghijkl")).toBe(false);
    expect(isCredentialValue("aaaaaaaa1")).toBe(false);
  });

  test("isJwt", () => {
    expect(
      isJwt(
        "eyJ" +
          "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
      )
    ).toBe(true);
    expect(isJwt("eyJub3RhbGciOnRydWV9.eyJhIjoxfQ.abcdefgh")).toBe(false);
    expect(isJwt("eyJ!!!.x.y")).toBe(false);
  });

  test("isPlausibleEmail", () => {
    expect(isPlausibleEmail("zhang.san@acme-corp.cn")).toBe(true);
    expect(isPlausibleEmail("logo@2x.png")).toBe(false);
    expect(isPlausibleEmail("noreply@anthropic.com")).toBe(false);
    expect(isPlausibleEmail("dev@example.com")).toBe(false);
    expect(isPlausibleEmail("12345+bot@users.noreply.github.com")).toBe(false);
    expect(isPlausibleEmail("a..b@acme.cn")).toBe(false);
    expect(isPlausibleEmail("@acme.cn")).toBe(false);
  });

  test("isNotReservedIpv4", () => {
    expect(isNotReservedIpv4("203.0.113.42")).toBe(true);
    expect(isNotReservedIpv4("127.0.0.1")).toBe(false);
    expect(isNotReservedIpv4("0.0.0.0")).toBe(false);
    expect(isNotReservedIpv4("255.255.255.255")).toBe(false);
  });
});
