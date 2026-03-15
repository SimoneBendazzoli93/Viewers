/**
 * Lightweight markdown renderer for AI chat messages.
 *
 * Supported syntax:
 *   Block:  # H1  ## H2  ### H3  ---  - list  1. list  ```lang … ```  | table |
 *   Inline: **bold**  *italic*  `inline code`
 *
 * No external dependencies — intentionally minimal to avoid adding packages.
 * Handles partial/streaming content gracefully (no crashes on unclosed fences).
 */
import React, { useState } from 'react';

// ── Inline renderer ──────────────────────────────────────────────────────────

function renderInline(text: string, keyPrefix: string): React.ReactNode {
  // Split on **bold**, *italic*, `code`, [link](url) — all must be non-empty
  const parts = text.split(
    /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\))/g
  );
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={`${keyPrefix}-b${i}`}>{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith('*') && part.endsWith('*')) {
          return <em key={`${keyPrefix}-i${i}`}>{part.slice(1, -1)}</em>;
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return (
            <code
              key={`${keyPrefix}-c${i}`}
              className="rounded bg-gray-700 px-1 font-mono text-xs text-yellow-200"
            >
              {part.slice(1, -1)}
            </code>
          );
        }
        // [label](href) — open in new tab so the viewer stays open
        const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (linkMatch) {
          return (
            <a
              key={`${keyPrefix}-a${i}`}
              href={linkMatch[2]}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 underline hover:text-blue-300"
            >
              {linkMatch[1]}
            </a>
          );
        }
        return part || null;
      })}
    </>
  );
}

// ── Table renderer ───────────────────────────────────────────────────────────

/** Split a `| a | b | c |` line into trimmed cell strings. */
function parseTableRow(line: string): string[] {
  return line
    .split('|')
    .slice(1, -1)          // drop the empty strings before first | and after last |
    .map(c => c.trim());
}

/** True for separator rows like `|---|:---:|------|`. */
function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c));
}

