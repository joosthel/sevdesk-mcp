/**
 * Optional `.env` support for runs outside an MCP client.
 *
 * MCP clients pass configuration through the `env` block of their server
 * config — that is the supported path and needs no file at all. But
 * `npm run dev`, a probe against a real account and one-off
 * `node dist/index.js` runs have nowhere to put a token except the command
 * line, where it lands in shell history. A `.env` next to package.json
 * covers those.
 *
 * Two rules keep this from surprising anyone:
 *
 *   - the file is read from the **package root, never the working
 *     directory** — an npx-launched server inherits whatever cwd the client
 *     happened to have, and silently absorbing a stray `.env` from there
 *     would be a genuine footgun;
 *   - **real environment variables win.** `process.loadEnvFile` leaves
 *     already-set variables untouched, so a client's `env` block always
 *     beats a stale `.env` on disk.
 *
 * A missing file is the normal case, not an error.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Nearest directory at or above `from` that holds a package.json. */
function packageRoot(from: string): string | undefined {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Load `<package root>/.env` into `process.env` without disturbing variables
 * that are already set. Returns the file that was read, or `undefined` when
 * there was none to read.
 *
 * `from` is the directory the package-root search starts at; it defaults to
 * this module's own location and exists so tests can point at a fixture.
 */
export function loadDotEnv(from: string = dirname(fileURLToPath(import.meta.url))): string | undefined {
  const root = packageRoot(from);
  if (!root) return undefined;

  const file = join(root, ".env");
  if (!existsSync(file)) return undefined;

  try {
    process.loadEnvFile(file);
    return file;
  } catch {
    // A malformed or unreadable .env must not take down a server whose
    // token already arrived through the client's env block.
    return undefined;
  }
}
