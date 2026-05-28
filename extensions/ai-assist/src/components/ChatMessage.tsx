import React, { useEffect, useRef } from 'react';
import type { ChatMessage as ChatMessageType } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';

interface Props {
  message: ChatMessageType;
}

function formatTime(date: Date): string {
  return new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' }).format(date);
}

function ExecutionLogMessage({ message }: { message: ChatMessageType }) {
  const logsEndRef = useRef<HTMLDivElement>(null);
  const lines = message.toolLogs ?? [];

  useEffect(() => {
    if (message.logActive && lines.length) {
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [lines.length, message.logActive]);

  if (lines.length === 0) {
    return null;
  }

  return (
    <div className="mx-2 my-1">
      <div
        className={`rounded-md border px-3 py-2 shadow-inner ${
          message.logActive
            ? 'border-cyan-700/60 bg-slate-950/95'
            : 'border-slate-700/50 bg-slate-950/80'
        }`}
      >
        <div className="mb-1.5 flex items-center gap-2">
          <span
            className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
              message.logActive ? 'animate-pulse bg-cyan-400' : 'bg-slate-500'
            }`}
          />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-cyan-500">
            Execution log
          </span>
          {message.toolName && (
            <span className="truncate text-[10px] text-slate-500">{message.toolName}</span>
          )}
        </div>
        <div className="max-h-52 space-y-0.5 overflow-y-auto font-mono text-[11px] leading-relaxed">
          {lines.map((line, index) => (
            <div key={index} className="flex gap-2 text-sky-300/90">
              <span className="shrink-0 select-none text-cyan-600/80">›</span>
              <span className="break-all">{line}</span>
            </div>
          ))}
          <div ref={logsEndRef} />
        </div>
      </div>
    </div>
  );
}

function ToolMessageCard({ message }: { message: ChatMessageType }) {
  return (
    <div className="mx-2 my-1">
      <div
        className={`rounded border px-3 py-2 font-mono text-xs ${
          message.toolStatus === 'error'
            ? 'bg-red-950 border-red-700 text-red-300'
            : message.toolStatus === 'running'
              ? 'bg-yellow-950 border-yellow-700 text-yellow-300'
              : 'bg-green-950 border-green-800 text-green-300'
        }`}
      >
        <div className="mb-1 flex items-center gap-2">
          <span className="text-muted-foreground">Tool:</span>
          <span className="font-semibold">{message.toolName}</span>
          {message.toolStatus === 'running' && (
            <span className="animate-pulse text-yellow-400">
              running
              {message.toolProgress ? ` · ${message.toolProgress}` : '...'}
            </span>
          )}
          {message.toolStatus === 'success' && <span className="text-green-400">✓ done</span>}
          {message.toolStatus === 'error' && <span className="text-red-400">✗ failed</span>}
        </div>
        {message.content && (
          <pre className="mt-1 whitespace-pre-wrap break-all text-xs opacity-80">
            {message.content}
          </pre>
        )}

        {message.toolStatus === 'success' && message.viewerReloadUrl && (
          <a
            href={message.viewerReloadUrl}
            className="mt-2 inline-flex items-center gap-1.5 rounded border border-blue-600 bg-blue-900/40 px-2 py-1 text-xs font-medium text-blue-200 hover:bg-blue-900/70 hover:text-blue-50"
          >
            ↻ Open in Segmentation Mode
          </a>
        )}

        {message.toolStatus === 'success' && message.downloadUrl && (
          <a
            href={message.downloadUrl}
            download={message.downloadFilename ?? 'results.csv'}
            className="mt-2 inline-flex items-center gap-1.5 rounded border border-green-600 bg-green-900/40 px-2 py-1 text-xs font-medium text-green-300 hover:bg-green-900/70 hover:text-green-100"
          >
            ↓ Download {message.downloadFilename ?? 'results.csv'}
          </a>
        )}
      </div>
    </div>
  );
}

export const ChatMessage = React.memo(function ChatMessage({ message }: Props) {
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';
  const isLog = message.role === 'log';

  if (isLog) {
    return <ExecutionLogMessage message={message} />;
  }

  if (isTool) {
    return <ToolMessageCard message={message} />;
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mx-2 my-1`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
          isUser ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'
        }`}
      >
        {!isUser && (
          <div className="text-muted-foreground mb-1 text-xs font-semibold uppercase tracking-wide">
            MAIA Radiology Assistant
          </div>
        )}
        {isUser ? (
          <div className="whitespace-pre-wrap text-sm">{message.content}</div>
        ) : (
          <MarkdownRenderer content={message.content} />
        )}
        <div
          className={`mt-1 text-right text-xs opacity-60 ${
            isUser ? 'text-primary-foreground' : 'text-muted-foreground'
          }`}
        >
          {formatTime(message.timestamp)}
        </div>
      </div>
    </div>
  );
});

export default ChatMessage;
