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
          currentAccount: memory.run.currentAccount,
          completedByAccount: {
            ...memory.run.completedByAccount,
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

    if (body.batchSize !== undefined) {
      memory.settings.batchSize =
        Number(body.batchSize) === 1 ? 1 : 2;
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
    const completedByAccount = sameAccounts
      ? { ...previousRun.completedByAccount }
      : {};
    const completedBatches = canResume
      ? [...previousRun.completedBatches]
      : [];
    const completed = completedBatches.length;

    memory.run = {
      id: runId,
      status: "running",
      total: Math.ceil(
        memory.recipients.length /
          memory.settings.batchSize,
      ),
      completed,
      currentAccount: sameAccounts
        ? previousRun.currentAccount
        : 1,
      completedByAccount,
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
      completedBatches,
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
          batchIndex,
        ) => {
          if (memory.run?.id !== runId) return;

          completedByAccount[
            String(accountIndex)
          ] =
            (completedByAccount[
              String(accountIndex)
            ] ?? 0) + 1;

          if (
            !completedBatches.includes(batchIndex)
          ) {
            completedBatches.push(batchIndex);
          }

          memory.run.completed =
            completedBatches.length;
          memory.run.completedBatches = [
            ...completedBatches,
          ].sort((left, right) => left - right);
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
      memory.run.currentAccount = 1;
      memory.run.completedByAccount = {};
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
