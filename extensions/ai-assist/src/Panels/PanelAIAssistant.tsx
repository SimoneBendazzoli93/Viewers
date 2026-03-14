import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, startTransition } from 'react';
import { useSystem } from '@ohif/core';
import type { ChatHistoryStorage, ChatMessage, AgentConfig, StreamMessage, DicomWebContext } from '../types';
import { AIAgentService } from '../services/AIAgentService';
import { ChatMessage as ChatMessageComponent } from '../components/ChatMessage';
import { AgentConfigPanel } from '../components/AgentConfigPanel';
import { QuickActionBar } from '../components/QuickActionBar';

// Singleton service instance
const agentService = new AIAgentService();

// Number of messages to display per page. Earlier messages are loaded on
// scroll-up so large histories don't stall the browser all at once.
const PAGE_SIZE = 50;

let messageIdCounter = 0;
function nextId(): string {
  return `msg-${Date.now()}-${++messageIdCounter}`;
}

const WELCOME_MESSAGE: ChatMessage = {
  id: 'welcome',
  role: 'assistant',
  content:
    'Hello! I am your AI radiology assistant. I can help you with:\n• Generating structured radiology reports\n• Running automatic organ segmentation\n• Extracting radiomics features\n• Answering questions about the current study\n\nUse the quick actions below or type a message to get started.',
  timestamp: new Date(),
};

function storageKey(studyUID: string | null): string | null {
  return studyUID ? `ohif-ai-chat-${studyUID}` : null;
}

function getStorage(type: ChatHistoryStorage): Storage | null {
  if (type === 'localStorage') return window.localStorage;
  if (type === 'sessionStorage') return window.sessionStorage;
  return null;
}

function loadHistory(studyUID: string | null, storageType: ChatHistoryStorage): ChatMessage[] {
  const key = storageKey(studyUID);
  const storage = key ? getStorage(storageType) : null;
  if (!storage || !key) return [{ ...WELCOME_MESSAGE, timestamp: new Date() }];
  try {
    const raw = storage.getItem(key);
    if (!raw) return [{ ...WELCOME_MESSAGE, timestamp: new Date() }];
    const parsed = JSON.parse(raw) as ChatMessage[];
    return parsed.map(m => ({ ...m, timestamp: new Date(m.timestamp) }));
  } catch {
    return [{ ...WELCOME_MESSAGE, timestamp: new Date() }];
  }
}

function saveHistory(studyUID: string | null, msgs: ChatMessage[], storageType: ChatHistoryStorage): void {
  const key = storageKey(studyUID);
  const storage = key ? getStorage(storageType) : null;
  if (!storage || !key) return;
  try {
    storage.setItem(key, JSON.stringify(msgs));
  } catch {
    // quota exceeded or private browsing — silently skip
  }
}

function clearHistory(studyUID: string | null, storageType: ChatHistoryStorage): void {
  const key = storageKey(studyUID);
  const storage = key ? getStorage(storageType) : null;
  storage?.removeItem(key!);
}

function getActiveStudyUID(servicesManager: AppTypes.ServicesManager | undefined): string | null {
  try {
    if (!servicesManager) return null;
    const { viewportGridService, displaySetService } = servicesManager.services;
    const { activeViewportId, viewports } = viewportGridService.getState();
    const viewport = viewports.get(activeViewportId);
    if (!viewport?.displaySetInstanceUIDs?.length) return null;
    const uid = viewport.displaySetInstanceUIDs[0];
    const displaySet = displaySetService.getDisplaySetByUID(uid);
    return displaySet?.StudyInstanceUID ?? null;
  } catch {
    return null;
  }
}

/**
 * Extract DICOMweb configuration from the active OHIF data source.
 * Returns null if the extension manager or data source is unavailable.
 */
