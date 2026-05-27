import { spawn, ChildProcess } from 'node:child_process';
import { mkdir, writeFile, unlink, chmod, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from './env.js';

export type Security = 'SSL/TLS' | 'STARTTLS' | 'None';

export type ImapsyncOptions = {
  source: { host: string; port: number; security: Security; username: string; password: string };
  target: { host: string; port: number; security: Security; username: string; password: string };
  migrationId: string;
  dateFrom?: Date | null;
  dateTo?: Date | null;
  throttleBytesPerSecond?: number;
  enableCache?: boolean;
  reduceBandwidth?: boolean;
};

export type ProgressEvent =
  | { kind: 'folder'; name: string; index: number; total: number }
  | { kind: 'message'; current: number; total: number; folder: string }
  | { kind: 'percent'; percent: number }
  | { kind: 'speed'; emailsPerSec: number; bytesPerSec: number }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string }
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
    '--password1file',
    opts.pw1Path,
    ...securityFlags('host1', opts.source.security),
    '--host2',
    opts.target.host,
    '--port2',
    String(opts.target.port),
    '--user2',
    opts.target.username,
    '--password2file',
    opts.pw2Path,
    ...securityFlags('host2', opts.target.security),
    '--no-modulesversion',
    '--noreleasecheck',
    '--nofoldersizes',
    '--pidfile',
    opts.pidfile,
    '--logdir',
    opts.stateDir,
    '--logfile',
    'imapsync.log',
  ];

  if (opts.reduceBandwidth) args.push('--useuid', '--usecache');
  if (opts.enableCache) args.push('--usecache');
  if (opts.throttleBytesPerSecond) {
    args.push('--maxbytespersecond', String(opts.throttleBytesPerSecond));
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

  const parseLine = (line: string) => {
    const folderMatch = line.match(/Folder\s+(\d+)\/(\d+)\s+\[([^\]]+)\]/);
    if (folderMatch) {
      folderIndex = Number(folderMatch[1]);
      folderTotal = Number(folderMatch[2]);
      currentFolder = folderMatch[3]!;
      onEvent({ kind: 'folder', name: currentFolder, index: folderIndex, total: folderTotal });
      return;
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
