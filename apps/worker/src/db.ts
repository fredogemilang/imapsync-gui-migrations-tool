import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  pgTable,
  serial,
  text,
  integer,
  bigint,
  timestamp,
  jsonb,
  uuid,
} from 'drizzle-orm/pg-core';
import { env } from './env.js';

export const admin = pgTable('admin', { id: serial('id').primaryKey() });

export const imapAccount = pgTable('imap_account', {
  id: uuid('id').primaryKey(),
  label: text('label'),
  type: text('type').notNull(),
  host: text('host').notNull(),
  port: integer('port').notNull(),
  security: text('security').notNull(),
  username: text('username').notNull(),
  passwordEnc: text('password_enc').notNull(),
});

export const migration = pgTable('migration', {
  id: uuid('id').primaryKey(),
  sourceAccountId: uuid('source_account_id').notNull(),
  targetAccountId: uuid('target_account_id').notNull(),
  status: text('status').notNull(),
  settings: jsonb('settings').notNull(),
  dateFrom: timestamp('date_from', { withTimezone: true }),
  dateTo: timestamp('date_to', { withTimezone: true }),
  totalEmails: integer('total_emails').notNull(),
  migratedEmails: integer('migrated_emails').notNull(),
  totalBytes: bigint('total_bytes', { mode: 'number' }).notNull(),
  progressPercent: integer('progress_percent').notNull(),
  currentFolder: text('current_folder'),
  jobId: text('job_id'),
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }),
});

export const migrationFolder = pgTable('migration_folder', {
  id: serial('id').primaryKey(),
  migrationId: uuid('migration_id').notNull(),
  name: text('name').notNull(),
  totalEmails: integer('total_emails').notNull(),
  totalBytes: bigint('total_bytes', { mode: 'number' }).notNull(),
  migratedEmails: integer('migrated_emails').notNull(),
  status: text('status').notNull(),
});

export const migrationLog = pgTable('migration_log', {
  id: serial('id').primaryKey(),
  migrationId: uuid('migration_id').notNull(),
  ts: timestamp('ts', { withTimezone: true }),
  level: text('level').notNull(),
  message: text('message').notNull(),
});

export const bulkMigration = pgTable('bulk_migration', {
  id: uuid('id').primaryKey(),
  sourceHost: text('source_host').notNull(),
  sourcePort: integer('source_port').notNull(),
  sourceSecurity: text('source_security').notNull(),
  targetHost: text('target_host').notNull(),
  targetPort: integer('target_port').notNull(),
  targetSecurity: text('target_security').notNull(),
  settings: jsonb('settings').notNull(),
  status: text('status').notNull(),
});

export const bulkPair = pgTable('bulk_pair', {
  id: serial('id').primaryKey(),
  bulkId: uuid('bulk_id').notNull(),
  sourceUsername: text('source_username').notNull(),
  sourcePasswordEnc: text('source_password_enc').notNull(),
  targetUsername: text('target_username').notNull(),
  targetPasswordEnc: text('target_password_enc').notNull(),
  status: text('status').notNull(),
  progressPercent: integer('progress_percent').notNull(),
  migratedEmails: integer('migrated_emails').notNull(),
  totalEmails: integer('total_emails').notNull(),
  error: text('error'),
});

const client = postgres({
  host: env.POSTGRES_HOST,
  port: env.POSTGRES_PORT,
  user: env.POSTGRES_USER,
  password: env.POSTGRES_PASSWORD,
  database: env.POSTGRES_DB,
});

export const db = drizzle(client);
