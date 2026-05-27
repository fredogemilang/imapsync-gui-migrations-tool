import {
  pgTable,
  serial,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  jsonb,
  uuid,
} from 'drizzle-orm/pg-core';

export const admin = pgTable('admin', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const imapAccount = pgTable('imap_account', {
  id: uuid('id').defaultRandom().primaryKey(),
  label: text('label'),
  // type: IMAP | Microsoft | Google | Yahoo | iCloud
  type: text('type').notNull().default('IMAP'),
  host: text('host').notNull(),
  port: integer('port').notNull().default(993),
  // security: SSL/TLS | STARTTLS | None
  security: text('security').notNull().default('SSL/TLS'),
  username: text('username').notNull(),
  // AES-256-GCM ciphertext (iv:tag:ciphertext base64)
  passwordEnc: text('password_enc').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const migration = pgTable('migration', {
  id: uuid('id').defaultRandom().primaryKey(),
  sourceAccountId: uuid('source_account_id')
    .notNull()
    .references(() => imapAccount.id, { onDelete: 'cascade' }),
  targetAccountId: uuid('target_account_id')
    .notNull()
    .references(() => imapAccount.id, { onDelete: 'cascade' }),
  // queued | scanning | running | paused | completed | failed | cancelled
  status: text('status').notNull().default('queued'),
  settings: jsonb('settings')
    .$type<MigrationSettings>()
    .notNull()
    .default({} as any),
  dateFrom: timestamp('date_from', { withTimezone: true }),
  dateTo: timestamp('date_to', { withTimezone: true }),
  totalEmails: integer('total_emails').notNull().default(0),
  migratedEmails: integer('migrated_emails').notNull().default(0),
  totalBytes: bigint('total_bytes', { mode: 'number' }).notNull().default(0),
  /** Bytes actually copied to target. Derived from imapsync's per-message
   *  `{N}` size tags so it works even when the source server doesn't advertise
   *  IMAP STATUS=SIZE (RFC 8438) — in which case totalBytes is 0. */
  migratedBytes: bigint('migrated_bytes', { mode: 'number' }).notNull().default(0),
  progressPercent: integer('progress_percent').notNull().default(0),
  currentFolder: text('current_folder'),
  jobId: text('job_id'),
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  // Sync state — controls Auto Sync / Backup Mode / one-off Sync Now.
  //   off    — no scheduled sync (default)
  //   auto   — repeats every syncIntervalMs until syncEndsAt (10-day cap)
  //   backup — repeats every syncIntervalMs forever (until user disables)
  syncMode: text('sync_mode').notNull().default('off'),
  syncIntervalMs: bigint('sync_interval_ms', { mode: 'number' }),
  syncEndsAt: timestamp('sync_ends_at', { withTimezone: true }),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  syncRunning: boolean('sync_running').notNull().default(false),
});

export const migrationFolder = pgTable('migration_folder', {
  id: serial('id').primaryKey(),
  migrationId: uuid('migration_id')
    .notNull()
    .references(() => migration.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  totalEmails: integer('total_emails').notNull().default(0),
  totalBytes: bigint('total_bytes', { mode: 'number' }).notNull().default(0),
  migratedEmails: integer('migrated_emails').notNull().default(0),
  /** Bytes actually copied — accumulated from imapsync stdout, see migration.migratedBytes. */
  migratedBytes: bigint('migrated_bytes', { mode: 'number' }).notNull().default(0),
  /** Messages imapsync detected as already present on target (deduped). */
  skippedEmails: integer('skipped_emails').notNull().default(0),
  /** Messages that errored during copy. */
  failedEmails: integer('failed_emails').notNull().default(0),
  status: text('status').notNull().default('pending'),
});

export const migrationLog = pgTable('migration_log', {
  id: serial('id').primaryKey(),
  migrationId: uuid('migration_id')
    .notNull()
    .references(() => migration.id, { onDelete: 'cascade' }),
  ts: timestamp('ts', { withTimezone: true }).defaultNow().notNull(),
  level: text('level').notNull().default('info'),
  message: text('message').notNull(),
});

export const bulkMigration = pgTable('bulk_migration', {
  id: uuid('id').defaultRandom().primaryKey(),
  sourceHost: text('source_host').notNull(),
  sourcePort: integer('source_port').notNull().default(993),
  sourceSecurity: text('source_security').notNull().default('SSL/TLS'),
  targetHost: text('target_host').notNull(),
  targetPort: integer('target_port').notNull().default(993),
  targetSecurity: text('target_security').notNull().default('SSL/TLS'),
  settings: jsonb('settings')
    .$type<MigrationSettings>()
    .notNull()
    .default({} as any),
  status: text('status').notNull().default('queued'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const bulkPair = pgTable('bulk_pair', {
  id: serial('id').primaryKey(),
  bulkId: uuid('bulk_id')
    .notNull()
    .references(() => bulkMigration.id, { onDelete: 'cascade' }),
  sourceUsername: text('source_username').notNull(),
  sourcePasswordEnc: text('source_password_enc').notNull(),
  targetUsername: text('target_username').notNull(),
  targetPasswordEnc: text('target_password_enc').notNull(),
  /** Per-pair sync/backup intent captured at submit time from the UI
   *  checkboxes. Currently stored only — wiring these to scheduled syncs
   *  after each pair's migration completes is future work. */
  syncEnabled: boolean('sync_enabled').notNull().default(false),
  backupEnabled: boolean('backup_enabled').notNull().default(false),
  status: text('status').notNull().default('pending'),
  progressPercent: integer('progress_percent').notNull().default(0),
  migratedEmails: integer('migrated_emails').notNull().default(0),
  totalEmails: integer('total_emails').notNull().default(0),
  error: text('error'),
});

export const appSetting = pgTable('app_setting', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
});

/**
 * In-app notifications. Written by the worker on noteworthy events
 * (migration done/failed, bulk done/partial, sync failure, retention
 * sweep summary). The Notifications bell in the header polls
 * `/api/notifications` for unread rows.
 *
 * FK with onDelete:cascade so deleting a migration or bulk_migration
 * automatically purges related notifications — keeps the bell clean.
 *
 * `kind` is a free-text string in DB so we can add new event kinds
 * without a schema change; the UI maps known kinds to colours/icons.
 */
export const notification = pgTable('notification', {
  id: uuid('id').defaultRandom().primaryKey(),
  /** 'success' | 'error' | 'warning' | 'info' — UI dictates rendering. */
  kind: text('kind').notNull().default('info'),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  /** Where clicking the notification should navigate (e.g. /migrations/:id).
   *  Null = no link (e.g. retention sweep summary). */
  linkPath: text('link_path'),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  /** Optional FK back to the related row so cascade-delete keeps the
   *  inbox clean when the user deletes a migration / bulk. */
  migrationId: uuid('migration_id').references(() => migration.id, { onDelete: 'cascade' }),
  bulkId: uuid('bulk_id').references(() => bulkMigration.id, { onDelete: 'cascade' }),
});

export type MigrationSettings = {
  autoSync?: boolean;
  backupMode?: boolean;
  /** Repeat interval when Backup Mode is enabled. Defaults to 'daily'. */
  backupInterval?: 'daily' | 'weekly' | 'monthly';
  throttleEnabled?: boolean;
  throttleGbPerDay?: number;
  syncDuplicates?: boolean;
  enableCache?: boolean;
  reduceBandwidth?: boolean;
  dateFilterEnabled?: boolean;
  dateFrom?: string;
  dateTo?: string;
};
