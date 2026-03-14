import React from 'react';
import type { ChatMessage as ChatMessageType } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';

interface Props {
  message: ChatMessageType;
}

function formatTime(date: Date): string {
  return new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' }).format(date);
}

export function ChatMessage({ message }: Props) {
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';

  if (isTool) {
    return (
      <div className="mx-2 my-1">
        <div
          className={`rounded border px-3 py-2 text-xs font-mono ${
            message.toolStatus === 'error'
              ? 'border-red-700 bg-red-950 text-red-300'
              : message.toolStatus === 'running'
                ? 'border-yellow-700 bg-yellow-950 text-yellow-300'
                : 'border-green-800 bg-green-950 text-green-300'
          }`}
        >
          <div className="mb-1 flex items-center gap-2">
            <span className="text-muted-foreground">Tool:</span>
            <span className="font-semibold">{message.toolName}</span>
            {message.toolStatus === 'running' && (
              <span className="animate-pulse text-yellow-400">running...</span>
            )}
            {message.toolStatus === 'success' && (
              <span className="text-green-400">✓ done</span>
            )}
            {message.toolStatus === 'error' && (
              <span className="text-red-400">✗ failed</span>
            )}
          </div>
          {message.content && (
            <pre className="mt-1 whitespace-pre-wrap break-all text-xs opacity-80">
              {message.content}
            </pre>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mx-2 my-1`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
          isUser
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-foreground'
        }`}
      >
        {!isUser && (
          <div className="text-muted-foreground mb-1 text-xs font-semibold uppercase tracking-wide">
            AI Assistant
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
}

export default ChatMessage;
