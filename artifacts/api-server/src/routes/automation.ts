import { Router } from "express";

import {
  isAutomationActive,
  pauseAutomation,
  resumeAutomation,
  startAutomation,
  stopAutomation,
} from "../lib/automation-runner";

import {
  addLog as addMemoryLog,
  createAccountId,
  createRunId,
  memory,
} from "../lib/automation-memory";

const router = Router();
let recipientLookup = new Set(memory.recipients);

function jsonError(res: any, status: number, message: string) {
  return res.status(status).json({ message });
}

function getState() {
  return {
    accounts: memory.accounts.map((account) => ({
      id: account.id,
      email: account.email,
    })),

    recipients: [...memory.recipients],

    settings: {
      ...memory.settings,
    },

    run: memory.run
      ? {
          id: memory.run.id,
          status: memory.run.status,
          total: memory.run.total,
          completed: memory.run.completed,
          totalRecipients: memory.run.totalRecipients,
          completedRecipients: memory.run.completedRecipients,
          currentAccount: memory.run.currentAccount,
          completedRecipientsByAccount: {
            ...memory.run.completedRecipientsByAccount,
          },
          completedBatches: [
            ...memory.run.completedBatches,
          ],
          resumeKey: memory.run.resumeKey,
          updatedAt: memory.run.updatedAt,
        }
      : null,

    logs: [...memory.logs],
  };
}

function createResumeKey(recipients: string[], batchSize: number) {
  return JSON.stringify({
    recipients,
    batchSize,
  });
}

function createAccountKey(accounts: { id: number }[]) {
  return JSON.stringify(accounts.map((account) => account.id));
}

function getCompletedBatchIndexes(
  completedRecipientIndexes: number[],
  totalRecipients: number,
  batchSize: number,
) {
  const completedSet = new Set(completedRecipientIndexes);
  const totalBatches = Math.ceil(totalRecipients / batchSize);
  const completedBatches: number[] = [];

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
    const start = batchIndex * batchSize;
    const end = Math.min(totalRecipients, start + batchSize);
    let batchComplete = true;

    for (let recipientIndex = start; recipientIndex < end; recipientIndex += 1) {
      if (!completedSet.has(recipientIndex)) {
        batchComplete = false;
        break;
      }
    }

    if (batchComplete) completedBatches.push(batchIndex);
  }

  return completedBatches;
}

async function addLog(
  message: string,
  tone: "normal" | "success" | "warning" = "normal",
) {
  addMemoryLog(message, tone);
}

router.get("/automation/state", async (_req, res, next) => {
  try {
    res.json(getState());
  } catch (error) {
    next(error);
  }
});

router.post("/automation/accounts", async (req, res, next) => {
  try {
    if (isAutomationActive()) {
      return jsonError(
        res,
        409,
        "Stop the active automation before adding accounts.",
      );
    }

    const records = Array.isArray(req.body?.records)
      ? req.body.records
      : [];

    for (const record of records) {
      const email = String(record?.email ?? "").trim();
      const password = String(record?.password ?? "");
      const totp = String(record?.totp ?? "");

      if (!email) continue;

      const exists = memory.accounts.some(
        (account) => account.email.toLowerCase() === email.toLowerCase(),
      );

      if (exists) continue;

      memory.accounts.push({
        id: createAccountId(),
        email,
        password,
        totp,
      });
    }

    await addLog(
      `${records.length} account(s) added.`,
      "success",
    );

    res.json(getState());
  } catch (error) {
    next(error);
  }
});

router.put("/automation/accounts", async (req, res, next) => {
  try {
    if (isAutomationActive()) {
      return jsonError(
        res,
        409,
        "Stop the active automation before replacing accounts.",
      );
    }

    const records = Array.isArray(req.body?.records)
      ? req.body.records
      : [];

    memory.accounts = [];

    for (const record of records) {
      const email = String(record?.email ?? "").trim();

      if (!email) continue;

      memory.accounts.push({
        id: createAccountId(),
        email,
        password: String(record?.password ?? ""),
        totp: String(record?.totp ?? ""),
      });
    }

    await addLog(
      `Account list replaced. ${memory.accounts.length} account(s) loaded.`,
      "success",
    );

    res.json(getState());
  } catch (error) {
    next(error);
  }
});

