import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compareVersions, normalizeVersionForDisplay } from "@/lib/version";

const workflow = readFileSync(join(process.cwd(), ".github/workflows/fork-ghcr.yml"), "utf8");

describe("fork image version", () => {
  test("build metadata does not make the fork look older than its upstream release", () => {
    expect(compareVersions("v0.9.8+fork.8c3b444", "v0.9.8")).toBe(0);
    expect(compareVersions("v0.9.8+fork.8c3b444", "v0.9.9")).toBe(1);
    expect(compareVersions("v0.9.8+fork.8c3b444", "v0.9.7")).toBe(-1);
    // The old prerelease form is what made the banner fire.
    expect(compareVersions("v0.9.8-fork.8c3b444", "v0.9.8")).toBe(1);
    expect(normalizeVersionForDisplay("0.9.8+fork.8c3b444")).toBe("v0.9.8+fork.8c3b444");
  });

  test("the workflow bakes the build-metadata form into the app", () => {
    expect(workflow).toContain('echo "app_version=${UPSTREAM_VERSION}+fork.${SHORT_SHA}"');
    expect(workflow).toContain("APP_VERSION=${{ steps.meta.outputs.app_version }}");
    expect(workflow).not.toContain("APP_VERSION=${{ steps.meta.outputs.version }}");
  });
});
