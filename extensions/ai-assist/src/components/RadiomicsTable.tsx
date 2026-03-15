/**
 * RadiomicsTable
 *
 * Displays a pyradiomics CSV result as a searchable, grouped feature table.
 * Features are grouped by (filter, class) — e.g. "original_firstorder" →
 * "First Order" — and sorted by diagnostic relevance order.
 *
 * Supports:
 *   • Free-text search over feature names
 *   • Toggle to show / hide diagnostics metadata columns
 *   • Copy raw CSV to clipboard
 *   • Multiple extraction labels (one value column per mask label)
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

interface ParsedRadiomics {
  /** Column header for each data row — derived from the Mask filename. */
  rowLabels: string[];
  features: {
    name: string;
    /** Internal group key, e.g. "original_firstorder" or "__diagnostics". */
    group: string;
    /** One value string per data row. */
    values: string[];
  }[];
}

function getFeatureGroup(name: string): string {
  if (name.startsWith('diagnostics_')) return '__diagnostics';
  const parts = name.split('_');
  // Handle "wavelet-LLH_glcm_Feature" → "wavelet-LLH_glcm"
  return parts.length >= 2 ? `${parts[0]}_${parts[1]}` : name;
}

function parseRadiomicsCSV(csv: string): ParsedRadiomics {
  const lines = csv.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return { rowLabels: [], features: [] };

  const headers = parseCSVLine(lines[0]);
  const dataRows = lines.slice(1).map(parseCSVLine);

  // Use the Mask column as the row label; fall back to row index.
  const maskIdx = headers.findIndex(h => h.toLowerCase() === 'mask');
  const rowLabels = dataRows.map((row, i) => {
    const raw = maskIdx >= 0 ? (row[maskIdx] ?? '') : '';
    if (raw) {
      const fname = raw.replace(/\\/g, '/').split('/').pop() ?? raw;
      return fname.replace(/\.[^.]+$/, '');
    }
    return `Label ${i + 1}`;
  });

  const skip = new Set(['image', 'mask']);
  const features = headers
    .map((name, idx) => ({
      name,
      group: getFeatureGroup(name),
      values: dataRows.map(row => row[idx] ?? ''),
    }))
    .filter(f => !skip.has(f.name.toLowerCase()));

  return { rowLabels, features };
}

// ── Group display helpers ─────────────────────────────────────────────────────

const GROUP_PRIORITY: string[] = [
  'original_shape',
  'original_firstorder',
  'original_glcm',
  'original_glrlm',
  'original_glszm',
  'original_ngtdm',
  'original_gldm',
];

const GROUP_LABELS: Record<string, string> = {
  __diagnostics: 'Diagnostics',
  original_shape: 'Shape',
  original_firstorder: 'First Order',
  original_glcm: 'GLCM',
  original_glrlm: 'GLRLM',
  original_glszm: 'GLSZM',
  original_ngtdm: 'NGTDM',
  original_gldm: 'GLDM',
};

function formatGroupLabel(group: string): string {
  if (GROUP_LABELS[group]) return GROUP_LABELS[group];
  // "wavelet-LLH_glcm" → "GLCM (wavelet-LLH)"
  const under = group.indexOf('_');
  if (under !== -1) {
    const filter = group.slice(0, under);
    const cls = group.slice(under + 1).toUpperCase();
    return filter === 'original' ? cls : `${cls} (${filter})`;
  }
  return group;
}

function sortGroups(groups: string[]): string[] {
  const priority = new Map(GROUP_PRIORITY.map((g, i) => [g, i]));
  return [...groups].sort((a, b) => {
    // Diagnostics always last
    if (a === '__diagnostics') return 1;
    if (b === '__diagnostics') return -1;
    const pa = priority.get(a) ?? Infinity;
    const pb = priority.get(b) ?? Infinity;
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });
}

// ── Value formatting ──────────────────────────────────────────────────────────

