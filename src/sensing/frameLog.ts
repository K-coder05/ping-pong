/**
 * In-memory per-frame log, downloadable as CSV from the debug overlay so
 * thresholds can be tuned from real data (SPEC "Debug overlay").
 *
 * Rows are plain field → value records. Columns are every field seen in any
 * row, in first-seen order, so later code (e.g. the Swing detector) can add
 * fields without touching this module.
 */

export type CsvValue = number | string | boolean | null | undefined;
export type CsvRow = Readonly<Record<string, CsvValue>>;

export interface FrameLog {
  push(row: CsvRow): void;
  /** Number of rows currently held. */
  readonly length: number;
  clear(): void;
  toCsv(): string;
}

/** About 30 minutes at 60 FPS; older frames are dropped beyond this. */
const DEFAULT_MAX_ROWS = 108_000;
const DECIMALS = 6;

export function createFrameLog(options: { maxRows?: number } = {}): FrameLog {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  let rows: CsvRow[] = [];
  /** Index of the oldest kept row; dropped rows are compacted away in bulk. */
  let start = 0;

  return {
    push(row) {
      rows.push(row);
      if (rows.length - start > maxRows) start++;
      if (start >= maxRows) {
        rows = rows.slice(start);
        start = 0;
      }
    },
    get length() {
      return rows.length - start;
    },
    clear() {
      rows = [];
      start = 0;
    },
    toCsv() {
      const kept = rows.slice(start);
      const columns = [...new Set(kept.flatMap((row) => Object.keys(row)))];
      const lines = [columns.map(formatCell).join(',')];
      for (const row of kept) lines.push(columns.map((c) => formatCell(row[c])).join(','));
      return lines.join('\n') + '\n';
    },
  };
}

function formatCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(Number(value.toFixed(DECIMALS))) : '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
