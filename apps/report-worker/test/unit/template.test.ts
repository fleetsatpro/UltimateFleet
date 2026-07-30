import { describe, expect, it } from 'vitest';
import { periodLabel, renderReportHtml } from '../../src/template.js';

/**
 * The template must be deterministic and escaping-safe — the two properties the PDF's byte-identity
 * (AC5) and its safety depend on.
 */
describe('report template', () => {
  it('renders identically for identical input (no hidden timestamps)', () => {
    const view = {
      clientName: 'Client A1',
      periodLabel: '2026-09-01 to 2026-09-30',
      rows: [
        ['alarm_events', '12'],
        ['patrol_scans', '48'],
      ] as ReadonlyArray<readonly [string, string]>,
    };
    expect(renderReportHtml(view)).toBe(renderReportHtml(view));
  });

  it('escapes interpolated values', () => {
    const html = renderReportHtml({
      clientName: '<script>alert(1)</script>',
      periodLabel: 'x',
      rows: [['k', '<b>v</b>']],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;v&lt;/b&gt;');
  });

  it('builds a dates-only period label', () => {
    expect(periodLabel(new Date('2026-09-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'))).toBe(
      '2026-09-01 to 2026-10-01',
    );
  });
});
