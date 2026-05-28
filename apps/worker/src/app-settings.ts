import { eq } from 'drizzle-orm';
import { appSetting, db } from './db.js';
import type { EmailHeaderSetting } from './imapsync.js';

/**
 * Resolves the active email-header strategy for a job. Per-migration
 * `settings.emailHeaderSettings` wins if set; otherwise we fall back to
 * the global `app_setting.emailHeaderSettings` (configured via the
 * Settings page). When neither is set we use `'default'` — imapsync's
 * native no-op behaviour.
 *
 * Called at job-start time so settings changes in the UI immediately
 * affect any subsequently dispatched migration / sync tick, without
 * needing to copy settings into the migration row at creation time.
 */
export async function resolveEmailHeaderSetting(
  migrationSettings: Record<string, unknown> | null | undefined,
): Promise<EmailHeaderSetting> {
  const explicit = migrationSettings?.emailHeaderSettings;
  if (
    explicit === 'default' ||
    explicit === 'Strip Custom Headers' ||
    explicit === 'Keep All Headers'
  ) {
    return explicit;
  }
  // Fall back to global setting.
  const rows = await db.select().from(appSetting).where(eq(appSetting.key, 'emailHeaderSettings'));
  const v = rows[0]?.value;
  if (v === 'default' || v === 'Strip Custom Headers' || v === 'Keep All Headers') {
    return v;
  }
  return 'default';
}

/** Resolves retentionDays (0 = Never Delete) from app_setting.
 *  Default fallback: 30 days. */
export async function resolveRetentionDays(): Promise<number> {
  const rows = await db.select().from(appSetting).where(eq(appSetting.key, 'retentionDays'));
  const v = rows[0]?.value;
  if (typeof v === 'number' && v >= 0) return v;
  return 30;
}
