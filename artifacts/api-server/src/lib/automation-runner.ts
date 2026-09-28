import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const resourcesPath = (
  process as NodeJS.Process & {
    resourcesPath?: string;
  }
).resourcesPath;

const isPackaged =
  Boolean(resourcesPath) &&
  resourcesPath !== process.cwd();

const runnerDir = isPackaged
  ? path.join(resourcesPath!, "backend", "runner")
  : path.resolve(__dirname, "..", "runner");

const runnerScript = path.join(
  runnerDir,
  "github-ui-automation.cjs",
);

type ActiveRun = {
  id: number;
  state: "starting" | "running" | "stopping";
  paused: boolean;
  children: Map<number, ChildProcess>;
  runnerPorts: Map<number, number>;
  completedBatchIndexes: Set<number>;
};

let nextActiveRunId = 1;
let activeRun: ActiveRun | null = null;

function isRunStopping(run: ActiveRun) {
  return run.state === "stopping";
}

async function waitForRunDelay(
  run: ActiveRun,
  durationMs: number,
) {
  let remainingMs = Math.max(0, durationMs);

  while (remainingMs > 0) {
    if (activeRun !== run || isRunStopping(run)) {
      return false;
    }

    if (run.paused) {
      await new Promise((resolve) =>
        setTimeout(resolve, 250),
      );
      continue;
    }

    const sliceMs = Math.min(250, remainingMs);
    await new Promise((resolve) =>
      setTimeout(resolve, sliceMs),
    );
    remainingMs -= sliceMs;
  }

  return activeRun === run && !isRunStopping(run);
}

export type RunnerHooks = {
  onLog: (
    message: string,
    tone?: "normal" | "success" | "warning",
  ) => Promise<void>;

  onBatchComplete: (
    accountIndex: number,
    batchIndex: number,
  ) => Promise<void>;

  onAccount: (accountIndex: number) => Promise<void>;

  onFinished: (
    ok: boolean,
    message?: string,
  ) => Promise<void>;
};

type RecipientBatch = {
  index: number;
  recipients: string[];
};

type AccountAttemptResult = {
  ok: boolean;
  stopped: boolean;
  remainingJobs: RecipientBatch[];
  error?: Error;
};

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();

    server.once("error", reject);

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      const port =
        typeof address === "object" && address
          ? address.port
          : 0;

      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(port);
        }
      });
    });
  });
}

async function waitForRunner(
  port: number,
  child: ChildProcess,
  run: ActiveRun,
  timeoutMs = 30000,
): Promise<void> {
  let remainingMs = timeoutMs;

  while (remainingMs > 0) {
    if (run.state === "stopping") {
      throw new Error(
        "Automation was stopped before the runner became ready.",
      );
    }

    if (
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      throw new Error(
        "UI automation runner exited before becoming ready.",
      );
    }

    if (run.paused) {
      await new Promise((resolve) =>
        setTimeout(resolve, 250),
      );

      continue;
    }

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/`,
      );

      if (response.ok || response.status === 404) {
        return;
      }
    } catch {}

    await new Promise((resolve) =>
      setTimeout(resolve, 250),
    );

    remainingMs -= 250;
  }

  throw new Error(
    `UI automation runner did not start in time on port ${port}.`,
  );
}

type ChildExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};

async function forceKillProcessTree(
  child: ChildProcess,
) {
  if (!child.pid) {
    return;
  }

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn(
        "taskkill",
        [
          "/pid",
          String(child.pid),
          "/T",
          "/F",
        ],
        {
          windowsHide: true,
          stdio: "ignore",
        },
      );

      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    });

    return;
  }

  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

async function waitForChildExit(
  child: ChildProcess,
  childExit: Promise<ChildExit>,
  timeoutMs = 5000,
): Promise<ChildExit> {
  const timedResult = await Promise.race([
    childExit.then((result) => ({
      kind: "exit" as const,
      result,
    })),
    new Promise<{
      kind: "timeout";
    }>((resolve) =>
      setTimeout(
        () => resolve({ kind: "timeout" }),
        timeoutMs,
      ),
    ),
  ]);

  if (timedResult.kind === "exit") {
    return timedResult.result;
  }

  await forceKillProcessTree(child);

  const forcedResult = await Promise.race([
    childExit.then((result) => ({
      kind: "exit" as const,
      result,
    })),
    new Promise<{
      kind: "timeout";
    }>((resolve) =>
      setTimeout(
        () => resolve({ kind: "timeout" }),
        timeoutMs,
      ),
    ),
  ]);

  if (forcedResult.kind === "exit") {
    return forcedResult.result;
  }

  return {
    code: null,
    signal: "SIGKILL",
  };
}

async function postRunner(
  port: number,
  route: string,
  body?: unknown,
) {
  const response = await fetch(
    `http://127.0.0.1:${port}${route}`,
    {
      method: "POST",
      headers: body
        ? {
            "Content-Type":
              "application/json",
          }
        : undefined,
      body: body
        ? JSON.stringify(body)
        : undefined,
    },
  );

  if (!response.ok) {
    throw new Error(
      `Runner request failed: ${response.status}`,
    );
  }

  return response.json().catch(() => ({}));
}

