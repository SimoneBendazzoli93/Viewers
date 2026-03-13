import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useSystem } from '@ohif/core';
import type { ChatMessage, AgentConfig, StreamMessage } from '../types';
import { AIAgentService } from '../services/AIAgentService';
import { ChatMessage as ChatMessageComponent } from '../components/ChatMessage';
import { AgentConfigPanel } from '../components/AgentConfigPanel';
import { QuickActionBar } from '../components/QuickActionBar';

// Singleton service instance
const agentService = new AIAgentService();

let messageIdCounter = 0;
function nextId(): string {
  return `msg-${Date.now()}-${++messageIdCounter}`;
}

function buildStudyContext(servicesManager: AppTypes.ServicesManager) {
  try {
    const { viewportGridService, displaySetService } = servicesManager.services;
    const { activeViewportId, viewports } = viewportGridService.getState();
    const viewport = viewports.get(activeViewportId);
    if (!viewport?.displaySetInstanceUIDs?.length) return null;

    const uid = viewport.displaySetInstanceUIDs[0];
    const displaySet = displaySetService.getDisplaySetByUID(uid);
    if (!displaySet) return null;

    return {
      studyInstanceUID: displaySet.StudyInstanceUID,
      seriesInstanceUID: displaySet.SeriesInstanceUID,
      sopInstanceUID: displaySet.SOPInstanceUID,
      patientName: displaySet.PatientName,
      studyDate: displaySet.StudyDate,
      modality: displaySet.Modality,
    };
  } catch {
    return null;
  }
}

interface Props {
  servicesManager?: AppTypes.ServicesManager;
  commandsManager?: AppTypes.CommandsManager;
}