function getDicomWebContext(extensionManager: AppTypes.ExtensionManager | undefined): DicomWebContext | null {
  try {
    if (!extensionManager) return null;
    const [dataSource] = extensionManager.getActiveDataSource?.() ?? [];
    if (!dataSource) return null;
    const cfg = dataSource.getConfig?.() ?? {};

    const ctx: DicomWebContext = {};
    if (cfg.wadoRoot) ctx.wadoRoot = cfg.wadoRoot;
    if (cfg.qidoRoot) ctx.qidoRoot = cfg.qidoRoot;
    if (cfg.wadoUriRoot) ctx.wadoUriRoot = cfg.wadoUriRoot;
    if (cfg.staticWado != null) ctx.staticWado = Boolean(cfg.staticWado);
    // singlepart can be a boolean or a comma-separated string in OHIF config
    if (cfg.singlepart != null) {
      ctx.singlepart = typeof cfg.singlepart === 'string' ? cfg.singlepart : String(cfg.singlepart);
    }
    // Return null if we couldn't extract any useful URL
    if (!ctx.wadoRoot && !ctx.qidoRoot) return null;
    return ctx;
  } catch {
    return null;
  }
}

function buildStudyContext(
  servicesManager: AppTypes.ServicesManager,
  extensionManager?: AppTypes.ExtensionManager
) {
  try {
    const { viewportGridService, displaySetService } = servicesManager.services;
    const { activeViewportId, viewports } = viewportGridService.getState();
    const viewport = viewports.get(activeViewportId);
    if (!viewport?.displaySetInstanceUIDs?.length) return null;

    const uid = viewport.displaySetInstanceUIDs[0];
    const displaySet = displaySetService.getDisplaySetByUID(uid);
    if (!displaySet) return null;

    const studyUID = displaySet.StudyInstanceUID;

    // Find all DICOM SEG series belonging to the same study
    const allDisplaySets: AppTypes.DisplaySet[] = displaySetService.activeDisplaySets ?? [];
    const availableSegmentations = allDisplaySets
      .filter(
        ds =>
          ds.StudyInstanceUID === studyUID &&
          ds.Modality === 'SEG' &&
          ds.SeriesInstanceUID !== displaySet.SeriesInstanceUID
      )
      .map(ds => ({
        seriesInstanceUID: ds.SeriesInstanceUID,
        seriesDescription: ds.SeriesDescription ?? '',
        referencedSeriesInstanceUID: ds.referencedSeriesInstanceUID ?? ds.ReferencedSeriesInstanceUID ?? '',
      }));

    // DICOMweb configuration from the active data source
    const dicomWebCtx = getDicomWebContext(extensionManager);

    return {
      studyInstanceUID: studyUID,
      seriesInstanceUID: displaySet.SeriesInstanceUID,
      sopInstanceUID: displaySet.SOPInstanceUID,
      patientName: displaySet.PatientName,
      studyDate: displaySet.StudyDate,
      modality: displaySet.Modality,
      // Spread DICOMweb fields at the top level — mirrors backend StudyContext model
      ...dicomWebCtx,
      availableSegmentations: availableSegmentations.length > 0 ? availableSegmentations : undefined,
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
  const extensionManager = system?.extensionManager;

  const [activeStudyUID, setActiveStudyUID] = useState<string | null>(() =>
    getActiveStudyUID(services)
  );
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const cfg = agentService.getConfig();
    // Server storage loads asynchronously via useEffect; start with welcome message
    if (cfg.chatHistoryStorage === 'server') {
      return [{ ...WELCOME_MESSAGE, timestamp: new Date() }];
    }
    return loadHistory(getActiveStudyUID(services), cfg.chatHistoryStorage);
  });
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [config, setConfig] = useState<AgentConfig>(agentService.getConfig());
  const [backendStatus, setBackendStatus] = useState<'unknown' | 'ok' | 'error'>('unknown');

  // How many messages (counting from the newest) are currently rendered.
  // Scrolling up past the top of the list loads the previous PAGE_SIZE chunk.
  const [displayCount, setDisplayCount] = useState(PAGE_SIZE);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  // The scrollable messages container — needed to read/set scrollTop.
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const streamingMessageIdRef = useRef<string | null>(null);
  const activeStudyUIDRef = useRef<string | null>(activeStudyUID);
  activeStudyUIDRef.current = activeStudyUID;
  const serverSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const browserSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Token-streaming buffer — incoming tokens are accumulated here and flushed
  // to React state at most every STREAM_FLUSH_MS milliseconds via startTransition.
  // This caps re-renders at ~20/sec regardless of LLM token rate.
  const STREAM_FLUSH_MS = 50;
  const streamBufferRef = useRef<string>('');
  const streamMsgIdRef = useRef<string>('');    // which assistant msg the buffer belongs to
  const streamFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Always-current messages reference — used inside debounced server-save callbacks
  // so the timer closure never captures a stale snapshot of messages.
  const latestMessagesRef = useRef<ChatMessage[]>(messages);
  latestMessagesRef.current = messages;

  // Set to true by the "load more" handler before increasing displayCount so
  // the layout effect knows to restore the scroll position instead of
  // jumping to the bottom.
  const isLoadingMoreRef = useRef(false);
  // Scroll height snapshotted just before a "load more" render so we can
  // compute how much the content grew and adjust scrollTop accordingly.
  const prevScrollHeightRef = useRef(0);

  // Slice of the full messages array that is currently rendered.
  const visibleStart = Math.max(0, messages.length - displayCount);
  const visibleMessages = messages.slice(visibleStart);
  const hasMore = visibleStart > 0;

  // True once the initial history load for the current study has completed.
  // Prevents the server-save debounce from writing a "welcome-only" snapshot
  // to the server before we have received the real history from it.
  const historyReadyRef = useRef<boolean>(
    // For browser storage the useState initializer already loaded synchronously,
    // so we can consider it ready unless the study UID was unavailable at that time.
    config.chatHistoryStorage !== 'server' && activeStudyUID !== null
  );

  // ── Persist messages whenever they change ─────────────────────────────────
  // Both browser and server storage are debounced so rapid streaming updates
  // (one setMessages call per token) don't trigger a synchronous
  // JSON.stringify + storage write on every render.
  // The timer always reads latestMessagesRef so it uses the latest state even
  // though the closure was created earlier.
  useEffect(() => {
    if (config.chatHistoryStorage === 'server') {
      if (!activeStudyUID) return;
      if (serverSaveTimerRef.current) clearTimeout(serverSaveTimerRef.current);
      serverSaveTimerRef.current = setTimeout(() => {
        if (!historyReadyRef.current) return;
        agentService.saveServerHistory(activeStudyUID, latestMessagesRef.current);
      }, 1500);
    } else {
      if (browserSaveTimerRef.current) clearTimeout(browserSaveTimerRef.current);
      browserSaveTimerRef.current = setTimeout(() => {
        saveHistory(activeStudyUID, latestMessagesRef.current, config.chatHistoryStorage);
      }, 500);
    }
  }, [messages, activeStudyUID, config.chatHistoryStorage]);

  // ── Load history when study or storage type changes ───────────────────────
  // Handles both the initial mount (if the study UID was null when useState ran)
  // and subsequent study switches triggered by the viewport subscription below.
  useEffect(() => {
    if (!activeStudyUID || config.chatHistoryStorage === 'none') {
      historyReadyRef.current = true;
      return;
    }

    if (config.chatHistoryStorage === 'server') {
      historyReadyRef.current = false;
      agentService.loadServerHistory(activeStudyUID).then(loaded => {
        if (loaded.length > 0) setMessages(loaded);
        historyReadyRef.current = true;
      });
    } else {
      // localStorage / sessionStorage: synchronous load.
      // Only update messages if the current state is still the welcome placeholder —
      // i.e. the useState initializer did not load history because the study UID
      // was unavailable at render time.
      setMessages(prev => {
        if (prev.length === 1 && prev[0].id === WELCOME_MESSAGE.id) {
          const loaded = loadHistory(activeStudyUID, config.chatHistoryStorage);
          return loaded;
        }
        return prev; // already populated by useState initializer — no-op
      });
      historyReadyRef.current = true;
    }
  }, [activeStudyUID, config.chatHistoryStorage]);

  // ── Watch for active study changes ────────────────────────────────────────
  // Subscribes to viewport-grid events AND display-set events so we catch:
  //   (a) the user switching to a different study inside the viewer, and
  //   (b) the initial study load that may have completed before this component
  //       mounted (ACTIVE_VIEWPORT_ID_CHANGED would have already fired).
  // The handler is also invoked immediately after subscribing to cover (b).
  useEffect(() => {
    if (!services) return;
    const { viewportGridService, displaySetService } = services.services;

    const handleStudyChange = () => {
      const newStudyUID = getActiveStudyUID(services);
      if (newStudyUID === activeStudyUIDRef.current) return; // no change

      setActiveStudyUID(newStudyUID);
      activeStudyUIDRef.current = newStudyUID;

      if (!newStudyUID || config.chatHistoryStorage === 'none') {
        historyReadyRef.current = true;
        return;
      }

      // For browser storage, load synchronously right here so the messages
      // state is set in the same React batch as setActiveStudyUID.
      if (config.chatHistoryStorage !== 'server') {
        setMessages(loadHistory(newStudyUID, config.chatHistoryStorage));
        historyReadyRef.current = true;
      } else {
        // Server: reset to welcome; the load effect will fire when activeStudyUID
        // state updates and trigger the async fetch.
        setMessages([{ ...WELCOME_MESSAGE, timestamp: new Date() }]);
        historyReadyRef.current = false;
      }
    };

    // ★ Immediate check — covers the case where the study was already loaded
    //   before this component mounted and the viewport event won't fire again.
    handleStudyChange();

    const vpUnsub = viewportGridService.subscribe(
      viewportGridService.EVENTS?.ACTIVE_VIEWPORT_ID_CHANGED ?? 'ACTIVE_VIEWPORT_ID_CHANGED',
      handleStudyChange
    );

    // Also watch display-set changes: if display sets weren't available when the
    // immediate check ran (getActiveStudyUID returned null), this catches the
    // moment they finish loading.
    const dsUnsub = displaySetService?.subscribe?.(
      displaySetService.EVENTS?.DISPLAY_SETS_CHANGED ?? 'DISPLAY_SETS_CHANGED',
      handleStudyChange
    );

    return () => {
      vpUnsub?.unsubscribe?.();
      dsUnsub?.unsubscribe?.();
    };
  }, [services]);

  // Scroll behaviour after every render that touches the visible message list:
  //   • "load more" render  → restore relative scroll position so the view
  //     doesn't jump to the top after older messages are prepended.
  //   • any other render    → smooth-scroll to the bottom (new message / stream).
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if (isLoadingMoreRef.current) {
      container.scrollTop = container.scrollHeight - prevScrollHeightRef.current;
      isLoadingMoreRef.current = false;
      return;
    }
    // Only auto-scroll when the user is already near the bottom (within 150 px).
    // This prevents fighting the user if they scroll up to read during a long stream.
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom < 150) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, displayCount]);

  // Load an older page of messages when the user scrolls close to the top.
  const handleScrollMessages = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || !hasMore) return;
    if (container.scrollTop < 80) {
      prevScrollHeightRef.current = container.scrollHeight;
      isLoadingMoreRef.current = true;
      setDisplayCount(prev => prev + PAGE_SIZE);
    }
  }, [hasMore]);

  // When the active study changes, restart from the latest messages so the
  // user always sees the end of the new conversation immediately.
  useEffect(() => {
    setDisplayCount(PAGE_SIZE);
  }, [activeStudyUID]);

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

      const studyContext = services ? buildStudyContext(services, extensionManager) : null;

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
          // Discard any buffered tokens — the final content supersedes them.
          if (streamFlushTimerRef.current) {
            clearTimeout(streamFlushTimerRef.current);
            streamFlushTimerRef.current = null;
          }
          streamBufferRef.current = '';
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

        case 'tool_progress':
          // Update the elapsed-time indicator on the last running tool message.
          setMessages(prev => {
            const updated = [...prev];
            for (let i = updated.length - 1; i >= 0; i--) {
              if (updated[i].role === 'tool' && updated[i].toolStatus === 'running') {
                updated[i] = { ...updated[i], toolProgress: event.content };
                break;
              }
            }
            return updated;
          });
          break;

        case 'tool_end': {
          // Parse the tool output for an optional download_url produced by
          // result-generating tools such as extract_radiomics.
          let downloadUrl: string | undefined;
          let downloadFilename: string | undefined;
          try {
            const parsed = JSON.parse(event.toolOutput ?? '{}');
            if (parsed.download_url) {
              const backendUrl = agentService.getConfig().backendUrl.replace(/\/$/, '');
              downloadUrl = `${backendUrl}${parsed.download_url}`;
              // Extract filename from the query-string "path" param
              try {
                const urlObj = new URL(downloadUrl);
                const filePath = urlObj.searchParams.get('path') ?? '';
                downloadFilename = filePath.split('/').pop() || 'download';
              } catch {
                downloadFilename = 'download';
              }
            }
          } catch {
            // non-JSON output or no download_url — no button
          }

          // Update the last running tool message to success/error.
          // toolResult is intentionally not stored — it is never rendered and
          // can be very large (full radiomics JSON), which would bloat React
          // state and slow down every subsequent JSON.stringify for storage.
          setMessages(prev => {
            const updated = [...prev];
            for (let i = updated.length - 1; i >= 0; i--) {
              if (updated[i].role === 'tool' && updated[i].toolStatus === 'running') {
                updated[i] = {
                  ...updated[i],
                  toolStatus: event.type === 'tool_end' ? 'success' : 'error',
                  ...(downloadUrl ? { downloadUrl, downloadFilename } : {}),
                };
                break;
              }
            }
            return updated;
          });
          break;
        }

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
          // Buffer the token and flush to React state at most every STREAM_FLUSH_MS.
          // startTransition marks the update as non-urgent so user input (typing,
          // clicking) stays responsive even during a high-throughput LLM stream.
          if (event.content) {
            streamBufferRef.current += event.content;
            streamMsgIdRef.current = assistantMsgId;
            if (!streamFlushTimerRef.current) {
              streamFlushTimerRef.current = setTimeout(() => {
                streamFlushTimerRef.current = null;
                const text = streamBufferRef.current;
                const msgId = streamMsgIdRef.current;
                streamBufferRef.current = '';
                if (text && msgId) {
                  startTransition(() => {
                    setMessages(prev =>
                      prev.map(m =>
                        m.id === msgId ? { ...m, content: m.content + text } : m
                      )
                    );
                  });
                }
              }, STREAM_FLUSH_MS);
            }
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
    if (config.chatHistoryStorage === 'server' && activeStudyUID) {
      agentService.deleteServerHistory(activeStudyUID);
    } else {
      clearHistory(activeStudyUID, config.chatHistoryStorage);
    }
    setDisplayCount(PAGE_SIZE);
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
    // Discard any buffered tokens so they don't appear after cancellation
    if (streamFlushTimerRef.current) {
      clearTimeout(streamFlushTimerRef.current);
      streamFlushTimerRef.current = null;
    }
    streamBufferRef.current = '';
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
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto py-2"
        onScroll={handleScrollMessages}
      >
        {/* Scroll-up pagination indicators */}
        {hasMore && (
          <div className="py-2 text-center text-xs text-gray-500">
            Scroll up to load earlier messages
          </div>
        )}
        {!hasMore && messages.length > PAGE_SIZE && (
          <div className="py-2 text-center text-xs text-gray-700">
            — Beginning of conversation —
          </div>
        )}

        {visibleMessages.map(msg => (
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