function createOutputFeeder(
  hooks: RunnerHooks,
  accountIndex: number,
  run: ActiveRun,
) {
  let outputBuffer = "";
  let pending = Promise.resolve();

  const feed = (text: string) => {
    outputBuffer += text;

    const lines = outputBuffer.split(/\r?\n/);

    outputBuffer = lines.pop() ?? "";

    for (const raw of lines) {
      const line = raw.trim();

      if (!line) {
        continue;
      }

      /*
       * These are optional Chrome background-service diagnostics, not
       * automation failures. Keeping them out of the dashboard prevents
       * users from mistaking Chrome's GCM/on-device-model messages for a
       * browser crash. Real runner and Puppeteer errors still pass through.
       */
      if (
        /Registration response error message:\s*(DEPRECATED_ENDPOINT|QUOTA_EXCEEDED)/i.test(
          line,
        ) ||
        /on_device_model service disconnect.*Error loading backend/i.test(
          line,
        )
      ) {
        continue;
      }

      const match = line.match(
        /Recipient batch completed\s+(\d+)\s*\/\s*(\d+)/i,
      );

      pending = pending.then(async () => {
        if (activeRun !== run) {
          return;
        }

        await hooks.onLog(
          `[Account ${accountIndex}] ${line}`,
        );

        if (match) {
          const batchIndex = Number(match[1]) - 1;

          if (
            Number.isInteger(batchIndex) &&
            !run.completedBatchIndexes.has(batchIndex)
          ) {
            run.completedBatchIndexes.add(batchIndex);

            await hooks.onBatchComplete(
              accountIndex,
              batchIndex,
            );
          }
        }
      });
    }
  };

  return {
    feed,
    drain: () => pending,
  };
}

