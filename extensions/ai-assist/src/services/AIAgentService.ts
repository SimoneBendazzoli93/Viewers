import type { AgentConfig, ChatMessage, ReportEntry, StreamMessage } from '../types';

const DEFAULT_CONFIG: AgentConfig = {
  backendUrl: 'http://localhost:8000',
  llmProvider: 'openai',
  llmModel: 'gpt-4o',
  segmentationModels: [
    {
      id: 'totalsegmentator',
      name: 'TotalSegmentator',
      description: 'Segment 117 anatomical structures',
      type: 'totalsegmentator',
    },
    {
      id: 'nnunet-autopet',
      name: 'AutoPET (nnU-Net)',
      description: 'Whole-body lesion detection for PET/CT',
      type: 'nnunet',
    },
  ],
  activeSegmentationModel: 'totalsegmentator',
  chatHistoryStorage: 'localStorage',
  language: 'English',
} satisfies AgentConfig;

const CONFIG_STORAGE_KEY = 'ohif-ai-assist-config';

export class AIAgentService {
  private config: AgentConfig;
  private abortController: AbortController | null = null;

  constructor() {
    this.config = this._loadConfig();
  }

  private _loadConfig(): AgentConfig {
    try {
      const stored = localStorage.getItem(CONFIG_STORAGE_KEY);
      if (stored) {
        return { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
      }
    } catch {
      // ignore parse errors
    }
    return { ...DEFAULT_CONFIG };
  }

  getConfig(): AgentConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<AgentConfig>): void {
    this.config = { ...this.config, ...updates };
    try {
      localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(this.config));
    } catch {
      // ignore storage errors
    }
  }

  /**
   * Send a chat message to the AI agent backend and stream the response.
   * Calls onStream for each streamed event, onError on failure, onDone when complete.
   */
  async sendMessage(
    message: string,
    history: ChatMessage[],
    studyContext: StudyContext | null,
    onStream: (event: StreamMessage) => void,
    onError: (error: string) => void,
    onDone: () => void
  ): Promise<void> {
    this.abortController = new AbortController();

    const payload = {
      message,
      history: history.map(m => ({ role: m.role, content: m.content })),
      study_context: studyContext,
      config: {
        llm_provider: this.config.llmProvider,
        llm_model: this.config.llmModel,
        segmentation_model: this.config.activeSegmentationModel,
        api_key: this.config.apiKey,
        language: this.config.language ?? 'English',
      },
    };

    try {
      const response = await fetch(`${this.config.backendUrl}/api/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        onError(`Backend error ${response.status}: ${errText}`);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        onError('No response body from backend');
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              onDone();
              return;
            }
            try {
              const event: StreamMessage = JSON.parse(data);
              onStream(event);
            } catch {
              // skip malformed events
            }
          }
        }
      }
      onDone();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        onDone();
      } else {
        onError(err instanceof Error ? err.message : 'Unknown error');
      }
    }
  }

  cancelCurrentRequest(): void {
    this.abortController?.abort();
  }

  async loadServerHistory(studyUID: string): Promise<ChatMessage[]> {
    try {
      const resp = await fetch(`${this.config.backendUrl}/api/chat/history/${encodeURIComponent(studyUID)}`);
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.messages ?? []).map((m: ChatMessage & { timestamp: string }) => ({
        ...m,
        timestamp: new Date(m.timestamp),
      }));
    } catch {
      return [];
    }
  }

  async saveServerHistory(studyUID: string, messages: ChatMessage[]): Promise<void> {
    try {
      await fetch(`${this.config.backendUrl}/api/chat/history/${encodeURIComponent(studyUID)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
      });
    } catch {
      // silently ignore network errors
    }
  }

  async deleteServerHistory(studyUID: string): Promise<void> {
    try {
      await fetch(`${this.config.backendUrl}/api/chat/history/${encodeURIComponent(studyUID)}`, {
        method: 'DELETE',
      });
    } catch {
      // silently ignore
    }
  }

  /**
   * List all saved radiology reports for a study.
   * Returns an empty array when none exist (the backend never returns 404 here).
   *
   * Backend endpoint: GET /api/reports/{studyUID}
   */
  async fetchReports(studyUID: string): Promise<ReportEntry[]> {
    try {
      const resp = await fetch(
        `${this.config.backendUrl}/api/reports/${encodeURIComponent(studyUID)}`
      );
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.reports ?? []) as ReportEntry[];
    } catch {
      return [];
    }
  }

  /**
   * Fetch the Markdown content of a specific report version.
   * Returns null when the file is not found or a network error occurs.
   *
   * Backend endpoint: GET /api/reports/{studyUID}/{filename}
   */
  async fetchReportContent(studyUID: string, filename: string): Promise<string | null> {
    try {
      const resp = await fetch(
        `${this.config.backendUrl}/api/reports/${encodeURIComponent(studyUID)}/${encodeURIComponent(filename)}`
      );
      if (!resp.ok) return null;
      const data = await resp.json();
      return (data.content as string) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch a previously-generated radiomics CSV for `studyUID` from the backend.
   * Returns the raw CSV text if the file exists, or null when the backend
   * responds with 404 (not yet generated) or an error occurs.
   *
   * Backend endpoint: GET /api/radiomics/{studyUID}
   */
  async fetchRadiomics(studyUID: string): Promise<string | null> {
    try {
      const resp = await fetch(
        `${this.config.backendUrl}/api/radiomics/${encodeURIComponent(studyUID)}`
      );
      if (!resp.ok) return null;
      return await resp.text();
    } catch {
      return null;
    }
  }

  async checkBackendHealth(): Promise<{ ok: boolean; version?: string }> {
    try {
      const resp = await fetch(`${this.config.backendUrl}/health`, { method: 'GET' });
      if (resp.ok) {
        const data = await resp.json();
        return { ok: true, version: data.version };
      }
      return { ok: false };
    } catch {
      return { ok: false };
    }
  }

  async getAvailableModels(): Promise<{ llm: LLMModelOption[]; segmentation: SegmentationModelConfig[] }> {
    try {
      const resp = await fetch(`${this.config.backendUrl}/api/models`);
      if (resp.ok) {
        return await resp.json();
      }
    } catch {
      // return defaults on error
    }
    return { llm: DEFAULT_LLM_MODELS, segmentation: this.config.segmentationModels };
  }
}

export interface StudyContext {
  studyInstanceUID?: string;
  seriesInstanceUID?: string;
  sopInstanceUID?: string;
  patientName?: string;
  studyDate?: string;
  modality?: string;
  dicomwebUrl?: string;
}

interface LLMModelOption {
  id: string;
  name: string;
  provider: string;
  description?: string;
}

interface SegmentationModelConfig {
  id: string;
  name: string;
  description: string;
  type: string;
}

// Static models for cloud providers only. Ollama models are fetched live from the backend.
export const DEFAULT_LLM_MODELS: LLMModelOption[] = [
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', description: 'OpenAI GPT-4o' },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai', description: 'OpenAI GPT-4o Mini (faster)' },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'anthropic', description: 'Anthropic Claude Opus 4.6' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic', description: 'Anthropic Claude Sonnet 4.6' },
];

export default AIAgentService;
