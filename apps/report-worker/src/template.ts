/**
 * The report HTML template.
 *
 * DETERMINISTIC by construction: it interpolates only the aggregated data and the period, with no
 * `Date.now()`, no random ids, no generation timestamp. That is what lets the same frozen data
 * render to a byte-identical PDF on every run (acceptance criterion 5) — a property that quietly
 * dies the moment a "Generated at {now}" line is added, which is exactly why it is not.
 *
 * All interpolated values are HTML-escaped: report data is derived from vendor payloads and guard
 * input, so an un-escaped field is a stored-XSS vector into whoever opens the PDF's HTML source.
 */
export interface ReportView {
  readonly clientName: string;
  readonly periodLabel: string;
  readonly rows: ReadonlyArray<readonly [string, string]>;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderReportHtml(view: ReportView): string {
  const rows = view.rows
    .map(
      ([label, value]) =>
        `<tr><td>${escapeHtml(label)}</td><td class="v">${escapeHtml(value)}</td></tr>`,
    )
    .join('');
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><style>',
    'body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:32px}',
    'h1{font-size:20px;margin:0 0 4px}p{color:#555;margin:0 0 16px}',
    'table{border-collapse:collapse;width:100%}',
    'td{border:1px solid #ccc;padding:6px 10px;font-size:13px}',
    'td.v{text-align:right;font-variant-numeric:tabular-nums}',
    '</style></head><body>',
    `<h1>${escapeHtml(view.clientName)}</h1>`,
    `<p>Security report — ${escapeHtml(view.periodLabel)}</p>`,
    `<table><tbody>${rows}</tbody></table>`,
    '</body></html>',
  ].join('');
}

/** A deterministic period label from the run's window (dates only, no time-of-generation). */
export function periodLabel(periodStart: Date, periodEnd: Date): string {
  return `${periodStart.toISOString().slice(0, 10)} to ${periodEnd.toISOString().slice(0, 10)}`;
}