function TableBlock({ rows, blockKey }: { rows: string[][]; blockKey: string }) {
  const [copied, setCopied] = useState(false);

  const colCount = rows[0]?.length ?? 0;

  // Normalize every row to the same column count
  const normalised = rows.map(r => {
    if (r.length >= colCount) return r.slice(0, colCount);
    return [...r, ...Array(colCount - r.length).fill('')];
  });

  const headers = normalised[0];
  const dataRows = normalised.slice(1);

  const handleCopyCSV = () => {
    const escape = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const csv = normalised
      .map(row => row.map(escape).join(','))
      .join('\n');
    navigator.clipboard.writeText(csv).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="my-2">
      <div className="mb-1 flex justify-end">
        <button
          onClick={handleCopyCSV}
          className="rounded border border-gray-600 bg-gray-800 px-2 py-0.5 text-xs text-gray-400 hover:bg-gray-700 hover:text-white active:bg-gray-600"
          title="Copy table as CSV"
        >
          {copied ? '✓ Copied' : 'Copy CSV'}
        </button>
      </div>

      <div className="overflow-x-auto rounded border border-gray-600">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-gray-700">
              {headers.map((h, ci) => (
                <th
                  key={`${blockKey}-h${ci}`}
                  className="border border-gray-600 px-2 py-1.5 text-left font-semibold text-gray-100"
                >
                  {renderInline(h, `${blockKey}-h${ci}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dataRows.map((row, ri) => (
              <tr
                key={`${blockKey}-r${ri}`}
                className={ri % 2 === 0 ? 'bg-gray-800' : 'bg-gray-850'}
              >
                {row.map((cell, ci) => (
                  <td
                    key={`${blockKey}-r${ri}c${ci}`}
                    className="border border-gray-700 px-2 py-1 text-gray-300"
                  >
                    {renderInline(cell, `${blockKey}-r${ri}c${ci}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Block renderer ───────────────────────────────────────────────────────────

function CodeBlock({ lang, code, blockKey }: { lang: string; code: string; blockKey: string }) {
  return (
    <div
      key={blockKey}
      className="my-2 overflow-hidden rounded border border-gray-600 bg-gray-900 text-xs"
    >
      {lang && (
        <div className="flex items-center justify-between border-b border-gray-700 bg-gray-800 px-3 py-1">
          <span className="font-mono text-gray-400">{lang}</span>
        </div>
      )}
      <pre className="overflow-x-auto p-3 font-mono leading-relaxed text-gray-100 whitespace-pre">
        {code}
      </pre>
    </div>
  );
}

function parseLines(text: string, baseKey: string): React.ReactNode[] {
  const lines = text.split('\n');
  const nodes: React.ReactNode[] = [];
  let i = 0;
  let seq = 0;
  const k = () => `${baseKey}-L${seq++}`;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip blank lines
    if (trimmed === '') {
      i++;
      continue;
    }

    // Horizontal rule
    if (/^-{3,}$/.test(trimmed)) {
      nodes.push(<hr key={k()} className="my-2 border-gray-600" />);
      i++;
      continue;
    }

    // Headings
    const headingMatch = trimmed.match(/^(#{1,3})\s+(.*)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2];
      const cls =
        level === 1
          ? 'mt-2 mb-1 text-sm font-bold text-white'
          : level === 2
            ? 'mt-1.5 mb-0.5 text-sm font-semibold text-gray-100'
            : 'mt-1 mb-0.5 text-xs font-semibold text-gray-200 uppercase tracking-wide';
      const key = k();
      nodes.push(
        level === 1 ? (
          <h1 key={key} className={cls}>{renderInline(headingText, key)}</h1>
        ) : level === 2 ? (
          <h2 key={key} className={cls}>{renderInline(headingText, key)}</h2>
        ) : (
          <h3 key={key} className={cls}>{renderInline(headingText, key)}</h3>
        )
      );
      i++;
      continue;
    }

    // Markdown table — collect all consecutive pipe-starting lines
    if (trimmed.startsWith('|')) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }
      // Parse rows, discarding separator lines (|---|---|)
      const rows = tableLines
        .map(parseTableRow)
        .filter(cells => cells.length > 0 && !isSeparatorRow(cells));
      if (rows.length >= 1) {
        const tableKey = k();
        nodes.push(<TableBlock key={tableKey} rows={rows} blockKey={tableKey} />);
      }
      continue;
    }

    // Unordered list — consume consecutive list lines
    if (/^[-*]\s/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ''));
        i++;
      }
      const listKey = k();
      nodes.push(
        <ul key={listKey} className="my-1 list-disc space-y-0.5 pl-4 text-sm">
          {items.map((item, j) => (
            <li key={`${listKey}-${j}`}>{renderInline(item, `${listKey}-${j}`)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // Ordered list — consume consecutive numbered lines
    if (/^\d+[.)]\s/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+[.)]\s+/, ''));
        i++;
      }
      const listKey = k();
      nodes.push(
        <ol key={listKey} className="my-1 list-decimal space-y-0.5 pl-4 text-sm">
          {items.map((item, j) => (
            <li key={`${listKey}-${j}`}>{renderInline(item, `${listKey}-${j}`)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // Paragraph — collect consecutive non-special lines.
    //
    // IMPORTANT: the stop-condition must mirror the outer if-checks exactly,
    // otherwise a line can fall through every if-block AND exit this while
    // immediately (paraLines stays empty, i never advances → infinite loop).
    //
    // Mismatches in the original code that caused the freeze:
    //   #{1,3}   matched e.g. "#1 Findings:" which the heading check rejects
    //            (it requires whitespace: /^(#{1,3})\s+/)
    //   -{3,}    matched e.g. "--- Impression" which the HR check rejects
    //            (it requires only dashes: /^-{3,}$/)
    //
    // Fix: use #{1,3}\s and -{3,}$ here so the condition matches the outer
    // checks precisely.
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,3}\s|-{3,}$|[-*]\s|\d+[.)]\s|\|)/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i]);
      i++;
    }

    if (paraLines.length > 0) {
      const pk = k();
      nodes.push(
        <p key={pk} className="mb-1 text-sm leading-relaxed">
          {paraLines.flatMap((l, j) =>
            j === 0
              ? [renderInline(l, `${pk}-${j}`)]
              : [<br key={`${pk}-br${j}`} />, renderInline(l, `${pk}-${j}`)]
          )}
        </p>
      );
    } else {
      // Safety net: if we still haven't consumed the current line (e.g. a
      // future pattern gap), advance unconditionally to prevent an infinite loop.
      i++;
    }
  }

  return nodes;
}

// ── Top-level parser ──────────────────────────────────────────────────────────

/**
 * Split content into complete code-fence blocks and plain-text segments.
 * Also handles an *unclosed* code fence at the very end (streaming case).
 */
function splitCodeFences(content: string): Array<
  { type: 'text'; text: string } | { type: 'code'; lang: string; code: string }
> {
  const result: Array<{ type: 'text'; text: string } | { type: 'code'; lang: string; code: string }> = [];
  const fenceRe = /```([^\n]*)\n([\s\S]*?)```/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRe.exec(content)) !== null) {
    if (match.index > last) {
      result.push({ type: 'text', text: content.slice(last, match.index) });
    }
    result.push({ type: 'code', lang: match[1].trim(), code: match[2] });
    last = fenceRe.lastIndex;
  }

  const remaining = content.slice(last);
  // Check for an unclosed fence (streaming)
  const openFence = remaining.match(/^([\s\S]*?)```([^\n]*)\n?([\s\S]*)$/);
  if (openFence) {
    if (openFence[1]) result.push({ type: 'text', text: openFence[1] });
    result.push({ type: 'code', lang: openFence[2].trim(), code: openFence[3] });
  } else if (remaining) {
    result.push({ type: 'text', text: remaining });
  }

  return result;
}

// ── Public component ──────────────────────────────────────────────────────────

// React.memo: content only changes for the actively-streaming message.
// All other assistant messages share the same content reference between renders
// and skip re-parsing the markdown entirely.
export const MarkdownRenderer = React.memo(function MarkdownRenderer({ content }: { content: string }) {
  const segments = splitCodeFences(content);

  return (
    <div className="markdown-content">
      {segments.map((seg, i) =>
        seg.type === 'code' ? (
          <CodeBlock key={i} lang={seg.lang} code={seg.code} blockKey={String(i)} />
        ) : (
          <React.Fragment key={i}>{parseLines(seg.text, String(i))}</React.Fragment>
        )
      )}
    </div>
  );
});

export default MarkdownRenderer;
