/**
 * RadiomicsTable
 *
 * Displays the radiomics CSV produced by the backend in a flat per-feature
 * table.  The CSV schema (one row per feature) is:
 *
 *   study_instance_uid | series_instance_uid | mask_source |
 *   segment | feature_class | feature_name | value
 *
 * Each CSV row becomes one table row with columns:
 *   Class · Feature · Segment · Source · Series · Value
 *
 * The series UID is abbreviated to "…<last-8-chars>" — the full UID is
 * available as a tooltip on hover.
 */
import React, { useMemo, useState } from 'react';

// ── CSV parsing ───────────────────────────────────────────────────────────────

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') {
      inQ = !inQ;
    } else if (ch === ',' && !inQ) {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

interface FlatRow {
  seriesShort: string; // "…last8chars" shown in cell
  seriesFull: string;  // full UID shown in tooltip
  maskSource: string;
  segment: string;
  featureClass: string;
  featureName: string;
  rawValue: string;
}

function parseRadiomicsCSV(csv: string): FlatRow[] {
  const lines = csv.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
  const col = (name: string) => headers.indexOf(name);

  const iSeries = col('series_instance_uid');
  const iMask   = col('mask_source');
  const iSeg    = col('segment');
  const iClass  = col('feature_class');
  const iName   = col('feature_name');
  const iVal    = col('value');

  return lines.slice(1).map(parseCSVLine).map(row => {
    const seriesFull = iSeries >= 0 ? (row[iSeries] ?? '') : '';
    return {
      seriesFull,
      seriesShort: seriesFull ? `…${seriesFull.slice(-8)}` : '—',
      maskSource:   iMask  >= 0 ? (row[iMask]  ?? '') : '',
      segment:      iSeg   >= 0 ? (row[iSeg]   ?? '') : '',
      featureClass: iClass >= 0 ? (row[iClass] ?? '') : '',
      featureName:  iName  >= 0 ? (row[iName]  ?? '') : '',
      rawValue:     iVal   >= 0 ? (row[iVal]   ?? '') : '',
    };
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const CLASS_LABELS: Record<string, string> = {
  firstorder: '1st Order',
  shape:      'Shape',
  glcm:       'GLCM',
  glrlm:      'GLRLM',
  glszm:      'GLSZM',
  ngtdm:      'NGTDM',
  gldm:       'GLDM',
};

function labelClass(cls: string): string {
  return CLASS_LABELS[cls.toLowerCase()] ?? cls;
}

function formatValue(v: string): string {
  const n = parseFloat(v);
  if (isNaN(n)) return v;
  if (Number.isInteger(n)) return n.toString();
  if (Math.abs(n) >= 1e5 || (Math.abs(n) < 1e-3 && n !== 0)) return n.toExponential(3);
  return parseFloat(n.toFixed(5)).toString();
}

// Tiny table-cell helpers to keep JSX readable.
function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={`border-b border-gray-700 px-2 py-1.5 font-medium text-gray-400 whitespace-nowrap ${
        right ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  right,
  mono,
  title,
}: {
  children: React.ReactNode;
  right?: boolean;
  mono?: boolean;
  title?: string;
}) {
  return (
    <td
      title={title}
      className={`px-2 py-1 text-gray-300 ${right ? 'text-right' : ''} ${
        mono ? 'font-mono tabular-nums' : ''
      }`}
    >
      {children}
    </td>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  csvText: string;
}

export function RadiomicsTable({ csvText }: Props) {
  const [search, setSearch] = useState('');
  const [copied, setCopied] = useState(false);

  // Parse and sort once per CSV change.
  const allRows = useMemo(() => {
    const rows = parseRadiomicsCSV(csvText);
    rows.sort(
      (a, b) =>
        a.segment.localeCompare(b.segment) ||
        a.featureClass.localeCompare(b.featureClass) ||
        a.featureName.localeCompare(b.featureName)
    );
    return rows;
  }, [csvText]);

  const visibleRows = useMemo(() => {
    if (!search) return allRows;
    const q = search.toLowerCase();
    return allRows.filter(
      r =>
        r.featureClass.toLowerCase().includes(q) ||
        r.featureName.toLowerCase().includes(q) ||
        r.segment.toLowerCase().includes(q) ||
        r.maskSource.toLowerCase().includes(q)
    );
  }, [allRows, search]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(csvText);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = csvText;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex h-full flex-col">
      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 border-b border-gray-700 px-3 py-2">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search class, feature, segment…"
          className="min-w-0 flex-1 rounded border border-gray-600 bg-gray-800 px-2 py-1 text-xs text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
        />
        <button
          onClick={handleCopy}
          title="Copy raw CSV to clipboard"
          className="shrink-0 rounded bg-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-600"
        >
          {copied ? '✓ Copied' : 'Copy CSV'}
        </button>
      </div>

      {/* ── Table ───────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto">
        {visibleRows.length === 0 ? (
          <p className="p-4 text-center text-sm text-gray-500">
            {allRows.length === 0
              ? 'No radiomics features found in CSV.'
              : 'No features match the current filter.'}
          </p>
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-gray-900">
              <tr>
                <Th>Class</Th>
                <Th>Feature</Th>
                <Th>Segment</Th>
                <Th>Source</Th>
                <Th>Series</Th>
                <Th right>Value</Th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, i) => (
                <tr
                  key={i}
                  className="border-t border-gray-800/60 hover:bg-gray-800/30"
                >
                  <Td>{labelClass(row.featureClass)}</Td>
                  <Td>{row.featureName}</Td>
                  <Td>{row.segment}</Td>
                  <Td>{row.maskSource}</Td>
                  <Td title={row.seriesFull}>{row.seriesShort}</Td>
                  <Td right mono>{formatValue(row.rawValue)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <div className="border-t border-gray-800 px-3 py-1 text-xs text-gray-600">
        {visibleRows.length}
        {visibleRows.length !== allRows.length ? ` / ${allRows.length}` : ''}
        {' features'}
      </div>
    </div>
  );
}

export default RadiomicsTable;
