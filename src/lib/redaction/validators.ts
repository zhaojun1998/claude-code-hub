/**
 * Match validators used by redaction rules to cut false positives.
 */

/** Shannon entropy in bits per character. */
export function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of text) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  const length = [...text].length;
  for (const count of counts.values()) {
    const p = count / length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Luhn checksum used by payment card numbers. Non-digit separators are ignored. */
export function passesLuhn(input: string): boolean {
  const digits = input.replace(/[\s-]/g, "");
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

const CN_ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const CN_ID_CHECK = "10X98765432";
const CN_PROVINCES = new Set([
  11, 12, 13, 14, 15, 21, 22, 23, 31, 32, 33, 34, 35, 36, 37, 41, 42, 43, 44, 45, 46, 50, 51, 52,
  53, 54, 61, 62, 63, 64, 65, 71, 81, 82, 83, 91,
]);

/** Validates an 18-digit mainland China resident identity number (region + date + checksum). */
export function isValidChineseId(input: string): boolean {
  const id = input.toUpperCase();
  if (!/^\d{17}[\dX]$/.test(id)) return false;
  if (!CN_PROVINCES.has(Number(id.slice(0, 2)))) return false;
  const year = Number(id.slice(6, 10));
  const month = Number(id.slice(10, 12));
  const day = Number(id.slice(12, 14));
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    sum += (id.charCodeAt(i) - 48) * CN_ID_WEIGHTS[i];
  }
  return CN_ID_CHECK[sum % 11] === id[17];
}

const PLACEHOLDER_WORDS = [
  "example",
  "sample",
  "dummy",
  "placeholder",
  "changeme",
  "change_me",
  "your_",
  "your-",
  "yourkey",
  "your_api",
  "xxxxxx",
  "******",
  "<your",
  "redacted",
  "test_key",
  "fake",
  "lorem",
  "todo",
  "insert",
  "replace_me",
  "notreal",
];

/**
 * Heuristic for values that are obviously not real secrets: template references,
 * masked values, documentation stand-ins and low-variety strings.
 */
export function looksLikePlaceholder(input: string): boolean {
  const value = input.trim();
  if (value.length === 0) return true;
  const lower = value.toLowerCase();
  if (PLACEHOLDER_WORDS.some((word) => lower.includes(word))) return true;
  // Template / env references such as ${VAR}, {{var}}, $VAR, %VAR%, <VAR>, process.env.X
  if (/^\$\{.*\}$|^\{\{.*\}\}$|^\$[A-Z_][A-Z0-9_]*$|^%[A-Z_]+%$|^<[^>]+>$/i.test(value))
    return true;
  if (/^(process\.env|os\.environ|env)\b/i.test(value)) return true;
  // Repeated single character (aaaa, 0000, ****)
  if (/^(.)\1+$/.test(value)) return true;
  // Very low character variety relative to length
  const unique = new Set(value).size;
  if (value.length >= 8 && unique <= 2) return true;
  return false;
}

export interface CharsetProfile {
  lower: boolean;
  upper: boolean;
  digit: boolean;
  symbol: boolean;
}

export function charsetProfile(input: string): CharsetProfile {
  return {
    lower: /[a-z]/.test(input),
    upper: /[A-Z]/.test(input),
    digit: /\d/.test(input),
    symbol: /[^A-Za-z0-9]/.test(input),
  };
}

export function charsetClassCount(input: string): number {
  const profile = charsetProfile(input);
  return Number(profile.lower) + Number(profile.upper) + Number(profile.digit);
}

/** Mainland China mobile number: rejects runs such as 13800000000 with almost no variety. */
export function isPlausibleChinesePhone(input: string): boolean {
  const digits = input.replace(/\D/g, "");
  return new Set(digits.slice(-8)).size > 2;
}

const USCC_CHARS = "0123456789ABCDEFGHJKLMNPQRTUWXY";
const USCC_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];

