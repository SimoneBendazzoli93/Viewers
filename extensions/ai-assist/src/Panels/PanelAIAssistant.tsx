import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { useSystem } from '@ohif/core';
import type { ChatHistoryStorage, ChatMessage, AgentConfig, ReportEntry, StreamMessage, DicomWebContext } from '../types';
import { AIAgentService } from '../services/AIAgentService';
import { ChatMessage as ChatMessageComponent } from '../components/ChatMessage';
import { StreamingMessage, type StreamingMessageHandle } from '../components/StreamingMessage';
import { AgentConfigPanel } from '../components/AgentConfigPanel';
import { QuickActionBar } from '../components/QuickActionBar';
import { RadiomicsTable } from '../components/RadiomicsTable';
import { ReportsPanel } from '../components/ReportsPanel';

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

  // ── Radiomics tab ─────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<'chat' | 'radiomics' | 'reports'>('chat');
  const [radiomicsData, setRadiomicsData] = useState<string | null>(null);
  const [radiomicsRefetchTick, setRadiomicsRefetchTick] = useState(0);
  const triggerRadiomicsRefetchRef = useRef<() => void>(() => {});
  const pendingAutoSwitchRef = useRef(false);

  // ── Reports tab ───────────────────────────────────────────────────────────
  // reportsList is empty-array (no tab) until at least one report exists.
  const [reportsList, setReportsList] = useState<ReportEntry[]>([]);
  const [reportsRefetchTick, setReportsRefetchTick] = useState(0);
  const triggerReportsRefetchRef = useRef<() => void>(() => {});
  const pendingAutoSwitchToReportsRef = useRef(false);

  // ── Lazy mount flags ──────────────────────────────────────────────────────
  // Heavy panels are not mounted until the user first visits the tab.
  // Once set to true they stay true for the lifetime of the current study.
  const [hasVisitedRadiomics, setHasVisitedRadiomics] = useState(false);
  const [hasVisitedReports, setHasVisitedReports] = useState(false);

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

  // Keep refetch callbacks current on every render (stable refs, latest fns).
  triggerRadiomicsRefetchRef.current = () => {
    pendingAutoSwitchRef.current = true;
    setRadiomicsRefetchTick(t => t + 1);
  };
  triggerReportsRefetchRef.current = () => {
    pendingAutoSwitchToReportsRef.current = true;
    setReportsRefetchTick(t => t + 1);
  };
  const serverSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const browserSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Imperative streaming ──────────────────────────────────────────────────
  // Tokens are handed straight to StreamingMessage.appendText() which queues
  // them in a pendingRef and drains at CHARS_PER_FRAME per animation frame
  // (smooth typewriter effect). No React state is touched during streaming
  // → zero re-renders, zero reconciliation, zero layout effects per token.

  // Handle to the imperatively-controlled streaming message DOM node.
  const streamingMsgRef = useRef<StreamingMessageHandle | null>(null);
  // Timestamp to show on the streaming bubble (set when streaming starts).
  const streamingMsgTimestampRef = useRef<Date>(new Date());

  // Scroll-to-bottom callback passed to StreamingMessage so the RAF drain
  // loop can keep the chat anchored as new characters appear.
  const handleStreamUpdate = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const dist = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (dist < 150) container.scrollTop = container.scrollHeight;
  }, []);

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

  // Stable callback passed to ReportsPanel for lazy content fetching.
  const fetchReportContent = useCallback(
    (filename: string) =>
      agentService.fetchReportContent(activeStudyUID ?? '', filename),
    [activeStudyUID]
  );

  // Slice of the full messages array that is currently rendered.
  // While streaming, hide the empty placeholder — <StreamingMessage> is shown instead.
  const visibleStart = Math.max(0, messages.length - displayCount);
  const visibleMessages = messages
    .slice(visibleStart)
    .filter(m => !(isStreaming && m.id === streamingMessageIdRef.current));
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

  // ── Scroll: load-more position restoration ───────────────────────────────
  // Must be synchronous (useLayoutEffect) to prevent visible jump when older
  // messages are prepended.  Only fires on displayCount changes.
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !isLoadingMoreRef.current) return;
    container.scrollTop = container.scrollHeight - prevScrollHeightRef.current;
    isLoadingMoreRef.current = false;
  }, [displayCount]);

  // ── Scroll: keep bottom in view when a new committed message arrives ─────
  // useLayoutEffect is fine here too — it's a simple scrollTop assignment,
  // not an animated scroll, so it won't block painting noticeably.
  useLayoutEffect(() => {
    if (isLoadingMoreRef.current) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom < 150) {
      container.scrollTop = container.scrollHeight;
    }
  }, [messages]);

  // Scroll-during-streaming is handled inside the flush timer callback so it
  // fires at the same rate as DOM text updates (no extra effect needed).

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

  // ── Reset both data tabs when the active study changes ───────────────────
  useEffect(() => {
    setActiveTab('chat');
    setRadiomicsData(null);
    setReportsList([]);
    setHasVisitedRadiomics(false);
    setHasVisitedReports(false);
  }, [activeStudyUID]);

  // ── Radiomics: fetch CSV whenever study or tick changes ──────────────────
  useEffect(() => {
    if (!activeStudyUID) return;
    agentService.fetchRadiomics(activeStudyUID).then(data => {
      setRadiomicsData(data);
      if (data && pendingAutoSwitchRef.current) {
        setHasVisitedRadiomics(true);
        setActiveTab('radiomics');
        pendingAutoSwitchRef.current = false;
      }
    });
  }, [activeStudyUID, radiomicsRefetchTick]);

  // ── Reports: fetch list whenever study or tick changes ───────────────────
  useEffect(() => {
    if (!activeStudyUID) return;
    agentService.fetchReports(activeStudyUID).then(list => {
      setReportsList(list);
      if (list.length > 0 && pendingAutoSwitchToReportsRef.current) {
        setHasVisitedReports(true);
        setActiveTab('reports');
        pendingAutoSwitchToReportsRef.current = false;
      }
    });
  }, [activeStudyUID, reportsRefetchTick]);

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

      // Create a placeholder for the assistant response.
      // The placeholder stays in the messages array but is hidden while
      // streaming — the <StreamingMessage> DOM node is shown instead.
      // On completion the placeholder is updated with the committed content.
      const assistantMsgId = nextId();
      const streamStartTime = new Date();
      streamingMsgTimestampRef.current = streamStartTime;
      streamingMessageIdRef.current = assistantMsgId;
      streamingMsgRef.current?.reset();
      setMessages(prev => [
        ...prev,
        {
          id: assistantMsgId,
          role: 'assistant',
          content: '',
          timestamp: streamStartTime,
        },
      ]);

      const historyForBackend = messages.filter(m => m.role !== 'tool');

      await agentService.sendMessage(
        text,
        historyForBackend,
        studyContext,
        (event: StreamMessage) => handleStreamEvent(event, assistantMsgId),
        (error: string) => {
          // getText() captures committed + still-queued text, then reset() clears all.
          const partialContent = streamingMsgRef.current?.getText() ?? '';
          streamingMsgRef.current?.reset();
          setMessages(prev =>
            prev.map(m =>
              m.id === assistantMsgId
                ? {
                    ...m,
                    content: partialContent
                      ? `${partialContent}\n\nError: ${error}`
                      : `Error: ${error}`,
                  }
                : m
            )
          );
          setIsStreaming(false);
          streamingMessageIdRef.current = null;
        },
        () => {
          // onDone: getText() captures committed + still-queued text, then
          // reset() clears the node. React re-render switches to MarkdownRenderer.
          const finalContent = streamingMsgRef.current?.getText() ?? '';
          streamingMsgRef.current?.reset();
          if (finalContent) {
            setMessages(prev =>
              prev.map(m =>
                m.id === assistantMsgId ? { ...m, content: finalContent } : m
              )
            );
          }
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
          // The "Agent is thinking…" spinner in the chat bar already covers this.
          break;

        case 'final':
          // The final event carries the authoritative complete text.
          // Reset clears the pending queue + RAF, then appendText re-queues
          // the full answer for a clean typewriter playback to completion.
          streamingMsgRef.current?.reset();
          streamingMsgRef.current?.appendText(event.content);
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
          // event.downloadUrl is a server-relative path set by result-generating
          // tools (e.g. extract_radiomics). Build the full URL and derive the filename.
          let downloadUrl: string | undefined;
          let downloadFilename: string | undefined;
          if (event.downloadUrl) {
            const backendUrl = agentService.getConfig().backendUrl.replace(/\/$/, '');
            downloadUrl = `${backendUrl}${event.downloadUrl}`;
            try {
              const urlObj = new URL(downloadUrl);
              const filePath = urlObj.searchParams.get('path') ?? '';
              downloadFilename = filePath.split('/').pop() || 'download';
            } catch {
              downloadFilename = 'download';
            }
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

          // Re-fetch radiomics CSV if a radiomics tool just completed.
          if (event.toolName?.toLowerCase().includes('radiomics')) {
            triggerRadiomicsRefetchRef.current();
          }
          break;
        }

        case 'report_saved':
          // A new report was saved on the backend — refresh the reports list
          // and auto-switch to the Reports tab.
          triggerReportsRefetchRef.current();
          break;

        case 'action':
          break; // no displayable content

        case 'observation':
        default:
          // Hand the token straight to the typewriter queue — no React state
          // update, no re-render, no reconciliation. The RAF loop inside
          // StreamingMessage drains at a smooth fixed rate and calls onUpdate
          // (scroll) after each frame.
          if (event.content) {
            streamingMsgRef.current?.appendText(event.content);
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
    streamingMsgRef.current?.reset();
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
    // getText() captures committed + queued text; reset() cancels the RAF.
    const partialContent = streamingMsgRef.current?.getText() ?? '';
    streamingMsgRef.current?.reset();
    if (partialContent && streamingMessageIdRef.current) {
      const msgId = streamingMessageIdRef.current;
      setMessages(prev =>
        prev.map(m => (m.id === msgId ? { ...m, content: partialContent } : m))
      );
    }
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

      {/* Tab bar — shown whenever at least one non-chat tab has data */}
      {(radiomicsData !== null || reportsList.length > 0) && (
        <div className="flex border-b border-gray-700 px-3">
          {(
            [
              { id: 'chat',     label: 'Chat' },
              { id: 'reports',  label: 'Reports',  hidden: reportsList.length === 0 },
              { id: 'radiomics',label: 'Radiomics', hidden: radiomicsData === null },
            ] as { id: 'chat' | 'reports' | 'radiomics'; label: string; hidden?: boolean }[]
          )
            .filter(t => !t.hidden)
            .map(tab => (
              <button
                key={tab.id}
                onClick={() => {
                  setActiveTab(tab.id);
                  if (tab.id === 'radiomics') setHasVisitedRadiomics(true);
                  if (tab.id === 'reports') setHasVisitedReports(true);
                }}
                className={`mr-4 border-b-2 py-1.5 text-xs font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'border-blue-500 text-blue-400'
                    : 'border-transparent text-gray-500 hover:text-gray-300'
                }`}
              >
                {tab.label}
              </button>
            ))}
        </div>
      )}

      {/* ── Chat panel ─────────────────────────────────────────────────────
          Kept in the DOM even when hidden so scroll position is preserved.  */}
      <div
        className={
          activeTab === 'chat' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'
        }
      >
        {/* Messages */}
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto py-2"
          onScroll={handleScrollMessages}
        >
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

          {/* Streaming bubble — typewriter via RAF, zero React re-renders. */}
          {isStreaming && streamingMessageIdRef.current && (
            <StreamingMessage
              ref={streamingMsgRef}
              timestamp={streamingMsgTimestampRef.current}
              onUpdate={handleStreamUpdate}
            />
          )}

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
          <p className="mt-1 text-right text-xs text-gray-600">
            Enter to send · Shift+Enter for newline
          </p>
        </div>
      </div>

      {/* ── Reports panel ────────────────────────────────────────────────── */}
      {reportsList.length > 0 && hasVisitedReports && (
        <div
          className={
            activeTab === 'reports' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'
          }
        >
          <ReportsPanel
            reports={reportsList}
            fetchContent={fetchReportContent}
          />
        </div>
      )}

      {/* ── Radiomics panel ───────────────────────────────────────────────── */}
      {radiomicsData !== null && hasVisitedRadiomics && (
        <div
          className={
            activeTab === 'radiomics' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'
          }
        >
          <RadiomicsTable csvText={radiomicsData} />
        </div>
      )}
    </div>
  );
}

export default PanelAIAssistant;
