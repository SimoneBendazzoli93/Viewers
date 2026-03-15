/**
 * ReportsPanel
 *
 * Displays saved radiology reports for the current study.
 * Reports are listed newest-first with sequential version IDs (v001, v002, …).
 * The selected report is rendered as Markdown via the shared MarkdownRenderer.
 *
 * Props:
 *   reports       – array of report metadata, newest first
 *   fetchContent  – async function that returns Markdown text for a filename
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ReportEntry } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';

interface Props {
  reports: ReportEntry[];
  fetchContent: (filename: string) => Promise<string | null>;
}

function formatDate(isoStr: string): string {
  try {
    return new Intl.DateTimeFormat('en', {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(isoStr));
  } catch {
    return isoStr;
  }
}

export function ReportsPanel({ reports, fetchContent }: Props) {
  // Track the selected report by filename so selection survives list updates.
  const [selectedFilename, setSelectedFilename] = useState<string | null>(
    reports[0]?.filename ?? null
  );
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const prevLengthRef = useRef(reports.length);

  // Keep a ref to the latest fetchContent so the fetch effect never needs
  // it in its dependency array. Without this, any re-render that produces a
  // new fetchContent reference (even identical in behaviour) cancels the
  // in-flight fetch and restarts it, leaving the panel stuck on "Loading…".
  const fetchContentRef = useRef(fetchContent);
  fetchContentRef.current = fetchContent;

  // When the reports list grows (new report saved), jump to the newest entry.
  useEffect(() => {
    if (reports.length > prevLengthRef.current && reports[0]) {
      setSelectedFilename(reports[0].filename);
    }
    prevLengthRef.current = reports.length;
  }, [reports]);

  // Ensure a valid selection whenever the list changes.
  useEffect(() => {
    if (!selectedFilename && reports[0]) {
      setSelectedFilename(reports[0].filename);
    }
  }, [reports, selectedFilename]);

  // Fetch content whenever the selection changes.
  // Uses fetchContentRef (not the prop directly) so that a new function
  // reference from a parent re-render never cancels an in-flight fetch.
  useEffect(() => {
    if (!selectedFilename) return;
    let cancelled = false;
    setLoading(true);
    setContent(null);
    fetchContentRef.current(selectedFilename).then(c => {
      if (!cancelled) {
        setContent(c);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [selectedFilename]); // intentionally omits fetchContent — see fetchContentRef above

  const handleCopy = useCallback(async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = content;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [content]);

  if (reports.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-sm text-gray-500">
        No reports generated for this study yet.
      </div>
    );
  }

  const selected = reports.find(r => r.filename === selectedFilename) ?? reports[0];

  return (
    <div className="flex h-full flex-col">
      {/* ── Version selector + copy button ─────────────────────────────── */}
      <div className="flex items-center gap-2 border-b border-gray-700 px-3 py-2">
        <select
          value={selectedFilename ?? ''}
          onChange={e => setSelectedFilename(e.target.value)}
          className="min-w-0 flex-1 rounded border border-gray-600 bg-gray-800 px-2 py-1 text-xs text-white focus:border-blue-500 focus:outline-none"
        >
          {reports.map(r => (
            <option key={r.filename} value={r.filename}>
              {`v${String(r.version).padStart(3, '0')} — ${formatDate(r.created_at)}`}
            </option>
          ))}
        </select>
        <button
          onClick={handleCopy}
          disabled={!content}
          title="Copy report Markdown to clipboard"
          className="shrink-0 rounded bg-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-600 disabled:opacity-40"
        >
          {copied ? '✓ Copied' : 'Copy MD'}
        </button>
      </div>

      {/* ── Report body ────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto px-3 py-2">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <span className="animate-spin inline-block">⟳</span>
            <span>Loading report…</span>
          </div>
        ) : content ? (
          <MarkdownRenderer content={content} />
        ) : (
          <p className="text-sm text-gray-500">Failed to load report content.</p>
        )}
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <div className="border-t border-gray-800 px-3 py-1 text-xs text-gray-600">
        {reports.length} report{reports.length !== 1 ? 's' : ''}
        {selected && ` · ${(selected.size / 1024).toFixed(1)} KB`}
      </div>
    </div>
  );
}

export default ReportsPanel;
