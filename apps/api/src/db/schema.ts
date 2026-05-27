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
  progressPercent: integer('progress_percent').notNull().default(0),
  currentFolder: text('current_folder'),
  jobId: text('job_id'),
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
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

export type MigrationSettings = {
  autoSync?: boolean;
  backupMode?: boolean;
  throttleEnabled?: boolean;
  throttleGbPerDay?: number;
  syncDuplicates?: boolean;
  enableCache?: boolean;
  reduceBandwidth?: boolean;
  dateFilterEnabled?: boolean;
  dateFrom?: string;
  dateTo?: string;
};