router.delete("/automation/accounts", async (_req, res, next) => {
  try {
    if (isAutomationActive()) {
      return jsonError(
        res,
        409,
        "Stop the active automation before clearing accounts.",
      );
    }

    memory.accounts = [];

    await addLog("All accounts cleared.", "warning");

    res.json(getState());
  } catch (error) {
    next(error);
  }
});

router.put("/automation/recipients", async (req, res, next) => {
  try {
    if (isAutomationActive()) {
      return jsonError(
        res,
        409,
        "Stop the active automation before changing recipients.",
      );
    }

    const emails = Array.isArray(req.body?.emails)
      ? req.body.emails
          .map((email: unknown) =>
            String(email).trim().toLowerCase(),
          )
          .filter(Boolean)
      : [];

    memory.recipients = Array.from(new Set(emails));
    recipientLookup = new Set(memory.recipients);

    await addLog(
      `Recipients updated. ${memory.recipients.length} recipient(s) loaded.`,
      "success",
    );

    res.json(getState());
  } catch (error) {
    next(error);
  }
});

router.post("/automation/recipients/chunk", async (req, res, next) => {
  try {
    if (isAutomationActive()) {
      return jsonError(
        res,
        409,
        "Stop the active automation before changing recipients.",
      );
    }

    if (!Array.isArray(req.body?.emails)) {
      return jsonError(res, 400, "Recipient emails were not received.");
    }

    let added = 0;

    for (const value of req.body.emails) {
      const email = String(value ?? "").trim().toLowerCase();

      if (!email || recipientLookup.has(email)) {
        continue;
      }

      recipientLookup.add(email);
      memory.recipients.push(email);
      added += 1;
    }

    if (req.body.complete === true) {
      await addLog(
        `Recipients updated. ${memory.recipients.length} recipient(s) loaded.`,
        "success",
      );

      return res.json(getState());
    }

    res.json({
      added,
      total: memory.recipients.length,
    });
  } catch (error) {
    next(error);
  }
});

router.put("/automation/settings", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const batchSize =
      body.batchSize === undefined
        ? undefined
        : Number(body.batchSize) === 1
          ? 1
          : 2;
    const accountRecipientLimit =
      body.accountRecipientLimit === undefined
        ? undefined
        : Number(body.accountRecipientLimit);

    if (
      batchSize !== undefined &&
      isAutomationActive() &&
      batchSize !== memory.settings.batchSize
    ) {
      return jsonError(
        res,
        409,
        "Stop the active automation before changing the batch size.",
      );
    }

    if (
      accountRecipientLimit !== undefined &&
      (!Number.isSafeInteger(accountRecipientLimit) ||
        accountRecipientLimit < 0)
    ) {
      return jsonError(
        res,
        400,
        "Per-account recipient limit must be a whole number of 0 or more.",
      );
    }

    if (
      accountRecipientLimit !== undefined &&
      isAutomationActive() &&
      accountRecipientLimit !== memory.settings.accountRecipientLimit
    ) {
      return jsonError(
        res,
        409,
        "Stop the active automation before changing the per-account recipient limit.",
      );
    }

    if (typeof body.fileName === "string") {
      memory.settings.fileName = body.fileName;
    }

    if (typeof body.subject === "string") {
      memory.settings.subject = body.subject;
    }

    if (typeof body.message === "string") {
      memory.settings.message = body.message;
    }

    if (body.actionDelay !== undefined) {
      memory.settings.actionDelay = Math.max(
        0,
        Number(body.actionDelay) || 0,
      );
    }

    if (body.typingDelay !== undefined) {
      memory.settings.typingDelay = Math.max(
        0,
        Number(body.typingDelay) || 0,
      );
    }

    if (batchSize !== undefined) {
      memory.settings.batchSize = batchSize;
    }

    if (accountRecipientLimit !== undefined) {
      memory.settings.accountRecipientLimit = accountRecipientLimit;
    }

    await addLog("Automation settings updated.");

    res.json(getState());
  } catch (error) {
    next(error);
  }
});

