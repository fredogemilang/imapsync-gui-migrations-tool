import { describe, it, expect } from 'vitest';
import {
  buildImapsyncArgs,
  classifyImapsyncLine,
  daysSince,
  extractMessageBytes,
  type BuildArgsInput,
} from './imapsync.js';

const baseInput: BuildArgsInput = {
  source: { host: 'src.example.com', port: 993, security: 'SSL/TLS', username: 'u1' },
  target: { host: 'tgt.example.com', port: 993, security: 'SSL/TLS', username: 'u2' },
  migrationId: 'mig-1',
  pw1Path: '/tmp/.pw1',
  pw2Path: '/tmp/.pw2',
  pidfile: '/tmp/pid',
  stateDir: '/tmp/state',
};

describe('buildImapsyncArgs — credential safety (finding #1)', () => {
  it('passes passwords via --passfile1/--passfile2, never on argv', () => {
    const args = buildImapsyncArgs(baseInput);
    // Files must be present
    expect(args).toContain('--passfile1');
    expect(args).toContain('--passfile2');
    expect(args[args.indexOf('--passfile1') + 1]).toBe('/tmp/.pw1');
    expect(args[args.indexOf('--passfile2') + 1]).toBe('/tmp/.pw2');
    // CLI flags that take passwords inline MUST NOT appear
    expect(args).not.toContain('--password1');
    expect(args).not.toContain('--password2');
  });

  it('does not contain any literal password string from input', () => {
    const args = buildImapsyncArgs(baseInput);
    // We never even pass passwords into BuildArgsInput, but assert defensively
    const joined = args.join(' ');
    expect(joined).not.toMatch(/password.*=.*[a-z]/i);
  });
});

describe('buildImapsyncArgs — dedup flags (finding #4)', () => {
  it('does NOT add contradictory --useheader/--skipheader Message-Id', () => {
    const args = buildImapsyncArgs(baseInput);
    expect(args).not.toContain('--useheader');
    expect(args).not.toContain('--skipheader');
  });
});

describe('buildImapsyncArgs — partial date filter (finding #7)', () => {
  // Fix "now" so daysSince is deterministic
  const now = new Date('2026-05-27T00:00:00Z').getTime();

  it('emits no date args when both dateFrom/dateTo are null/undefined', () => {
    const args = buildImapsyncArgs({ ...baseInput, now });
    expect(args).not.toContain('--maxage');
    expect(args).not.toContain('--minage');
  });

  it('emits only --maxage when only dateFrom is set', () => {
    const args = buildImapsyncArgs({
      ...baseInput,
      now,
      dateFrom: new Date('2024-01-01T00:00:00Z'),
    });
    expect(args).toContain('--maxage');
    expect(args).not.toContain('--minage');
    // Roughly 877 days between 2024-01-01 and 2026-05-27
    const idx = args.indexOf('--maxage');
    expect(Number(args[idx + 1])).toBeGreaterThan(800);
    expect(Number(args[idx + 1])).toBeLessThan(900);
  });

  it('emits only --minage when only dateTo is set', () => {
    const args = buildImapsyncArgs({
      ...baseInput,
      now,
      dateTo: new Date('2024-06-01T00:00:00Z'),
    });
    expect(args).toContain('--minage');
    expect(args).not.toContain('--maxage');
  });

  it('emits both bounds when both dates are real, with correct mapping', () => {
    const args = buildImapsyncArgs({
      ...baseInput,
      now,
      dateFrom: new Date('2024-01-01T00:00:00Z'), // oldest allowed → maxage
      dateTo: new Date('2024-06-01T00:00:00Z'), // newest allowed → minage
    });
    const maxageVal = Number(args[args.indexOf('--maxage') + 1]);
    const minageVal = Number(args[args.indexOf('--minage') + 1]);
    // maxage (from dateFrom) must be > minage (from dateTo) — i.e. the range
    // includes messages aged between minage and maxage days.
    expect(maxageVal).toBeGreaterThan(minageVal);
  });

  it('ignores invalid Date objects (NaN getTime)', () => {
    const args = buildImapsyncArgs({
      ...baseInput,
      now,
      dateFrom: new Date('not-a-date'),
      dateTo: new Date('also-bad'),
    });
    expect(args).not.toContain('--maxage');
    expect(args).not.toContain('--minage');
  });
});

