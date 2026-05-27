import { describe, it, expect } from 'vitest';
import { buildImapsyncArgs, daysSince, type BuildArgsInput } from './imapsync.js';

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
  it('passes passwords via --password1file/--password2file, never on argv', () => {
    const args = buildImapsyncArgs(baseInput);
    // Files must be present
    expect(args).toContain('--password1file');
    expect(args).toContain('--password2file');
    expect(args[args.indexOf('--password1file') + 1]).toBe('/tmp/.pw1');
    expect(args[args.indexOf('--password2file') + 1]).toBe('/tmp/.pw2');
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