router.post("/automation/run/start", async (_req, res, next) => {
  try {
    if (isAutomationActive()) {
      return jsonError(res, 409, "Automation is already running.");
    }

    if (!memory.accounts.length) {
      return jsonError(res, 400, "No automation accounts configured.");
    }

    const incompleteAccount = memory.accounts.find(
      (account) =>
        !account.email.trim() ||
        !account.password ||
        !account.totp.trim(),
    );

    if (incompleteAccount) {
      return jsonError(
        res,
        400,
        `Account "${incompleteAccount.email || "unknown"}" is missing its password or 2FA secret. Remove it and add it again using email:password:2FA.`,
      );
    }

    if (memory.recipients.length < 1) {
      return jsonError(res, 400, "At least one recipient is required.");
    }

    if (!memory.settings.fileName.trim()) {
      return jsonError(res, 400, "File name is required.");
    }

    if (!memory.settings.subject.trim()) {
      return jsonError(res, 400, "Commit message is required.");
    }

    const runId = createRunId();
    const resumeKey = createResumeKey(
      memory.recipients,
      memory.settings.batchSize,
    );
    const accountKey = createAccountKey(memory.accounts);
    const previousRun = memory.run;
    const canResume =
      previousRun?.status === "stopped" &&
      previousRun.resumeKey === resumeKey;
    const sameAccounts =
      canResume && previousRun.accountKey === accountKey;
    const completedRecipientsByAccount = canResume
      ? { ...previousRun.completedRecipientsByAccount }
      : {};
    const completedRecipientIndexes = canResume
      ? [...previousRun.completedRecipientIndexes]
      : [];
    const completedRecipientIndexSet = new Set(
      completedRecipientIndexes,
    );
    const completedBatches = getCompletedBatchIndexes(
      completedRecipientIndexes,
      memory.recipients.length,
      memory.settings.batchSize,
    );
    const completedBatchSet = new Set(completedBatches);
    const completed = completedBatches.length;
    const totalRecipients = memory.recipients.length;

    memory.run = {
      id: runId,
      status: "running",
      total: Math.ceil(
        memory.recipients.length /
          memory.settings.batchSize,
      ),
      completed,
      totalRecipients,
      completedRecipients: completedRecipientIndexes.length,
      currentAccount: sameAccounts
        ? previousRun.currentAccount
        : 1,
      completedRecipientIndexes,
      completedRecipientsByAccount,
      completedBatches,
      resumeKey,
      accountKey,
      updatedAt: new Date().toISOString(),
    };

    await addLog(
      canResume
        ? `Automation resumed from ${completed} completed batch(es).`
        : "Automation started.",
      "success",
    );

    const accounts = memory.accounts.map((account) => ({
      id: account.id,
      email: account.email,
      password: account.password,
      totp: account.totp,
    }));

    const recipients = [...memory.recipients];

    const workflow = {
      fileName: memory.settings.fileName,
      commitMessage: memory.settings.subject,
      description: memory.settings.message,
    };

    void startAutomation(
      accounts,
      recipients,
      workflow,
      memory.settings.actionDelay,
      memory.settings.typingDelay,
      memory.settings.batchSize,
      memory.settings.accountRecipientLimit,
      completedRecipientIndexes,
      completedRecipientsByAccount,
      {
        onLog: async (message, tone = "normal") => {
          if (memory.run?.id !== runId) return;

          await addLog(message, tone);

          if (memory.run) {
            memory.run.updatedAt = new Date().toISOString();
          }
        },

        onBatchComplete: async (
          accountIndex,
          _batchIndex,
          recipientIndexes,
        ) => {
          if (memory.run?.id !== runId) return;
          const accountId = accounts[accountIndex - 1]?.id;
          if (accountId === undefined) return;

          const newlyCompleted = recipientIndexes.filter(
            (recipientIndex) =>
              !completedRecipientIndexSet.has(recipientIndex),
          );

          if (newlyCompleted.length === 0) return;

          newlyCompleted.forEach((recipientIndex) => {
            completedRecipientIndexSet.add(recipientIndex);
            completedRecipientIndexes.push(recipientIndex);
          });

          for (const recipientIndex of newlyCompleted) {
            const batchIndex = Math.floor(
              recipientIndex / memory.settings.batchSize,
            );
            const batchStart =
              batchIndex * memory.settings.batchSize;
            const batchEnd = Math.min(
              memory.run.totalRecipients,
              batchStart + memory.settings.batchSize,
            );
            let batchComplete = true;

            for (
              let index = batchStart;
              index < batchEnd;
              index += 1
            ) {
              if (!completedRecipientIndexSet.has(index)) {
                batchComplete = false;
                break;
              }
            }

            if (batchComplete) completedBatchSet.add(batchIndex);
          }

          completedRecipientsByAccount[String(accountId)] =
            (completedRecipientsByAccount[String(accountId)] ?? 0) +
            newlyCompleted.length;

          memory.run.completedRecipientIndexes = [
            ...new Set(completedRecipientIndexes),
          ].sort((left, right) => left - right);
          memory.run.completedRecipients =
            memory.run.completedRecipientIndexes.length;
          memory.run.completedBatches = Array.from(
            completedBatchSet,
          ).sort((left, right) => left - right);
          memory.run.completed = memory.run.completedBatches.length;
          memory.run.completedRecipientsByAccount = {
            ...completedRecipientsByAccount,
          };
          memory.run.currentAccount = accountIndex;
          memory.run.updatedAt = new Date().toISOString();
        },

        onAccount: async (accountIndex) => {
          if (memory.run?.id !== runId) return;

          memory.run.currentAccount = accountIndex;
          memory.run.updatedAt = new Date().toISOString();

          await addLog(
            `Starting account ${accountIndex}/${accounts.length}: ${
              accounts[accountIndex - 1]?.email ?? ""
            }`,
          );
        },

        onFinished: async (ok, message) => {
          if (memory.run?.id !== runId) return;

          memory.run.status = ok ? "complete" : "stopped";

          if (ok) {
            memory.run.completed =
              memory.run.total;
            memory.run.completedRecipients =
              memory.run.totalRecipients;
          }

          memory.run.updatedAt = new Date().toISOString();

          await addLog(
            message ??
              (ok
                ? "Automation completed successfully."
                : "Automation failed."),
            ok ? "success" : "warning",
          );
        },
      },
    );

    res.json(getState());
  } catch (error) {
    next(error);
  }
});

