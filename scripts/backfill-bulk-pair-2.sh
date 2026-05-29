#!/bin/sh
# Backfill pair-2 (andrea.peresthu) stats from the existing imapsync.log
# on disk into the new bulk_pair columns. Run AFTER Dokploy deploys the
# commit that adds the columns.
#
# Stats parsed from /var/lib/imapsync/bulk-<bulkId>-pair-2/imapsync.log:
#   Folders synced            : 9/9
#   Messages transferred      : 55,294
#   Messages skipped          : 26 (skipped because unfetchable from source)
#   Total bytes transferred   : 4,826,607,132 (4.495 GiB)
#   Detected 26 errors        → failed_emails
#   Exit code 115             → EXIT_ERR_FETCH
#
# Status flipped from 'failed' to 'completed_with_errors' since the bulk
# of the mailbox actually copied — exit 115 just means imapsync gave up
# on 26 unfetchable source-side messages.
#
# Usage: ssh javaserver bash -s < backfill-bulk-pair-2.sh
set -e

POSTGRES_CONTAINER="javanegra-mail-server-email-migration-tool-drptzh-postgres-1"

docker exec "$POSTGRES_CONTAINER" psql -U emt -d emt -c "
UPDATE bulk_pair
SET
  status            = 'completed_with_errors',
  total_emails      = 55320,
  migrated_emails   = 55294,
  migrated_bytes    = 4826607132,
  failed_emails     = 26,
  total_folders     = 9,
  folders_synced    = 9,
  exit_code         = 115,
  progress_percent  = 100,
  error             = 'imapsync exited with code 115 (EXIT_ERR_FETCH) — 26 source messages were unfetchable; the bulk of the mailbox migrated. See Initial Migration Log for details.'
WHERE id = 2
RETURNING id, status, migrated_emails, failed_emails, exit_code;
"
