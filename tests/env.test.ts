import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadDotEnv } from "../src/lib/env.js";

const dirs: string[] = [];
const touched: string[] = [];

/** A throwaway package root: package.json, an optional .env, a dist/lib below. */
function fixture(envContents?: string): { root: string; deep: string } {
  const root = mkdtempSync(join(tmpdir(), "sevdesk-env-"));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), '{"name":"fixture"}');
  if (envContents !== undefined) writeFileSync(join(root, ".env"), envContents);
  const deep = join(root, "dist", "lib");
  mkdirSync(deep, { recursive: true });
  return { root, deep };
}

/** Remember a variable so the suite can't leak into other tests. */
function scoped(name: string, value?: string): void {
  touched.push(name);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const name of touched) delete process.env[name];
  touched.length = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe("loadDotEnv", () => {
  it("reads .env from the package root when started deeper in the tree", () => {
    const { root, deep } = fixture("SEVDESK_TEST_TOKEN=from_dotenv\n");
    scoped("SEVDESK_TEST_TOKEN");

    expect(loadDotEnv(deep)).toBe(join(root, ".env"));
    expect(process.env.SEVDESK_TEST_TOKEN).toBe("from_dotenv");
  });

  it("never overrides a variable the MCP client already set", () => {
    const { deep } = fixture("SEVDESK_TEST_TOKEN=from_dotenv\n");
    scoped("SEVDESK_TEST_TOKEN", "from_client_env");

    loadDotEnv(deep);
    expect(process.env.SEVDESK_TEST_TOKEN).toBe("from_client_env");
  });

  it("is a no-op when the package root holds no .env", () => {
    const { deep } = fixture();
    expect(loadDotEnv(deep)).toBeUndefined();
  });

  it("returns undefined rather than throwing on an unreadable .env", () => {
    const { root, deep } = fixture();
    // A directory where the file should be: exists, but cannot be parsed.
    mkdirSync(join(root, ".env"));
    expect(() => loadDotEnv(deep)).not.toThrow();
    expect(loadDotEnv(deep)).toBeUndefined();
  });

  it("gives up quietly when there is no package.json above it", () => {
    const orphan = mkdtempSync(join(tmpdir(), "sevdesk-orphan-"));
    dirs.push(orphan);
    // tmpdir has no package.json above it on any supported platform.
    expect(loadDotEnv(orphan)).toBeUndefined();
  });
});