router.post("/automation/run/pause", async (_req, res, next) => {
  try {
    const paused = pauseAutomation();

    if (!paused) {
      return jsonError(res, 409, "Automation cannot be paused.");
    }

    if (memory.run) {
      memory.run.status = "paused";
      memory.run.updatedAt = new Date().toISOString();
    }

    await addLog("Automation paused.", "warning");

    res.json(getState());
  } catch (error) {
    next(error);
  }
});

router.post("/automation/run/resume", async (_req, res, next) => {
  try {
    const resumed = resumeAutomation();

    if (!resumed) {
      return jsonError(res, 409, "Automation cannot be resumed.");
    }

    if (memory.run) {
      memory.run.status = "running";
      memory.run.updatedAt = new Date().toISOString();
    }

    await addLog("Automation resumed.", "success");

    res.json(getState());
  } catch (error) {
    next(error);
  }
});

router.post("/automation/run/stop", async (_req, res, next) => {
  try {
    stopAutomation();

    if (memory.run) {
      memory.run.status = "stopped";
      memory.run.updatedAt = new Date().toISOString();
    }

    await addLog("Automation stopped.", "warning");

    res.json(getState());
  } catch (error) {
    next(error);
  }
});

router.post("/automation/run/reset", async (_req, res, next) => {
  try {
    if (isAutomationActive()) {
      return jsonError(
        res,
        409,
        "Stop the active automation before resetting.",
      );
    }

    if (memory.run) {
      memory.run.status = "ready";
      memory.run.completed = 0;
      memory.run.completedRecipients = 0;
      memory.run.currentAccount = 1;
      memory.run.completedRecipientIndexes = [];
      memory.run.completedRecipientsByAccount = {};
      memory.run.completedBatches = [];
      memory.run.updatedAt = new Date().toISOString();
    }

    await addLog("Run reset. Ready for a new automation pass.");

    res.json(getState());
  } catch (error) {
    next(error);
  }
});

router.delete("/automation/logs", async (_req, res, next) => {
  try {
    memory.logs = [];

    res.json(getState());
  } catch (error) {
    next(error);
  }
});

export default router;