describe('buildImapsyncArgs — security flags by transport', () => {
  it('SSL/TLS → --ssl1/--ssl2', () => {
    const args = buildImapsyncArgs(baseInput);
    expect(args).toContain('--ssl1');
    expect(args).toContain('--ssl2');
  });

  it('STARTTLS → --tls1/--tls2', () => {
    const args = buildImapsyncArgs({
      ...baseInput,
      source: { ...baseInput.source, security: 'STARTTLS' },
      target: { ...baseInput.target, security: 'STARTTLS' },
    });
    expect(args).toContain('--tls1');
    expect(args).toContain('--tls2');
    expect(args).not.toContain('--ssl1');
  });

  it('None → no transport security flag added', () => {
    const args = buildImapsyncArgs({
      ...baseInput,
      source: { ...baseInput.source, security: 'None' },
      target: { ...baseInput.target, security: 'None' },
    });
    expect(args).not.toContain('--ssl1');
    expect(args).not.toContain('--tls1');
    expect(args).not.toContain('--ssl2');
    expect(args).not.toContain('--tls2');
  });
});

describe('buildImapsyncArgs — throttle & cache toggles', () => {
  it('throttleBytesPerSecond → --maxbytespersecond', () => {
    const args = buildImapsyncArgs({ ...baseInput, throttleBytesPerSecond: 12345 });
    expect(args).toContain('--maxbytespersecond');
    expect(args[args.indexOf('--maxbytespersecond') + 1]).toBe('12345');
  });

  it('enableCache → --usecache', () => {
    const args = buildImapsyncArgs({ ...baseInput, enableCache: true });
    expect(args).toContain('--usecache');
  });

  it('reduceBandwidth → --useuid + --usecache', () => {
    const args = buildImapsyncArgs({ ...baseInput, reduceBandwidth: true });
    expect(args).toContain('--useuid');
    expect(args).toContain('--usecache');
  });
});

describe('buildImapsyncArgs — emailHeaderSettings (finding: wire app_setting → imapsync)', () => {
  it('does NOT add --regexhead when omitted or "default"', () => {
    expect(buildImapsyncArgs(baseInput)).not.toContain('--regexhead');
    expect(
      buildImapsyncArgs({ ...baseInput, emailHeaderSettings: 'default' }),
    ).not.toContain('--regexhead');
  });

  it('does NOT add --regexhead for "Keep All Headers" — that\'s imapsync\'s natural behaviour', () => {
    expect(
      buildImapsyncArgs({ ...baseInput, emailHeaderSettings: 'Keep All Headers' }),
    ).not.toContain('--regexhead');
  });

  it('adds --regexhead with X-* strip pattern for "Strip Custom Headers"', () => {
    const args = buildImapsyncArgs({
      ...baseInput,
      emailHeaderSettings: 'Strip Custom Headers',
    });
    expect(args).toContain('--regexhead');
    const idx = args.indexOf('--regexhead');
    const pattern = args[idx + 1]!;
    // Sanity: regex begins with s/ (Perl substitute syntax), targets X-,
    // and the m flag is present so ^ anchors per-line.
    expect(pattern.startsWith('s/^X-')).toBe(true);
    expect(pattern.endsWith('/mg')).toBe(true);
  });
});

describe('buildImapsyncArgs — syncDuplicates', () => {
  it('default (off) does not add --useuid', () => {
    const args = buildImapsyncArgs(baseInput);
    expect(args).not.toContain('--useuid');
  });

  it('on → adds --useuid', () => {
    const args = buildImapsyncArgs({ ...baseInput, syncDuplicates: true });
    expect(args).toContain('--useuid');
  });

  it('with reduceBandwidth, only one --useuid flag is added', () => {
    const args = buildImapsyncArgs({
      ...baseInput,
      syncDuplicates: true,
      reduceBandwidth: true,
    });
    const useuidCount = args.filter((a) => a === '--useuid').length;
    expect(useuidCount).toBe(1);
  });
});

