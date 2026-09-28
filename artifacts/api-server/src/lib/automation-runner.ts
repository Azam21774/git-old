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
  completedRecipientIndexes: Set<number>;
  completedRecipientsByAccount: Map<string, number>;
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
    recipientIndexes: number[],
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
  recipientIndexes: number[];
};

function isRecipientBatchComplete(
  batch: RecipientBatch,
  run: ActiveRun,
) {
  return batch.recipientIndexes.every((index) =>
    run.completedRecipientIndexes.has(index),
  );
}

function getRemainingRecipientBatches(
  batches: RecipientBatch[],
  run: ActiveRun,
) {
  return batches.filter(
    (batch) => !isRecipientBatchComplete(batch, run),
  );
}

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
  accountId: number,
  run: ActiveRun,
  jobs: RecipientBatch[],
) {
  let outputBuffer = "";
  let pending = Promise.resolve();
  const jobsByIndex = new Map(
    jobs.map((job) => [job.index, job]),
  );

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
          const completedJob = jobsByIndex.get(batchIndex);

          if (
            Number.isInteger(batchIndex) &&
            completedJob
          ) {
            const newlyCompleted = completedJob.recipientIndexes.filter(
              (recipientIndex) =>
                !run.completedRecipientIndexes.has(recipientIndex),
            );

            if (newlyCompleted.length > 0) {
              newlyCompleted.forEach((recipientIndex) =>
                run.completedRecipientIndexes.add(recipientIndex),
              );
              const accountKey = String(accountId);
              run.completedRecipientsByAccount.set(
                accountKey,
                (run.completedRecipientsByAccount.get(accountKey) ?? 0) +
                  newlyCompleted.length,
              );

              await hooks.onBatchComplete(
                accountIndex,
                batchIndex,
                newlyCompleted,
              );
            }
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
    id: number;
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
    account.id,
    run,
    jobs,
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
      remainingJobs: getRemainingRecipientBatches(jobs, run),
    };
  }

  if (result.error) {
    return {
      ok: false,
      stopped: false,
      remainingJobs: getRemainingRecipientBatches(jobs, run),
      error: result.error,
    };
  }

  if (runnerError) {
    return {
      ok: false,
      stopped: false,
      remainingJobs: getRemainingRecipientBatches(jobs, run),
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
      remainingJobs: getRemainingRecipientBatches(jobs, run),
      error: new Error(
        `Automation runner exited unexpectedly (code=${result.code}, signal=${result.signal}).`,
      ),
    };
  }

  return {
    ok: runnerOk,
    stopped: false,
    remainingJobs: getRemainingRecipientBatches(jobs, run),
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
  accountRecipientLimit: number,
  resumeCompletedRecipientIndexes: number[],
  resumeCompletedRecipientsByAccount: Record<string, number>,
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

  const completedRecipientIndexes = new Set(
    resumeCompletedRecipientIndexes.filter(
      (index) =>
        Number.isInteger(index) &&
        index >= 0 &&
        index < normalizedRecipients.length,
    ),
  );
  const completedRecipientsByAccount = new Map(
    Object.entries(resumeCompletedRecipientsByAccount)
      .filter(([, count]) => Number.isSafeInteger(count) && count >= 0),
  );
  const totalBatches = Math.ceil(
    normalizedRecipients.length / batchSize,
  );

  const run: ActiveRun = {
    id: nextActiveRunId++,
    state: "starting",
    paused: false,
    children: new Map(),
    runnerPorts: new Map(),
    completedRecipientIndexes,
    completedRecipientsByAccount,
  };

  activeRun = run;

  try {
    let pendingRecipientIndexes = normalizedRecipients
      .map((_recipient, index) => index)
      .filter((index) => !run.completedRecipientIndexes.has(index));
    let availableAccounts = accounts
      .map((account, index) => ({
        account,
        accountIndex: index + 1,
      }))
      .filter(
        ({ account }) =>
          accountRecipientLimit === 0 ||
          (run.completedRecipientsByAccount.get(
            String(account.id),
          ) ?? 0) < accountRecipientLimit,
      );
    let phase = 1;

    const completedRecipientCount =
      run.completedRecipientIndexes.size;

    await hooks.onLog(
      `Starting ${availableAccounts.length} available GitHub account(s) for ${normalizedRecipients.length} recipient(s). ${completedRecipientCount} recipient(s) already completed.`,
      "success",
    );

    run.state = "running";

    while (
      pendingRecipientIndexes.length > 0 &&
      availableAccounts.length > 0 &&
      !isRunStopping(run)
    ) {
      const assignments: RecipientBatch[][] =
        availableAccounts.map(() => []);
      const assignedRecipientCounts = availableAccounts.map(
        () => 0,
      );
      const assignedRecipientIndexes = new Set<number>();
      let pendingOffset = 0;
      let accountCursor = 0;

      while (pendingOffset < pendingRecipientIndexes.length) {
        let accountPosition = -1;

        for (
          let attempt = 0;
          attempt < availableAccounts.length;
          attempt += 1
        ) {
          const candidatePosition =
            (accountCursor + attempt) %
            availableAccounts.length;
          const candidate = availableAccounts[candidatePosition];
          const alreadyAssigned =
            assignedRecipientCounts[candidatePosition];
          const completedForAccount =
            run.completedRecipientsByAccount.get(
              String(candidate.account.id),
            ) ?? 0;

          if (
            accountRecipientLimit === 0 ||
            completedForAccount + alreadyAssigned <
              accountRecipientLimit
          ) {
            accountPosition = candidatePosition;
            break;
          }
        }

        if (accountPosition < 0) break;

        const account = availableAccounts[accountPosition];
        const alreadyAssigned =
          assignedRecipientCounts[accountPosition];
        const completedForAccount =
          run.completedRecipientsByAccount.get(
            String(account.account.id),
          ) ?? 0;
        const remainingCapacity =
          accountRecipientLimit === 0
            ? batchSize
            : accountRecipientLimit -
              completedForAccount -
              alreadyAssigned;
        const firstRecipientIndex =
          pendingRecipientIndexes[pendingOffset];
        const originalBatchIndex = Math.floor(
          firstRecipientIndex / batchSize,
        );
        const recipientIndexes: number[] = [];

        while (
          pendingOffset + recipientIndexes.length <
            pendingRecipientIndexes.length &&
          recipientIndexes.length < batchSize &&
          recipientIndexes.length < remainingCapacity
        ) {
          const nextRecipientIndex =
            pendingRecipientIndexes[
              pendingOffset + recipientIndexes.length
            ];

          if (
            nextRecipientIndex !==
              firstRecipientIndex + recipientIndexes.length ||
            Math.floor(nextRecipientIndex / batchSize) !==
              originalBatchIndex
          ) {
            break;
          }

          recipientIndexes.push(nextRecipientIndex);
        }

        if (recipientIndexes.length === 0) break;

        assignments[accountPosition].push({
          index: assignments[accountPosition].length,
          recipientIndexes,
          recipients: recipientIndexes.map(
            (index) => normalizedRecipients[index],
          ),
        });
        recipientIndexes.forEach((index) =>
          assignedRecipientIndexes.add(index),
        );
        assignedRecipientCounts[accountPosition] +=
          recipientIndexes.length;
        pendingOffset += recipientIndexes.length;
        accountCursor =
          (accountPosition + 1) % availableAccounts.length;
      }

      const assignedAccounts = availableAccounts
        .map((entry, index) => ({
          ...entry,
          jobs: assignments[index],
        }))
        .filter((entry) => entry.jobs.length > 0);

      await hooks.onLog(
        phase === 1
          ? `Assigning ${assignedRecipientIndexes.size} recipient(s) across ${assignedAccounts.length} account(s).`
          : `Reassigning unfinished recipients across ${assignedAccounts.length} available account(s).`,
        phase === 1 ? "normal" : "warning",
      );

      const launchIntervalMs =
        assignedAccounts.length > 5
          ? 1000 + Math.random() * 500
          : 500;

      const results = await Promise.all(
        assignedAccounts.map(
          async (
            { account, accountIndex, jobs },
            assignmentIndex,
          ) => {
            await hooks.onLog(
              `Account ${accountIndex} assigned ${jobs.length} batch(es) containing ${jobs.reduce(
                (count, job) =>
                  count + job.recipients.length,
                0,
              )} recipient(s)${
                accountRecipientLimit > 0
                  ? ` (limit ${accountRecipientLimit})`
                  : ""
              }.`,
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
                jobs.length,
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
                  remainingJobs: getRemainingRecipientBatches(
                    jobs,
                    run,
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

      const nextPendingRecipientIndexes = new Set(
        pendingRecipientIndexes.filter(
          (index) => !assignedRecipientIndexes.has(index),
        ),
      );
      const nextAvailableAccounts: typeof availableAccounts = [];

      for (const {
        account,
        accountIndex,
        result,
      } of results) {
        if (result.stopped || isRunStopping(run)) {
          continue;
        }

        const remainingJobs = getRemainingRecipientBatches(
          result.remainingJobs,
          run,
        );

        if (result.ok) {
          remainingJobs.forEach((job) =>
            job.recipientIndexes.forEach((recipientIndex) =>
              nextPendingRecipientIndexes.add(recipientIndex),
            ),
          );

          const completedForAccount =
            run.completedRecipientsByAccount.get(
              String(account.id),
            ) ?? 0;

          if (
            accountRecipientLimit > 0 &&
            completedForAccount >= accountRecipientLimit
          ) {
            await hooks.onLog(
              `Account ${accountIndex} reached its ${accountRecipientLimit}-recipient limit and is now off for this run.`,
              "success",
            );
          } else {
            nextAvailableAccounts.push({
              account,
              accountIndex,
            });
          }

          continue;
        }

        remainingJobs.forEach((job) =>
          job.recipientIndexes.forEach((recipientIndex) =>
            nextPendingRecipientIndexes.add(recipientIndex),
          ),
        );

        await hooks.onLog(
          `Account ${accountIndex} failed; ${remainingJobs.reduce(
            (count, job) => count + job.recipientIndexes.length,
            0,
          )} unfinished recipient(s) will be shifted to surviving account(s).${
            result.error
              ? ` Reason: ${result.error.message}`
              : ""
          }`,
          "warning",
        );
      }

      pendingRecipientIndexes = Array.from(
        nextPendingRecipientIndexes,
      )
        .filter((index) => !run.completedRecipientIndexes.has(index))
        .sort((left, right) => left - right);
      availableAccounts = nextAvailableAccounts;
      phase += 1;

      if (
        pendingRecipientIndexes.length > 0 &&
        availableAccounts.length === 0
      ) {
        break;
      }
    }

    if (!isRunStopping(run)) {
      if (pendingRecipientIndexes.length > 0) {
        const everyAccountAtLimit =
          accountRecipientLimit > 0 &&
          accounts.every(
            (account) =>
              (run.completedRecipientsByAccount.get(
                String(account.id),
              ) ?? 0) >= accountRecipientLimit,
          );

        if (everyAccountAtLimit) {
          await hooks.onFinished(
            false,
            `All GitHub accounts reached the ${accountRecipientLimit}-recipient limit. ${pendingRecipientIndexes.length} recipient(s) remain; increase the limit or add accounts to continue.`,
          );
          return;
        }

        throw new Error(
          `No healthy account remains for ${pendingRecipientIndexes.length} unfinished recipient(s).`,
        );
      }

      await hooks.onFinished(
        true,
        "All recipients were processed successfully, including automatic failover.",
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