function formatValue(v: string): string {
  const n = parseFloat(v);
  if (isNaN(n)) return v;
  if (Number.isInteger(n)) return n.toString();
  if (Math.abs(n) >= 1e5 || (Math.abs(n) < 1e-3 && n !== 0)) {
    return n.toExponential(3);
  }
  // Remove trailing zeros after rounding to 5 decimal places.
  return parseFloat(n.toFixed(5)).toString();
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  csvText: string;
}

export function RadiomicsTable({ csvText }: Props) {
  const [search, setSearch] = useState('');
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [copied, setCopied] = useState(false);

  const parsed = useMemo(() => parseRadiomicsCSV(csvText), [csvText]);

  const visibleFeatures = useMemo(() => {
    return parsed.features.filter(f => {
      if (!showDiagnostics && f.group === '__diagnostics') return false;
      if (search) return f.name.toLowerCase().includes(search.toLowerCase());
      return true;
    });
  }, [parsed.features, showDiagnostics, search]);

  const sortedGroups = useMemo(() => {
    const groups = [...new Set(visibleFeatures.map(f => f.group))];
    return sortGroups(groups);
  }, [visibleFeatures]);

  const byGroup = useMemo(() => {
    const map = new Map<string, typeof visibleFeatures>();
    for (const f of visibleFeatures) {
      const arr = map.get(f.group) ?? [];
      arr.push(f);
      map.set(f.group, arr);
    }
    return map;
  }, [visibleFeatures]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(csvText);
    } catch {
      // Fallback for restricted browser contexts.
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
          placeholder="Search features…"
          className="min-w-0 flex-1 rounded border border-gray-600 bg-gray-800 px-2 py-1 text-xs text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
        />
        <label className="flex shrink-0 cursor-pointer select-none items-center gap-1 text-xs text-gray-400">
          <input
            type="checkbox"
            checked={showDiagnostics}
            onChange={e => setShowDiagnostics(e.target.checked)}
            className="accent-blue-500"
          />
          Diagnostics
        </label>
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
        {visibleFeatures.length === 0 ? (
          <p className="p-4 text-center text-sm text-gray-500">
            {parsed.features.length === 0
              ? 'No radiomics features found in CSV.'
              : 'No features match the current filter.'}
          </p>
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-gray-900">
              <tr>
                <th className="border-b border-gray-700 px-3 py-1.5 text-left font-medium text-gray-400">
                  Feature
                </th>
                {parsed.rowLabels.map((label, i) => (
                  <th
                    key={i}
                    className="border-b border-gray-700 px-3 py-1.5 text-right font-medium text-gray-400"
                    title={label}
                  >
                    {label.length > 18 ? `${label.slice(0, 16)}…` : label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedGroups.map(group => (
                <React.Fragment key={group}>
                  {/* Group header row */}
                  <tr className="bg-gray-800/50">
                    <td
                      colSpan={parsed.rowLabels.length + 1}
                      className="px-3 py-1 text-xs font-semibold uppercase tracking-wider text-blue-400"
                    >
                      {formatGroupLabel(group)}
                    </td>
                  </tr>
                  {/* Feature rows */}
                  {(byGroup.get(group) ?? []).map(f => (
                    <tr
                      key={f.name}
                      className="border-t border-gray-800/60 hover:bg-gray-800/30"
                    >
                      <td
                        className="px-3 py-1 font-mono text-gray-300"
                        title={f.name}
                      >
                        {f.name}
                      </td>
                      {f.values.map((v, i) => (
                        <td
                          key={i}
                          className="px-3 py-1 text-right font-mono tabular-nums text-gray-200"
                        >
                          {formatValue(v)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <div className="border-t border-gray-800 px-3 py-1 text-xs text-gray-600">
        {visibleFeatures.length}
        {visibleFeatures.length !== parsed.features.length
          ? ` / ${parsed.features.length} features`
          : ' features'}
        {parsed.rowLabels.length > 1 ? ` · ${parsed.rowLabels.length} labels` : ''}
      </div>
    </div>
  );
}

export default RadiomicsTable;
