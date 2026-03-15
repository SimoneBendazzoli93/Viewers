import React from 'react';
import type { ChatMessage as ChatMessageType } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';

interface Props {
  message: ChatMessageType;
}

function formatTime(date: Date): string {
  return new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' }).format(date);
}

// React.memo: only re-render when the message prop reference changes.
// Because messages are only mutated (new object created) when their content
// actually changes, unchanged messages are skipped entirely.
export const ChatMessage = React.memo(function ChatMessage({ message }: Props) {
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';

  if (isTool) {
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

          {/* Download button — shown when the tool produced a result file */}
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
