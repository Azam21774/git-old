export type MemoryAccount = {
  id: number;
  email: string;
  password: string;
  totp: string;
};

export type MemorySettings = {
  fileName: string;
  subject: string;
  message: string;
  actionDelay: number;
  typingDelay: number;
  batchSize: 1 | 2;
  accountRecipientLimit: number;
};

export type MemoryRun = {
  id: number;
  status: "ready" | "running" | "paused" | "complete" | "stopped";
  total: number;
  completed: number;
  totalRecipients: number;
  completedRecipients: number;
  currentAccount: number;
  completedRecipientIndexes: number[];
  completedRecipientsByAccount: Record<string, number>;
  completedBatches: number[];
  resumeKey: string;
  accountKey: string;
  updatedAt: string;
};

export type MemoryLog = {
  id: number;
  time: string;
  message: string;
  tone: "normal" | "success" | "warning";
};

export const memory: {
  accounts: MemoryAccount[];
  recipients: string[];
  settings: MemorySettings;
  run: MemoryRun | null;
  logs: MemoryLog[];
} = {
  accounts: [],

  recipients: [],

  settings: {
    fileName: "",
    subject: "Update README",
    message: "Your commit message...",
    actionDelay: 700,
    typingDelay: 35,
    batchSize: 2,
    accountRecipientLimit: 0,
  },

  run: null,

  logs: [],
};

let nextAccountId = 1;
let nextRunId = 1;
let nextLogId = 1;

export function createAccountId() {
  return nextAccountId++;
}

export function createRunId() {
  return nextRunId++;
}

export function addLog(
  message: string,
  tone: "normal" | "success" | "warning" = "normal",
) {
  memory.logs.unshift({
    id: nextLogId++,
    time: new Date().toISOString(),
    message,
    tone,
  });

  if (memory.logs.length > 80) {
    memory.logs.length = 80;
  }
}
