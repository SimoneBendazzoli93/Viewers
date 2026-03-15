/**
 * ReportsPanel — pure display component.
 *
 * All async fetching is owned by PanelAIAssistant, which passes the already-
 * resolved content (or loading/error state) down as props.  This component
 * has no effects and no async logic of its own, which makes it immune to the
 * mount/unmount and stale-closure issues that plagued the previous design.
 *
 * Props:
 *   reports          – array of report metadata, newest first
 *   selectedFilename – currently selected report filename (controlled)
 *   onSelectFilename – callback when the user picks a different version
 *   content          – Markdown text of the selected report, or null
 *   loading          – true while the fetch is in progress
 */
import React, { useCallback, useState } from 'react';
import type { ReportEntry } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';

interface Props {
  reports: ReportEntry[];
  selectedFilename: string | null;
  onSelectFilename: (filename: string) => void;
  content: string | null;
  loading: boolean;
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

export function ReportsPanel({ reports, selectedFilename, onSelectFilename, content, loading }: Props) {
  const [copied, setCopied] = useState(false);

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
    <div className="flex flex-1 min-h-0 flex-col">
      {/* ── Version selector + copy button ─────────────────────────────── */}
      <div className="flex items-center gap-2 border-b border-gray-700 px-3 py-2">
        <select
          value={selectedFilename ?? ''}
          onChange={e => onSelectFilename(e.target.value)}
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
