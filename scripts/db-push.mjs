import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const envPath = resolve(root, ".env");
let dotEnv = {};

try {
  dotEnv = Object.fromEntries(
    readFileSync(envPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [
          line.slice(0, separator).trim(),
          line.slice(separator + 1).trim().replace(/^(['"])|(['"])$/g, ""),
        ];
      }),
  );
} catch {
  // The database command will provide the missing DATABASE_URL error.
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(
  pnpm,
  ["--filter", "@workspace/db", "run", "push"],
  {
    cwd: root,
    env: { ...dotEnv, ...process.env },
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);