/** Unified social credit code (统一社会信用代码) checksum. */
export function isValidUscc(input: string): boolean {
  if (!/^[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}$/.test(input)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    sum += USCC_WEIGHTS[i] * USCC_CHARS.indexOf(input[i]);
  }
  return USCC_CHARS[(31 - (sum % 31)) % 31] === input[17];
}

/** IBAN mod-97 check. */
export function isValidIban(input: string): boolean {
  const iban = input.replace(/ /g, "");
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  let remainder = 0;
  for (const ch of iban.slice(4) + iban.slice(0, 4)) {
    const digits = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const digit of digits) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

/** Rejects documentation keys (…EXAMPLE), filler runs and values with little variety. */
export function looksReal(input: string): boolean {
  return new Set(input).size >= 6 && !/EXAMPLE|example|x{6,}|X{6,}|\*{3,}|0{8,}/.test(input);
}

export function hasLettersAndDigits(input: string): boolean {
  return /\d/.test(input) && /[A-Za-z]/.test(input);
}

const SECRET_STOPWORDS =
  /^(?:changeme|change_me|password|passwd|secret|token|example|sample|dummy|placeholder|null|none|nil|true|false|undefined|redacted|xxx+|\*+|<[^>]*>|test|testing)$/i;

/**
 * Right-hand side of a `password = ...` style assignment: rejects stopwords, template and
 * environment references, code identifiers and member chains, and low-entropy words.
 */
export function isCredentialValue(input: string, minEntropy = 3): boolean {
  if (input.length < 8 || input.length > 16384) return false;
  if (SECRET_STOPWORDS.test(input)) return false;
  if (/\$\{|\{\{|%\(|process\.env|os\.environ|getenv|^\$[A-Z_]/.test(input)) return false;
  if (
    /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:\(\))?$/.test(input) &&
    !/\d/.test(input)
  ) {
    return false;
  }
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(/.test(input)) return false;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){2,}$/.test(input)) return false;
  if (!/[\d\W_]/.test(input)) return false;
  if (looksLikePlaceholder(input)) return false;
  return shannonEntropy(input) >= minEntropy && looksReal(input);
}

/** JWT: the header must base64url-decode to a JSON object with an `alg` field. */
export function isJwt(input: string): boolean {
  const header = input.split(".")[0] ?? "";
  try {
    const padded = header.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    return typeof parsed === "object" && parsed !== null && "alg" in parsed;
  } catch {
    return false;
  }
}

const FILE_TLDS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "ico",
  "pdf",
  "js",
  "mjs",
  "ts",
  "tsx",
  "jsx",
  "css",
  "json",
  "html",
  "md",
  "txt",
  "yaml",
  "yml",
  "xml",
  "zip",
  "gz",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "lock",
  "map",
]);

const PUBLIC_EMAIL_DOMAINS =
  /(?:^|\.)(?:example\.(?:com|org|net)|test|invalid|localhost|users\.noreply\.github\.com)$/i;

/**
 * Emails worth hiding: rejects file names that look like emails (logo@2x.png), documentation
 * domains and no-reply addresses such as the Co-Authored-By trailer of coding agents.
 */
export function isPlausibleEmail(input: string): boolean {
  const at = input.lastIndexOf("@");
  if (at <= 0) return false;
  const local = input.slice(0, at);
  const domain = input.slice(at + 1).toLowerCase();
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  if (local.endsWith(".") || local.includes("..") || FILE_TLDS.has(tld)) return false;
  if (/^(?:no-?reply|noreply\+.*|donotreply|do-not-reply)$/i.test(local)) return false;
  return !PUBLIC_EMAIL_DOMAINS.test(domain);
}

/** IPv4 addresses other than loopback, unspecified and broadcast. */
export function isNotReservedIpv4(input: string): boolean {
  return !/^(?:127\.|0\.0\.0\.0$|255\.255\.255\.255$)/.test(input);
}