export function PanelAIAssistant({ servicesManager, commandsManager }: Props) {
  const system = useSystem();
  const services = servicesManager ?? system?.servicesManager;

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content:
        'Hello! I am your AI radiology assistant. I can help you with:\n• Generating structured radiology reports\n• Running automatic organ segmentation\n• Extracting radiomics features\n• Answering questions about the current study\n\nUse the quick actions below or type a message to get started.',
      timestamp: new Date(),
    },
  ]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [config, setConfig] = useState<AgentConfig>(agentService.getConfig());
  const [backendStatus, setBackendStatus] = useState<'unknown' | 'ok' | 'error'>('unknown');

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const streamingMessageIdRef = useRef<string | null>(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Check backend health on mount and after config change
  useEffect(() => {
    agentService.checkBackendHealth().then(({ ok }) => {
      setBackendStatus(ok ? 'ok' : 'error');
    });
  }, [config.backendUrl]);

  const handleSend = useCallback(
    async (textOverride?: string) => {
      const text = (textOverride ?? input).trim();
      if (!text || isStreaming) return;

      setInput('');

      const userMsg: ChatMessage = {
        id: nextId(),
        role: 'user',
        content: text,
        timestamp: new Date(),
      };

      setMessages(prev => [...prev, userMsg]);
      setIsStreaming(true);

      const studyContext = services ? buildStudyContext(services) : null;

      // Create a placeholder for the assistant response
      const assistantMsgId = nextId();
      streamingMessageIdRef.current = assistantMsgId;
      setMessages(prev => [
        ...prev,
        {
          id: assistantMsgId,
          role: 'assistant',
          content: '',
          timestamp: new Date(),
        },
      ]);

      const historyForBackend = messages.filter(m => m.role !== 'tool');

      await agentService.sendMessage(
        text,
        historyForBackend,
        studyContext,
        (event: StreamMessage) => handleStreamEvent(event, assistantMsgId),
        (error: string) => {
          setMessages(prev =>
            prev.map(m =>
              m.id === assistantMsgId
                ? { ...m, content: `Error: ${error}` }
                : m
            )
          );
          setIsStreaming(false);
        },
        () => {
          setIsStreaming(false);
          streamingMessageIdRef.current = null;
        }
      );
    },
    [input, isStreaming, messages, services]
  );

  const handleStreamEvent = useCallback(
    (event: StreamMessage, assistantMsgId: string) => {
      switch (event.type) {
        case 'thought':
          // Append thought to assistant message (shown as italic prefix)
          setMessages(prev =>
            prev.map(m =>
              m.id === assistantMsgId
                ? { ...m, content: m.content ? m.content : `_Thinking..._\n` }
                : m
            )
          );
          break;

        case 'final':
          // Replace assistant message with final answer
          setMessages(prev =>
            prev.map(m =>
              m.id === assistantMsgId ? { ...m, content: event.content } : m
            )
          );
          break;

        case 'tool_start':
          // Add a tool-status message
          setMessages(prev => [
            ...prev,
            {
              id: nextId(),
              role: 'tool',
              content: event.toolInput ? JSON.stringify(event.toolInput, null, 2) : '',
              toolName: event.toolName,
              toolStatus: 'running',
              timestamp: new Date(),
            },
          ]);
          break;

        case 'tool_end':
          // Update the last running tool message to success/error
          setMessages(prev => {
            const updated = [...prev];
            for (let i = updated.length - 1; i >= 0; i--) {
              if (updated[i].role === 'tool' && updated[i].toolStatus === 'running') {
                updated[i] = {
                  ...updated[i],
                  toolStatus: event.type === 'tool_end' ? 'success' : 'error',
                  toolResult: event.toolOutput,
                };
                break;
              }
            }
            return updated;
          });
          break;

        case 'action':
          // Append action info to streaming message
          setMessages(prev =>
            prev.map(m =>
              m.id === assistantMsgId
                ? { ...m, content: m.content + (m.content ? '' : '') }
                : m
            )
          );
          break;

        case 'observation':
        default:
          // Append incremental text
          if (event.content) {
            setMessages(prev =>
              prev.map(m =>
                m.id === assistantMsgId
                  ? { ...m, content: m.content + event.content }
                  : m
              )
            );
          }
          break;
      }
    },
    []
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSaveConfig = (newConfig: AgentConfig) => {
    agentService.updateConfig(newConfig);
    setConfig(newConfig);
    setShowConfig(false);
  };

  const handleClearChat = () => {
    setMessages([
      {
        id: nextId(),
        role: 'assistant',
        content: 'Chat cleared. How can I assist you?',
        timestamp: new Date(),
      },
    ]);
  };

  const handleCancel = () => {
    agentService.cancelCurrentRequest();
    setIsStreaming(false);
  };

  if (showConfig) {
    return (
      <div className="flex h-full flex-col bg-gray-900 text-white">
        <AgentConfigPanel
          config={config}
          onSave={handleSaveConfig}
          onClose={() => setShowConfig(false)}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-gray-900 text-white">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-700 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">AI Assistant</span>
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              backendStatus === 'ok'
                ? 'bg-green-500'
                : backendStatus === 'error'
                  ? 'bg-red-500'
                  : 'bg-yellow-500'
            }`}
            title={
              backendStatus === 'ok'
                ? 'Backend connected'
                : backendStatus === 'error'
                  ? 'Backend unreachable'
                  : 'Checking backend...'
            }
          />
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleClearChat}
            title="Clear chat"
            className="rounded p-1 text-xs text-gray-400 hover:bg-gray-700 hover:text-white"
          >
            🗑
          </button>
          <button
            onClick={() => setShowConfig(true)}
            title="Configure agent"
            className="rounded p-1 text-xs text-gray-400 hover:bg-gray-700 hover:text-white"
          >
            ⚙
          </button>
        </div>
      </div>

      {/* LLM + model info bar */}
      <div className="flex items-center gap-2 border-b border-gray-800 bg-gray-850 px-3 py-1">
        <span className="text-xs text-gray-500">
          {config.llmProvider} / {config.llmModel}
        </span>
        <span className="text-gray-700">|</span>
        <span className="text-xs text-gray-500">
          Seg: {config.segmentationModels.find(m => m.id === config.activeSegmentationModel)?.name ?? config.activeSegmentationModel}
        </span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto py-2">
        {messages.map(msg => (
          <ChatMessageComponent key={msg.id} message={msg} />
        ))}
        {isStreaming && (
          <div className="mx-2 mt-1 flex items-center gap-2 text-xs text-gray-500">
            <span className="animate-spin">⟳</span>
            <span>Agent is thinking...</span>
            <button
              onClick={handleCancel}
              className="ml-auto text-xs text-red-400 hover:text-red-300"
            >
              Cancel
            </button>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Quick actions */}
      <QuickActionBar onAction={handleSend} disabled={isStreaming} />

      {/* Input area */}
      <div className="border-t border-gray-700 px-2 py-2">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            className="min-h-[40px] flex-1 resize-none rounded border border-gray-600 bg-gray-800 px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
            placeholder="Ask about the study, request segmentation, report…"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            disabled={isStreaming}
          />
          <button
            onClick={() => handleSend()}
            disabled={isStreaming || !input.trim()}
            className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40"
            title="Send (Enter)"
          >
            ↑
          </button>
        </div>
        <p className="mt-1 text-right text-xs text-gray-600">Enter to send · Shift+Enter for newline</p>
      </div>
    </div>
  );
}

export default PanelAIAssistant;
