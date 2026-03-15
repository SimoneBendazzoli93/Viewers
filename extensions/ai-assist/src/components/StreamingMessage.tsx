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
 * Smooth playback
 * ───────────────
 * Text received from the backend is queued in `pendingRef` and drained at a
 * fixed rate (CHARS_PER_FRAME characters per animation frame, ≈ 60 fps) so
 * the visual output is a smooth typewriter effect regardless of when network
 * chunks arrive.
 *
 * Once streaming completes the parent calls getText() (returns committed +
 * still-queued text), then reset(), and commits the full content to the
 * messages array so ChatMessage can take over with MarkdownRenderer.
 */
import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

export interface StreamingMessageHandle {
  /** Queue text for smooth typewriter playback — no React re-render. */
  appendText(text: string): void;
  /** Return all text: already displayed + still queued. */
  getText(): string;
  /**
   * Flush pending queue to DOM synchronously, then clear everything.
   * Must be called before getText() result is committed so no text is lost.
   */
  reset(): void;
}

/** Characters drained per animation frame. At 60 fps this is ~720 chars/sec —
 *  fast enough to feel live, slow enough to look smooth. */
const CHARS_PER_FRAME = 12;

function formatTime(date: Date): string {
  return new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' }).format(date);
}

export const StreamingMessage = forwardRef<
  StreamingMessageHandle,
  { timestamp: Date; onUpdate?: () => void }
>(function StreamingMessage({ timestamp, onUpdate }, ref) {
  const textDivRef  = useRef<HTMLDivElement>(null);
  /** Text that has already been written to the DOM. */
  const contentRef  = useRef<string>('');
  /** Text received but not yet painted — drained by the RAF loop. */
  const pendingRef  = useRef<string>('');
  /** requestAnimationFrame handle; null when the loop is idle. */
  const rafRef      = useRef<number | null>(null);
  /** Stable ref so the drain closure always sees the latest onUpdate prop. */
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  /** Start the RAF drain loop if it isn't already running. */
  const startDrain = () => {
    if (rafRef.current !== null) return;
    const drain = () => {
      if (!pendingRef.current) {
        rafRef.current = null;
        return;
      }
      const chunk = pendingRef.current.slice(0, CHARS_PER_FRAME);
      pendingRef.current = pendingRef.current.slice(CHARS_PER_FRAME);
      contentRef.current += chunk;
      if (textDivRef.current) {
        textDivRef.current.textContent = contentRef.current;
      }
      onUpdateRef.current?.();
      rafRef.current = requestAnimationFrame(drain);
    };
    rafRef.current = requestAnimationFrame(drain);
  };

  useImperativeHandle(ref, () => ({
    appendText(text: string) {
      pendingRef.current += text;
      startDrain();
    },

    getText() {
      // Return the total: what's on screen + what's still in the queue.
      return contentRef.current + pendingRef.current;
    },

    reset() {
      // Cancel the RAF before touching the refs so the drain closure
      // can't fire between the clear and the caller reading getText().
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      pendingRef.current = '';
      contentRef.current = '';
      if (textDivRef.current) {
        textDivRef.current.textContent = '';
      }
    },
  }));

  // Cancel the RAF on unmount to prevent stale DOM writes.
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  return (
    <div className="flex justify-start mx-2 my-1">
      <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm bg-muted text-foreground">
        <div className="text-muted-foreground mb-1 text-xs font-semibold uppercase tracking-wide">
          AI Assistant
        </div>
        {/* Content is written imperatively — starts empty, filled by the RAF drain loop. */}
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
});

export default StreamingMessage;
