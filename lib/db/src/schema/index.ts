import {
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const automationAccountsTable = pgTable("automation_accounts", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  encryptedPassword: text("encrypted_password").notNull(),
  encryptedTotp: text("encrypted_totp").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const automationRecipientsTable = pgTable("automation_recipients", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const automationSettingsTable = pgTable("automation_settings", {
  key: text("key").primaryKey(),
  fileName: text("file_name").notNull().default(""),
  subject: text("subject").notNull().default("Update README"),
  message: text("message").notNull().default("Your commit message..."),
  actionDelay: integer("action_delay").notNull().default(700),
  typingDelay: integer("typing_delay").notNull().default(35),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const automationRunsTable = pgTable("automation_runs", {
  id: serial("id").primaryKey(),
  status: text("status").notNull(),
  total: integer("total").notNull(),
  completed: integer("completed").notNull().default(0),
  currentAccount: integer("current_account"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const automationLogsTable = pgTable("automation_logs", {
  id: serial("id").primaryKey(),
  runId: integer("run_id"),
  message: text("message").notNull(),
  tone: text("tone").notNull().default("normal"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});