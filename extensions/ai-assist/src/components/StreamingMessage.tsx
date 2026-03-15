/**
 * StreamingMessage
 *
 * A special chat bubble used exclusively while the AI agent is streaming its
 * text response. Unlike ChatMessage, this component NEVER updates React state
 * for its content — it writes directly to a DOM text node via an imperative
 * handle. This means:
 *
 *   • Zero React re-renders while tokens arrive
 *   • Zero reconciliation / virtual-DOM diffing
 *   • No scrollIntoView() or layout effects firing per token
 *
 * Once streaming completes the parent commits the accumulated text to the
 * messages array, this component unmounts, and ChatMessage takes over with
 * full MarkdownRenderer formatting.
 */
import React, { forwardRef, useImperativeHandle, useRef } from 'react';

export interface StreamingMessageHandle {
  /** Append text directly to the DOM — no React re-render. */
  appendText(text: string): void;
  /** Return all accumulated text so far. */
  getText(): string;
  /** Clear content (call before setting authoritative final text). */
  reset(): void;
}

function formatTime(date: Date): string {
  return new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' }).format(date);
}

export const StreamingMessage = forwardRef<StreamingMessageHandle, { timestamp: Date }>(
  function StreamingMessage({ timestamp }, ref) {
    const textDivRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<string>('');

    useImperativeHandle(ref, () => ({
      appendText(text: string) {
        contentRef.current += text;
        if (textDivRef.current) {
          // Direct DOM write — React is completely bypassed.
          textDivRef.current.textContent = contentRef.current;
        }
      },
      getText() {
        return contentRef.current;
      },
      reset() {
        contentRef.current = '';
        if (textDivRef.current) {
          textDivRef.current.textContent = '';
        }
      },
    }));

    return (
      <div className="flex justify-start mx-2 my-1">
        <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm bg-muted text-foreground">
          <div className="text-muted-foreground mb-1 text-xs font-semibold uppercase tracking-wide">
            AI Assistant
          </div>
          {/* Content is written imperatively — starts empty, filled by appendText(). */}
          <div
            ref={textDivRef}
            className="whitespace-pre-wrap text-sm leading-relaxed"
          />
          <div className="mt-1 text-right text-xs opacity-60 text-muted-foreground">
            {formatTime(timestamp)}
          </div>
        </div>
      </div>
    );
  }
);

export default StreamingMessage;
