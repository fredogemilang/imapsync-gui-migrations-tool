import { spawn, ChildProcess } from 'node:child_process';
import { mkdir, writeFile, unlink, chmod, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from './env.js';

export type Security = 'SSL/TLS' | 'STARTTLS' | 'None';

export type EmailHeaderSetting = 'default' | 'Strip Custom Headers' | 'Keep All Headers';

export type ImapsyncOptions = {
  source: { host: string; port: number; security: Security; username: string; password: string };
  target: { host: string; port: number; security: Security; username: string; password: string };
  migrationId: string;
  dateFrom?: Date | null;
  dateTo?: Date | null;
  throttleBytesPerSecond?: number;
  enableCache?: boolean;
  reduceBandwidth?: boolean;
  /** When true, imapsync matches by UID instead of Message-Id headers, so
   *  duplicate copies in source (same Message-Id but different UIDs) all get
   *  migrated. Off by default → imapsync's normal header-based dedup. */
  syncDuplicates?: boolean;
  /** Header processing intent, drawn from app_setting.emailHeaderSettings:
   *   - "default" / "Keep All Headers" → no extra flags (imapsync preserves
   *     headers by default)
   *   - "Strip Custom Headers" → `--regexhead` regex that removes X-* lines */
  emailHeaderSettings?: EmailHeaderSetting;
};

export type ProgressEvent =
  | { kind: 'folder'; name: string; index: number; total: number }
  | { kind: 'message'; current: number; total: number; folder: string }
  | { kind: 'percent'; percent: number }
  | { kind: 'speed'; emailsPerSec: number; bytesPerSec: number }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  /** Per-folder tally emitted when imapsync moves to the next folder (or
   *  on close for the last folder). Counts are derived from imapsync's
   *  per-message stdout lines — see parseLine() for the regex contract.
   *  `bytes` is the sum of `{N}` size tags on lines classified as 'copied',
   *  giving an authoritative "bytes actually moved" figure even for source
   *  servers that don't advertise IMAP STATUS=SIZE (RFC 8438). */
  | {
      kind: 'folder-stats';
      name: string;
      copied: number;
      skipped: number;
      failed: number;
      bytes: number;
    }
  | { kind: 'done'; ok: boolean; error?: string };

// Narrowed to the literal union so any drift (lowercase, mistyped) is a
// compile-time error. The previous `sec: string` allowed silent fall-through
// to no-TLS connections.
function securityFlags(prefix: 'host1' | 'host2', sec: Security): string[] {
  if (sec === 'SSL/TLS') return [`--ssl${prefix === 'host1' ? '1' : '2'}`];
  if (sec === 'STARTTLS') return [`--tls${prefix === 'host1' ? '1' : '2'}`];
  return [];
}

export function daysSince(d: Date, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - d.getTime()) / 86_400_000));
}

/**
 * Pure classifier for a single imapsync stdout line. Pulled out of parseLine
 * so the regex contract is unit-testable without spawning a subprocess.
 *
 * Returns the per-message outcome the line announces, or null when the line
 * is a header / global-summary / progress tick. The regex set is permissive
 * because imapsync's output format varies across versions — we err on the
 * side of "if we can't tell, don't count it".
 *
 * Rules (evaluated in order):
 *   1. Line must mention a specific message (`msg foo/123` or a `{N}` size
 *      tag). This excludes global summary lines like "Messages skipped: 0".
 *   2. NOK marker or "Error msg ..." → failed
 *   3. Mentions "already" / "skipping" / "skipped" → skipped
 *   4. Mentions "copied" or starts with "Copying" → copied
 */
/**
 * Pull the message size in bytes out of an imapsync stdout line, if present.
 * imapsync prefixes message-level operations with a `{N}` size tag (the IMAP
 * literal-length convention). Returns 0 when the tag is missing or malformed
 * — that's not a fatal condition, we just won't count bytes for that line.
 */