async function runAccount(
  account: {
    email: string;
    password: string;
    totp: string;
  },
  jobs: RecipientBatch[],
  workflow: {
    fileName: string;
    commitMessage: string;
    description: string;
  },
  batchSize: 1 | 2,
  totalBatches: number,
  accountIndex: number,
  hooks: RunnerHooks,
  run: ActiveRun,
): Promise<AccountAttemptResult> {
  const port = await getFreePort();

  console.log(
    `[automation-runner] runnerDir=${runnerDir}`,
  );

  console.log(
    `[automation-runner] runnerScript=${runnerScript}`,
  );

  try {
    await fs.access(runnerScript);
  } catch {
    throw new Error(
      `Runner script not found: ${runnerScript}`,
    );
  }

  const env = {
    ...process.env,

    PORT: String(port),

    ACTION_DELAY_MS: String(
      Math.max(
        0,
        Number(
          process.env.ACTION_DELAY_MS ?? 700,
        ),
      ),
    ),

    TYPE_DELAY_MS: String(
      Math.max(
        0,
        Number(
          process.env.TYPE_DELAY_MS ?? 35,
        ),
      ),
    ),
  };

  await hooks.onAccount(accountIndex);

  if (
    activeRun !== run ||
    isRunStopping(run)
  ) {
    return {
      ok: false,
      stopped: true,
      remainingJobs: jobs,
    };
  }

  const currentChild = spawn(
    process.execPath,
    [runnerScript],
    {
      cwd: runnerDir,
      env: {
        ...env,
        // In Electron, process.execPath points to the Electron binary rather
        // than node.exe. Without this flag Electron opens another app window
        // instead of executing the runner script as a Node child process.
        ...(process.versions.electron
          ? { ELECTRON_RUN_AS_NODE: "1" }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
      detached: process.platform !== "win32",
    },
  );

  run.children.set(accountIndex, currentChild);
  run.runnerPorts.set(accountIndex, port);

  if (
    run.paused &&
    process.platform !== "win32"
  ) {
    currentChild.kill("SIGSTOP");
  }

  const output = createOutputFeeder(
    hooks,
    accountIndex,
    run,
  );

  currentChild.stdout?.on(
    "data",
    (data: Buffer) => {
      output.feed(data.toString());
    },
  );

  currentChild.stderr?.on(
    "data",
    (data: Buffer) => {
      output.feed(data.toString());
    },
  );

  const childExit =
    new Promise<ChildExit>((resolve) => {
      currentChild.once(
        "error",
        (error) => {
          resolve({
            code: null,
            signal: null,
            error,
          });
        },
      );

      currentChild.once(
        "close",
        (code, signal) => {
          resolve({
            code,
            signal,
          });
        },
      );
    });

  let runnerOk = false;
  let runnerError: unknown;

  try {
    const startup = await Promise.race([
      waitForRunner(
        port,
        currentChild,
        run,
      ).then(() => ({
        kind: "ready" as const,
      })),
      childExit.then((result) => ({
        kind: "closed" as const,
        result,
      })),
    ]);

    if (startup.kind === "closed") {
      throw (
        startup.result.error ??
        new Error(
          `UI automation runner exited before becoming ready (code=${startup.result.code}, signal=${startup.result.signal}).`,
        )
      );
    }

    const jobsPerRequest = 250;

    for (
      let offset = 0;
      offset < jobs.length;
      offset += jobsPerRequest
    ) {
      await postRunner(
        port,
        "/api/automation/jobs",
        {
          jobs: jobs.slice(
            offset,
            offset + jobsPerRequest,
          ),
        },
      );
    }

    await postRunner(
      port,
      "/api/automation/start",
      {
        account: {
          email: account.email,
          password: account.password,
          totp: account.totp,
        },
        jobs: [],
        batchSize,
        totalBatches,
        workflow,
      },
    );

    if (run.paused) {
      await postRunner(port, "/api/automation/pause").catch(() => {});
    }

    while (!isRunStopping(run)) {
      await new Promise((resolve) =>
        setTimeout(resolve, 500),
      );

      if (currentChild.exitCode !== null) {
        break;
      }

      try {
        const status =
          (await fetch(
            `http://127.0.0.1:${port}/api/automation/status`,
          ).then((response) =>
            response.json(),
          )) as {
            running: boolean;
            status: string;
          };

        if (
          !status.running &&
          (
            status.status === "finished" ||
            status.status === "error" ||
            status.status === "stopped"
          )
        ) {
          runnerOk =
            status.status === "finished";

          break;
        }
      } catch {}
    }
  } catch (error) {
    runnerError = error;
  } finally {
    if (
      currentChild.exitCode === null &&
      currentChild.signalCode === null
    ) {
      currentChild.kill("SIGTERM");
    }
  }

  let result: ChildExit;

  try {
    result = await waitForChildExit(
      currentChild,
      childExit,
    );

    await output.drain();
  } finally {
    run.children.delete(accountIndex);
    run.runnerPorts.delete(accountIndex);
  }

  if (isRunStopping(run)) {
    return {
      ok: false,
      stopped: true,
      remainingJobs: jobs.filter(
        (job) => !run.completedBatchIndexes.has(job.index),
      ),
    };
  }

  if (result.error) {
    return {
      ok: false,
      stopped: false,
      remainingJobs: jobs.filter(
        (job) => !run.completedBatchIndexes.has(job.index),
      ),
      error: result.error,
    };
  }

  if (runnerError) {
    return {
      ok: false,
      stopped: false,
      remainingJobs: jobs.filter(
        (job) => !run.completedBatchIndexes.has(job.index),
      ),
      error:
        runnerError instanceof Error
          ? runnerError
          : new Error(String(runnerError)),
    };
  }

  if (
    result.code !== 0 &&
    result.signal !== "SIGTERM"
  ) {
    return {
      ok: false,
      stopped: false,
      remainingJobs: jobs.filter(
        (job) => !run.completedBatchIndexes.has(job.index),
      ),
      error: new Error(
        `Automation runner exited unexpectedly (code=${result.code}, signal=${result.signal}).`,
      ),
    };
  }

  return {
    ok: runnerOk,
    stopped: false,
    remainingJobs: jobs.filter(
      (job) => !run.completedBatchIndexes.has(job.index),
    ),
    error: runnerOk
      ? undefined
      : new Error("Automation runner did not finish successfully."),
  };
}

export async function startAutomation(
  accounts: {
    id: number;
    email: string;
    password: string;
    totp: string;
  }[],
  recipients: string[],
  workflow: {
    fileName: string;
    commitMessage: string;
    description: string;
  },
  actionDelay: number,
  typingDelay: number,
  batchSize: 1 | 2,
  resumeCompletedBatchIndexes: number[] = [],
  hooks: RunnerHooks,
) {
  if (activeRun) {
    throw new Error(
      "Automation runner is already active.",
    );
  }

  if (!accounts.length) {
    throw new Error(
      "No automation accounts configured.",
    );
  }

  const normalizedRecipients = Array.from(
    new Set(
      recipients
        .map((recipient) =>
          recipient.trim().toLowerCase(),
        )
        .filter(Boolean),
    ),
  );

  if (normalizedRecipients.length < 1) {
    throw new Error(
      "At least one recipient is required.",
    );
  }

  process.env.ACTION_DELAY_MS =
    String(actionDelay);

  process.env.TYPE_DELAY_MS =
    String(typingDelay);

  const batches: RecipientBatch[] = [];

  for (
    let index = 0;
    index < normalizedRecipients.length;
    index += batchSize
  ) {
    batches.push({
      index: batches.length,
      recipients: normalizedRecipients.slice(
        index,
        index + batchSize,
      ),
    });
  }

  const completedBatchIndexes = new Set(
    resumeCompletedBatchIndexes.filter(
      (index) =>
        Number.isInteger(index) &&
        index >= 0 &&
        index < batches.length,
    ),
  );

  const run: ActiveRun = {
    id: nextActiveRunId++,
    state: "starting",
    paused: false,
    children: new Map(),
    runnerPorts: new Map(),
    completedBatchIndexes,
  };

  activeRun = run;

  try {
    let pendingJobs = batches.filter(
      (batch) => !run.completedBatchIndexes.has(batch.index),
    );
    let availableAccounts = accounts.map(
      (account, index) => ({
        account,
        accountIndex: index + 1,
      }),
    );
    let phase = 1;

    await hooks.onLog(
      `Starting ${availableAccounts.length} Google Chrome window(s) for ${batches.length} recipient batch(es). ${run.completedBatchIndexes.size} batch(es) already completed.`,
      "success",
    );

    run.state = "running";

    while (
      pendingJobs.length > 0 &&
      availableAccounts.length > 0 &&
      !isRunStopping(run)
    ) {
      const assignments = availableAccounts.map(
        () => [] as RecipientBatch[],
      );

      pendingJobs.forEach((job, jobIndex) => {
        assignments[
          jobIndex % availableAccounts.length
        ].push(job);
      });

      await hooks.onLog(
        phase === 1
          ? `Assigning ${pendingJobs.length} remaining batch(es) across ${availableAccounts.length} account(s).`
          : `Reassigning ${pendingJobs.length} unfinished batch(es) to ${availableAccounts.length} surviving account(s).`,
        phase === 1 ? "normal" : "warning",
      );

      const launchIntervalMs =
        availableAccounts.length > 5
          ? 1000 + Math.random() * 500
          : 500;

      const results = await Promise.all(
        availableAccounts.map(
          async ({ account, accountIndex }, assignmentIndex) => {
            const jobs = assignments[assignmentIndex];

            await hooks.onLog(
              `Account ${accountIndex} assigned ${jobs.length} batch(es) containing ${jobs.reduce(
                (count, job) =>
                  count + job.recipients.length,
                0,
              )} recipient(s).`,
            );

            const launchDelayMs =
              launchIntervalMs * assignmentIndex;

            if (
              launchDelayMs > 0 &&
              !(await waitForRunDelay(run, launchDelayMs))
            ) {
              return {
                account,
                accountIndex,
                jobs,
                result: {
                  ok: false,
                  stopped: true,
                  remainingJobs: jobs,
                },
              };
            }

            if (isRunStopping(run)) {
              return {
                account,
                accountIndex,
                jobs,
                result: {
                  ok: false,
                  stopped: true,
                  remainingJobs: jobs,
                },
              };
            }

            try {
              const result = await runAccount(
                account,
                jobs,
                workflow,
                batchSize,
                batches.length,
                accountIndex,
                hooks,
                run,
              );

              return {
                account,
                accountIndex,
                jobs,
                result,
              };
            } catch (error) {
              return {
                account,
                accountIndex,
                jobs,
                result: {
                  ok: false,
                  stopped: false,
                  remainingJobs: jobs.filter(
                    (job) =>
                      !run.completedBatchIndexes.has(
                        job.index,
                      ),
                  ),
                  error:
                    error instanceof Error
                      ? error
                      : new Error(String(error)),
                },
              };
            }
          },
        ),
      );

      const nextPendingJobs: RecipientBatch[] = [];
      const nextAvailableAccounts: typeof availableAccounts = [];

      for (const {
        account,
        accountIndex,
        result,
      } of results) {
        if (result.stopped || isRunStopping(run)) {
          continue;
        }

        const remainingJobs = result.remainingJobs.filter(
          (job) =>
            !run.completedBatchIndexes.has(job.index),
        );

        if (result.ok) {
          nextAvailableAccounts.push({
            account,
            accountIndex,
          });

          if (remainingJobs.length > 0) {
            nextPendingJobs.push(...remainingJobs);
          }

          continue;
        }

        nextPendingJobs.push(...remainingJobs);

        await hooks.onLog(
          `Account ${accountIndex} failed; ${remainingJobs.length} unfinished batch(es) will be shifted to surviving account(s).${
            result.error
              ? ` Reason: ${result.error.message}`
              : ""
          }`,
          "warning",
        );
      }

      const uniquePending = new Map<
        number,
        RecipientBatch
      >();

      for (const job of nextPendingJobs) {
        if (!run.completedBatchIndexes.has(job.index)) {
          uniquePending.set(job.index, job);
        }
      }

      pendingJobs = Array.from(uniquePending.values()).sort(
        (left, right) => left.index - right.index,
      );
      availableAccounts = nextAvailableAccounts;
      phase += 1;

      if (
        pendingJobs.length > 0 &&
        availableAccounts.length === 0
      ) {
        throw new Error(
          `No healthy account remains for ${pendingJobs.length} unfinished batch(es).`,
        );
      }
    }

    if (!isRunStopping(run)) {
      if (pendingJobs.length > 0) {
        throw new Error(
          `${pendingJobs.length} recipient batch(es) could not be completed.`,
        );
      }

      await hooks.onFinished(
        true,
        "All recipient batches completed, including automatic failover batches.",
      );
    }
  } catch (error) {
    if (!isRunStopping(run)) {
      await hooks.onFinished(
        false,
        error instanceof Error
          ? error.message
          : String(error),
      );
    }
  } finally {
    if (activeRun === run) {
      activeRun = null;
    }
  }
}

export function pauseAutomation() {
  const run = activeRun;

  if (
    !run ||
    run.paused ||
    run.state === "stopping"
  ) {
    return false;
  }

  for (const child of run.children.values()) {
    if (
      process.platform !== "win32" &&
      child.exitCode === null
    ) {
      child.kill("SIGSTOP");
    }
  }

  run.paused = true;

  for (const port of run.runnerPorts.values()) {
    void postRunner(port, "/api/automation/pause").catch(
      () => {},
    );
  }

  return true;
}

export function resumeAutomation() {
  const run = activeRun;

  if (
    !run ||
    !run.paused ||
    run.state === "stopping"
  ) {
    return false;
  }

  for (const child of run.children.values()) {
    if (
      process.platform !== "win32" &&
      child.exitCode === null
    ) {
      child.kill("SIGCONT");
    }
  }

  run.paused = false;

  for (const port of run.runnerPorts.values()) {
    void postRunner(port, "/api/automation/resume").catch(
      () => {},
    );
  }

  return true;
}

export function stopAutomation() {
  const run = activeRun;

  if (!run) {
    return false;
  }

  run.state = "stopping";

  for (const child of run.children.values()) {
    if (child.exitCode === null) {
      if (
        run.paused &&
        process.platform !== "win32"
      ) {
        child.kill("SIGCONT");
      }

      child.kill("SIGTERM");
    }
  }

  run.paused = false;

  return true;
}

export function isAutomationActive() {
  return activeRun !== null;
}
