import { unescapeFormulaCell } from './tsv-formula-escape.mjs';

export const SCAN_HISTORY_COLUMNS = Object.freeze([
  'url',
  'first_seen',
  'portal',
  'title',
  'company',
  'status',
  'location',
  'fingerprint',
  'posted_at',
  'trust_score',
  'trust_flags',
  'normalized_company',
  'requisition_id',
  'language',
]);

export function parseScanHistoryLine(line) {
  const cells = String(line ?? '').split('\t');
  return Object.fromEntries(SCAN_HISTORY_COLUMNS.map((name, i) => [name, unescapeFormulaCell(cells[i] ?? '')]));
}

export function scanHistoryLineHasColumn(line, column) {
  const index = SCAN_HISTORY_COLUMNS.indexOf(column);
  if (index === -1) throw new Error(`scan-history-columns: unknown column "${column}"`);
  return String(line ?? '').split('\t').length > index;
}