export function extractMessageBytes(line: string): number {
  const m = line.match(/\{(\d+)\}/);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export type LineClassification = 'copied' | 'skipped' | 'failed' | null;
export function classifyImapsyncLine(line: string): LineClassification {
  const hasMsgMarker = /\bmsg\s+\S+[/:]\d+/i.test(line) || /\{\d+\}/.test(line);
  if (!hasMsgMarker) return null;
  if (/^\+?\s*NOK\b/i.test(line) || /Error\s+msg\b/i.test(line)) return 'failed';
  if (/\b(?:already|skipped|skipping)\b/i.test(line)) return 'skipped';
  if (/\bcopied\b/i.test(line) || /^\+?\s*Copying\b/i.test(line)) return 'copied';
  return null;
}

export type BuildArgsInput = Omit<ImapsyncOptions, 'source' | 'target'> & {
  source: Omit<ImapsyncOptions['source'], 'password'>;
  target: Omit<ImapsyncOptions['target'], 'password'>;
  pw1Path: string;
  pw2Path: string;
  pidfile: string;
  stateDir: string;
  now?: number;
};

/**
 * Pure function that builds the imapsync CLI argv. Extracted for unit testing
 * — the bug class we fixed in code-review (#1 credential leak, #4 dedup flags,
 * #7 partial date filter) lives here.
 */
export function buildImapsyncArgs(opts: BuildArgsInput): string[] {
  const args: string[] = [
    '--host1',
    opts.source.host,
    '--port1',
    String(opts.source.port),
    '--user1',
    opts.source.username,
    '--passfile1',
    opts.pw1Path,
    ...securityFlags('host1', opts.source.security),
    '--host2',
    opts.target.host,
    '--port2',
    String(opts.target.port),
    '--user2',
    opts.target.username,
    '--passfile2',
    opts.pw2Path,
    ...securityFlags('host2', opts.target.security),
    '--noreleasecheck',
    '--nofoldersizes',
    '--pidfile',
    opts.pidfile,
    '--log',
    '--logdir',
    opts.stateDir,
    '--logfile',
    'imapsync.log',
  ];

  if (opts.reduceBandwidth) args.push('--useuid', '--usecache');
  // Sync Duplicates: match by source UID, so multiple source copies of the
  // same Message-Id each get migrated. Without this flag imapsync's default
  // header-based dedup collapses them to one. (reduceBandwidth already adds
  // --useuid, so we don't double-add.)
  if (opts.syncDuplicates && !opts.reduceBandwidth) args.push('--useuid');
  if (opts.enableCache) args.push('--usecache');
  if (opts.throttleBytesPerSecond) {
    args.push('--maxbytespersecond', String(opts.throttleBytesPerSecond));
  }

  // Email header strategy. We only emit a regex for "Strip Custom Headers"
  // because imapsync's default behaviour already preserves every header
  // bit-for-bit, so "default" and "Keep All Headers" are no-ops.
  //
  // The regex matches lines beginning with "X-" headers — the X- prefix
  // convention for non-standard / vendor-specific headers (X-Mailer,
  // X-Spam-Status, X-Originating-IP, etc.). RFC 822 standard headers
  // (From, To, Subject, Received, Authentication-Results...) are
  // preserved. `m` flag = multi-line so ^ anchors per-line.
  if (opts.emailHeaderSettings === 'Strip Custom Headers') {
    args.push('--regexhead', 's/^X-[A-Za-z0-9-]+:[^\\r\\n]*\\r?\\n//mg');
  }

  // Date filter — only emit a bound when the matching date is real.
  // imapsync semantics:
  //   --maxage N = sync only messages newer than N days  (oldest allowed)
  //   --minage N = sync only messages older than N days  (newest allowed)
  if (opts.dateFrom instanceof Date && !isNaN(opts.dateFrom.getTime())) {
    args.push('--maxage', String(daysSince(opts.dateFrom, opts.now)));
  }
  if (opts.dateTo instanceof Date && !isNaN(opts.dateTo.getTime())) {
    args.push('--minage', String(daysSince(opts.dateTo, opts.now)));
  }

  return args;
}

export type ImapsyncHandle = {
  child: ChildProcess;
  cleanup: () => Promise<void>;
};

/**
 * Boot-time sweep — removes orphan password tempfiles from prior crashed runs.
 * Plaintext credentials must never linger on disk; this is the safety net for
 * SIGKILL / OOM / `docker kill` paths where the normal cleanup doesn't run.
 * Files older than `staleAfterMs` (default 5 min) are removed regardless of
 * whether a migration with that ID is still active — a live migration writes
 * its own files fresh, so stale-by-time is safe.
 */
export async function sweepOrphanTempfiles(
  rootDir: string = env.IMAPSYNC_STATE_DIR,
  staleAfterMs: number = 5 * 60_000,
): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(rootDir);
  } catch {
    return 0;
  }
  const now = Date.now();
  for (const entry of entries) {
    const dir = join(rootDir, entry);
    for (const name of ['.pw1', '.pw2'] as const) {
      const path = join(dir, name);
      try {
        const s = await stat(path);
        if (now - s.mtimeMs > staleAfterMs) {
          await unlink(path);
          removed++;
        }
      } catch {
        // not present — fine
      }
    }
  }
  return removed;
}