describe('classifyImapsyncLine — per-folder stats parser', () => {
  it('classifies a typical "copied" log line', () => {
    expect(classifyImapsyncLine('+ msg INBOX/123 [4567] {1234} copied to host2')).toBe('copied');
    expect(classifyImapsyncLine('Copying msg INBOX/45 {678}')).toBe('copied');
  });

  it('classifies "already on host2" / skip lines as skipped', () => {
    expect(classifyImapsyncLine('+ msg INBOX/12 already on host2')).toBe('skipped');
    expect(classifyImapsyncLine('Skipping msg INBOX/3 {99}')).toBe('skipped');
  });

  it('classifies NOK / per-message error lines as failed', () => {
    expect(classifyImapsyncLine('+ NOK msg INBOX/5 {123}: rejected')).toBe('failed');
    expect(classifyImapsyncLine('Error msg INBOX/7: APPEND failed')).toBe('failed');
  });

  it('returns null for global summary lines without a per-message marker', () => {
    // These are end-of-run aggregates — we MUST NOT double-count them or the
    // per-folder tally explodes.
    expect(classifyImapsyncLine('Messages skipped                       : 0')).toBeNull();
    expect(classifyImapsyncLine('Total bytes transferred                : 12345')).toBeNull();
    expect(classifyImapsyncLine('+++ Statistics')).toBeNull();
  });

  it('returns null for folder-boundary and informational lines', () => {
    expect(classifyImapsyncLine('Folder 1/6 [INBOX]')).toBeNull();
    expect(classifyImapsyncLine('Host1 IMAP server: imap.example.com')).toBeNull();
    expect(classifyImapsyncLine('')).toBeNull();
  });

  it('prefers "skipped" over "copied" when both words appear', () => {
    // imapsync sometimes prints "not copied because already on host2".
    // Order in the classifier matters — we test it.
    expect(classifyImapsyncLine('+ msg INBOX/1 {12} not copied: already on host2')).toBe(
      'skipped',
    );
  });
});

describe('extractMessageBytes — {N} size tag parser', () => {
  it('extracts size from a copied message line', () => {
    expect(extractMessageBytes('+ msg INBOX/123 {12345} copied to host2')).toBe(12345);
  });

  it('returns 0 when no {N} tag is present', () => {
    expect(extractMessageBytes('Folder 1/6 [INBOX]')).toBe(0);
    expect(extractMessageBytes('')).toBe(0);
  });

  it('grabs the first {N} match when multiple appear', () => {
    // Some imapsync versions print both source and target sizes on one line.
    // We accept the first — it's the source-message size.
    expect(extractMessageBytes('msg INBOX/1 {5000} -> Sent/3 {5100} copied')).toBe(5000);
  });

  it('returns 0 for malformed / non-numeric size tags', () => {
    // {N} with non-digits is not a real imapsync tag; regex won't match
    // because we require \d+, so the result is correctly 0.
    expect(extractMessageBytes('msg INBOX/1 {abc} copied')).toBe(0);
  });

  it('handles large messages (>4 GB safely as a JS number)', () => {
    // 5 GiB literal — Number can represent this exactly (< 2^53).
    expect(extractMessageBytes('msg HUGE/1 {5368709120} copied')).toBe(5368709120);
  });
});

describe('daysSince', () => {
  it('computes whole days between dates', () => {
    const now = new Date('2026-05-27T12:00:00Z').getTime();
    expect(daysSince(new Date('2026-05-26T12:00:00Z'), now)).toBe(1);
    expect(daysSince(new Date('2026-05-20T12:00:00Z'), now)).toBe(7);
  });

  it('clamps negative (future date) to 0', () => {
    const now = new Date('2026-05-27T00:00:00Z').getTime();
    expect(daysSince(new Date('2026-12-01T00:00:00Z'), now)).toBe(0);
  });
});
