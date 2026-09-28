import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const root = process.cwd();

function loadDotEnv() {
  const envPath = resolve(root, ".env");

  try {
    const contents = readFileSync(envPath, "utf8");

    return Object.fromEntries(
      contents
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => {
          const separator = line.indexOf("=");
          const key = line.slice(0, separator).trim();
          const value = line
            .slice(separator + 1)
            .trim()
            .replace(/^(['"])|(['"])$/g, "");

          return [key, value];
        }),
    );
  } catch {
    return {};
  }
}

const env = {
  ...loadDotEnv(),
  ...process.env,
};

const dashboardDir = resolve(
  root,
  "artifacts/github-automation-dashboard",
);

const electronBin = resolve(
  dashboardDir,
  "node_modules/electron/cli.js",
);

console.log("Starting Electron...");
console.log("Electron will start API + dashboard automatically.");

const electron = spawn(
  process.execPath,
  [electronBin, "."],
  {
    cwd: dashboardDir,
    env: {
      ...env,
      NODE_ENV: "development",
      API_PORT: "8080",
      WEB_PORT: "5173",
    },
    stdio: "inherit",
  },
);

let shuttingDown = false;

function shutdown(signal = "SIGTERM") {
  if (shuttingDown) return;

  shuttingDown = true;

  console.log("\nStopping application...");

  try {
    electron.kill(signal);
  } catch {}
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

electron.on("error", (error) => {
  console.error("Electron failed to start:", error);
  process.exitCode = 1;
});

electron.on("exit", (code, signal) => {
  if (!shuttingDown && code !== 0) {
    console.error(
      `Electron exited unexpectedly: code=${code}, signal=${signal}`,
    );
    process.exitCode = code ?? 1;
  }
});
