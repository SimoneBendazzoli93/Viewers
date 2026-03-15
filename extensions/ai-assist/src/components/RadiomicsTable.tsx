/**
 * RadiomicsTable — virtual-scroll edition
 *
 * Renders only the rows visible in the viewport (+ a small overscan buffer),
 * so the component stays fast even with thousands of features.
 *
 * Layout uses CSS grid divs instead of a real <table> so that:
 *   • The header can be fixed outside the scroll container (always visible).
 *   • Body rows can be absolutely positioned for O(1) scroll updates.
 *   • No "sticky thead inside overflow-auto" hacks are needed.
 *
 * CSV schema (one row per feature, produced by the backend):
 *   study_instance_uid | series_instance_uid | mask_source |
 *   segment | feature_class | feature_name | value
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
  seriesFull: string;  // full UID shown as tooltip
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
      seriesShort:  seriesFull ? `…${seriesFull.slice(-8)}` : '—',
      maskSource:   iMask  >= 0 ? (row[iMask]  ?? '') : '',
      segment:      iSeg   >= 0 ? (row[iSeg]   ?? '') : '',
      featureClass: iClass >= 0 ? (row[iClass] ?? '') : '',
      featureName:  iName  >= 0 ? (row[iName]  ?? '') : '',
      rawValue:     iVal   >= 0 ? (row[iVal]   ?? '') : '',
    };
  });
}

// ── Display helpers ───────────────────────────────────────────────────────────

const CLASS_LABELS: Record<string, string> = {
  firstorder: '1st Order',
  shape:      'Shape',
  glcm:       'GLCM',
  glrlm:      'GLRLM',
  glszm:      'GLSZM',
  ngtdm:      'NGTDM',
  gldm:       'GLDM',
};
const labelClass = (cls: string) => CLASS_LABELS[cls.toLowerCase()] ?? cls;

function formatValue(v: string): string {
  const n = parseFloat(v);
  if (isNaN(n)) return v;
  if (Number.isInteger(n)) return n.toString();
  if (Math.abs(n) >= 1e5 || (Math.abs(n) < 1e-3 && n !== 0)) return n.toExponential(3);
  return parseFloat(n.toFixed(5)).toString();
}

// ── Virtual scroll constants ──────────────────────────────────────────────────

/** Pixel height of every data row — must match the CSS below. */
const ROW_H = 26;
/** Rows rendered above and below the visible window. */
const OVERSCAN = 8;

/**
 * CSS grid column template shared by the header and every body row.
 * Columns: Class | Feature | Segment | Source | Series | Value
 */
const GRID = '60px 1fr 72px 72px 65px 72px';

// Shared class strings (avoid repetition).
const CELL  = 'flex items-center overflow-hidden px-2 text-xs text-gray-300 whitespace-nowrap';
const HCELL = 'flex items-center px-2 py-1.5 text-xs font-medium text-gray-400 whitespace-nowrap';

// ── Component ─────────────────────────────────────────────────────────────────

export function RadiomicsTable({ csvText }: { csvText: string }) {
  const [search, setSearch]   = useState('');
  const [copied, setCopied]   = useState(false);
  const [startIdx, setStartIdx] = useState(0);
  const [bodyHeight, setBodyHeight] = useState(600);

  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Data ──────────────────────────────────────────────────────────────────

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

  const filteredRows = useMemo(() => {
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

  // ── Scroll / resize tracking ──────────────────────────────────────────────

  // Measure the scroll container height so we know how many rows to paint.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBodyHeight(el.clientHeight));
    ro.observe(el);
    setBodyHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Reset scroll and start index when search changes.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setStartIdx(0);
  }, [filteredRows]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Only update startIdx when it actually changes (every ROW_H pixels).
    const next = Math.max(0, Math.floor(el.scrollTop / ROW_H) - OVERSCAN);
    setStartIdx(prev => (prev === next ? prev : next));
  }, []);

  // ── Visible slice ─────────────────────────────────────────────────────────

  const visibleCount = Math.ceil(bodyHeight / ROW_H) + OVERSCAN * 2;
  const endIdx = Math.min(filteredRows.length - 1, startIdx + visibleCount);
  const visibleRows = filteredRows.slice(startIdx, endIdx + 1);
  const totalHeight = filteredRows.length * ROW_H;

  // ── Copy ──────────────────────────────────────────────────────────────────

  const handleCopy = useCallback(async () => {
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
  }, [csvText]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full flex-col">

      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-gray-700 px-3 py-2">
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

      {/* Fixed header row — outside the scroll container so it never moves */}
      <div
        style={{ display: 'grid', gridTemplateColumns: GRID }}
        className="shrink-0 border-b border-gray-700 bg-gray-900"
      >
        <div className={HCELL}>Class</div>
        <div className={HCELL}>Feature</div>
        <div className={HCELL}>Segment</div>
        <div className={HCELL}>Source</div>
        <div className={HCELL}>Series</div>
        <div className={`${HCELL} justify-end`}>Value</div>
      </div>

      {/* Virtual scroll body */}
      {filteredRows.length === 0 ? (
        <p className="flex-1 p-4 text-center text-sm text-gray-500">
          {allRows.length === 0
            ? 'No radiomics features found in CSV.'
            : 'No features match the current filter.'}
        </p>
      ) : (
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-auto"
        >
          {/* Spacer that gives the scrollbar the correct total height */}
          <div style={{ height: totalHeight, position: 'relative' }}>
            {visibleRows.map((row, i) => {
              const absIdx = startIdx + i;
              return (
                <div
                  key={absIdx}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: GRID,
                    position: 'absolute',
                    top: absIdx * ROW_H,
                    height: ROW_H,
                    width: '100%',
                  }}
                  className="border-b border-gray-800/60 hover:bg-gray-800/30"
                >
                  <div className={CELL}>{labelClass(row.featureClass)}</div>
                  <div className={CELL}>{row.featureName}</div>
                  <div className={CELL}>{row.segment}</div>
                  <div className={CELL}>{row.maskSource}</div>
                  <div className={CELL} title={row.seriesFull}>{row.seriesShort}</div>
                  <div className={`${CELL} justify-end font-mono tabular-nums`}>
                    {formatValue(row.rawValue)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="shrink-0 border-t border-gray-800 px-3 py-1 text-xs text-gray-600">
        {filteredRows.length}
        {filteredRows.length !== allRows.length ? ` / ${allRows.length}` : ''}
        {' features'}
        {` · showing rows ${startIdx + 1}–${Math.min(endIdx + 1, filteredRows.length)}`}
      </div>
    </div>
  );
}

export default RadiomicsTable;