/**
 * Run imapsync. Returns a handle exposing the child process and a `cleanup`
 * function that MUST be awaited after the child closes — it removes the
 * password tempfiles. If anything throws BEFORE the child is spawned, the
 * partial tempfiles are unlinked in this function's catch — guaranteeing no
 * orphan tempfiles in the synchronous failure path. Async failures (SIGKILL)
 * are covered by `sweepOrphanTempfiles` on next worker boot.
 *
 * Dedup: imapsync's default behavior already skips messages already present on
 * the target. We do NOT pass --useheader/--skipheader — those configure the
 * dedup hash, and forcing them produces inconsistent matching.
 */
export async function runImapsync(
  opts: ImapsyncOptions,
  onEvent: (e: ProgressEvent) => void,
): Promise<ImapsyncHandle> {
  const stateDir = join(env.IMAPSYNC_STATE_DIR, opts.migrationId);
  const pw1Path = join(stateDir, '.pw1');
  const pw2Path = join(stateDir, '.pw2');
  const pidfile = join(stateDir, 'imapsync.pid');

  const tryUnlinkAll = async () => {
    await unlink(pw1Path).catch(() => {});
    await unlink(pw2Path).catch(() => {});
  };

  try {
    await mkdir(stateDir, { recursive: true });

    // Clean up any stale pidfile from a previous (possibly SIGKILLed) run.
    // imapsync refuses to start if the pidfile exists; this prevents resume
    // from getting stuck after worker crashes.
    await unlink(pidfile).catch(() => {});

    await writeFile(pw1Path, opts.source.password, { mode: 0o600 });
    await writeFile(pw2Path, opts.target.password, { mode: 0o600 });
    // Defensive chmod (umask may widen).
    await chmod(pw1Path, 0o600);
    await chmod(pw2Path, 0o600);
  } catch (e) {
    // Any preparation failure must not leave plaintext credentials on disk.
    await tryUnlinkAll();
    throw e;
  }

  const args = buildImapsyncArgs({
    source: {
      host: opts.source.host,
      port: opts.source.port,
      security: opts.source.security,
      username: opts.source.username,
    },
    target: {
      host: opts.target.host,
      port: opts.target.port,
      security: opts.target.security,
      username: opts.target.username,
    },
    migrationId: opts.migrationId,
    dateFrom: opts.dateFrom,
    dateTo: opts.dateTo,
    throttleBytesPerSecond: opts.throttleBytesPerSecond,
    enableCache: opts.enableCache,
    reduceBandwidth: opts.reduceBandwidth,
    pw1Path,
    pw2Path,
    pidfile,
    stateDir,
  });

  let child: ChildProcess;
  try {
    child = spawn('imapsync', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // spawn can throw synchronously for ENOENT (imapsync binary missing) or
    // permission errors. Same invariant: no plaintext left behind.
    await tryUnlinkAll();
    throw e;
  }

  // Once spawn returned a child handle, the cleanup is the caller's
  // responsibility via the returned handle.cleanup. We still attach an
  // 'error' listener that unlinks on async spawn errors (rare — usually we
  // get a sync throw above).
  child.once('error', () => {
    void tryUnlinkAll();
  });

  let folderTotal = 0;
  let folderIndex = 0;
  let currentFolder = '';
  let lastProgress = Date.now();
  let bytesSinceLast = 0;
  let msgsSinceLast = 0;

  // Per-folder tallies — flushed as a 'folder-stats' event when imapsync
  // moves to the next folder (or in close handler for the last one).
  //
  // imapsync's per-message stdout format varies by version, so the regexes
  // below try to be permissive. They count a line as:
  //   - copied   if it announces a successful message copy
  //   - skipped  if it announces "already" on host2 / dedupe-skip
  //   - failed   if imapsync prefixes the line with `NOK ` or `Error:`
  // The line MUST also mention "msg <folder>/<uid>" or contain a {size}
  // tag so we don't accidentally count global summary lines.
  const folderCopied: Record<string, number> = {};
  const folderSkipped: Record<string, number> = {};
  const folderFailed: Record<string, number> = {};
  const folderBytes: Record<string, number> = {};
  const bump = (m: Record<string, number>, k: string): void => {
    m[k] = (m[k] ?? 0) + 1;
  };
  const flushFolderStats = (name: string): void => {
    if (!name) return;
    onEvent({
      kind: 'folder-stats',
      name,
      copied: folderCopied[name] ?? 0,
      skipped: folderSkipped[name] ?? 0,
      failed: folderFailed[name] ?? 0,
      bytes: folderBytes[name] ?? 0,
    });
  };

  const parseLine = (line: string) => {
    const folderMatch = line.match(/Folder\s+(\d+)\/(\d+)\s+\[([^\]]+)\]/);
    if (folderMatch) {
      const nextName = folderMatch[3]!;
      // Flush the previous folder's tally before swapping context. We only
      // flush on a *real* swap so the same "Folder X/Y [foo]" line repeated
      // mid-folder doesn't double-emit zero counts.
      if (currentFolder && currentFolder !== nextName) {
        flushFolderStats(currentFolder);
      }
      folderIndex = Number(folderMatch[1]);
      folderTotal = Number(folderMatch[2]);
      currentFolder = nextName;
      onEvent({ kind: 'folder', name: currentFolder, index: folderIndex, total: folderTotal });
      return;
    }

    // Classify per-message outcome using the extracted pure helper so the
    // regex contract is unit-tested in imapsync.test.ts. Only 'copied' lines
    // contribute to migratedBytes — bytes from skipped messages were already
    // on target, and failed bytes were never moved.
    if (currentFolder) {
      const kind = classifyImapsyncLine(line);
      if (kind === 'failed') bump(folderFailed, currentFolder);
      else if (kind === 'skipped') bump(folderSkipped, currentFolder);
      else if (kind === 'copied') {
        bump(folderCopied, currentFolder);
        folderBytes[currentFolder] = (folderBytes[currentFolder] ?? 0) + extractMessageBytes(line);
      }
    }

    const msgMatch = line.match(/(?:msg|Message)\s+\S+[/:](\d+)/i);
    if (msgMatch) {
      msgsSinceLast++;
      const sizeMatch = line.match(/\{(\d+)\}/);
      if (sizeMatch) bytesSinceLast += Number(sizeMatch[1]);
    }

    if (/error|failed|cannot/i.test(line)) {
      onEvent({ kind: 'log', level: 'error', message: line.trim() });
    }

    const now = Date.now();
    if (now - lastProgress >= 1000) {
      const dt = (now - lastProgress) / 1000;
      const eps = msgsSinceLast / dt;
      const bps = bytesSinceLast / dt;
      if (folderTotal > 0) {
        const percent = Math.min(99, Math.floor(((folderIndex - 0.5) / folderTotal) * 100));
        onEvent({ kind: 'percent', percent });
      }
      onEvent({ kind: 'speed', emailsPerSec: eps, bytesPerSec: bps });
      msgsSinceLast = 0;
      bytesSinceLast = 0;
      lastProgress = now;
    }
  };

  let buf = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const ln of lines) parseLine(ln);
  });
  child.stderr!.on('data', (chunk: Buffer) => {
    onEvent({ kind: 'log', level: 'warn', message: chunk.toString('utf8').trim() });
  });

  let closed = false;
  child.on('close', (code, signal) => {
    if (closed) return;
    closed = true;
    if (buf.length) parseLine(buf);
    // Flush the FINAL folder's tally — the next-folder boundary that would
    // normally trigger this never arrives for the last folder in a run.
    if (currentFolder) flushFolderStats(currentFolder);
    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      onEvent({ kind: 'done', ok: false, error: 'cancelled' });
    } else if (code === 0) {
      onEvent({ kind: 'percent', percent: 100 });
      onEvent({ kind: 'done', ok: true });
    } else {
      onEvent({ kind: 'done', ok: false, error: `imapsync exited with code ${code}` });
    }
  });

  return { child, cleanup: tryUnlinkAll };
}
