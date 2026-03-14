export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: Date;
  toolName?: string;
  toolStatus?: 'running' | 'success' | 'error';
  toolResult?: string;
  /** Elapsed-time string injected by tool_progress events while the tool runs. */
  toolProgress?: string;
}

export type ChatHistoryStorage = 'localStorage' | 'sessionStorage' | 'none' | 'server';

export interface AgentConfig {
  backendUrl: string;
  llmProvider: LLMProvider;
  llmModel: string;
  segmentationModels: SegmentationModelConfig[];
  activeSegmentationModel: string;
  apiKey?: string;
  chatHistoryStorage: ChatHistoryStorage;
}

export type LLMProvider = 'openai' | 'anthropic' | 'ollama' | 'openrouter' | 'azure';

export interface SegmentationModelConfig {
  id: string;
  name: string;
  description: string;
  type: 'totalsegmentator' | 'nnunet' | 'custom';
  endpoint?: string;
  structures?: string[];
}

export interface LLMModelOption {
  id: string;
  name: string;
  provider: LLMProvider;
  description?: string;
}

/**
 * DICOMweb endpoint configuration extracted from the active OHIF data source.
 * Field names match the OHIF data source configuration object exactly so values
 * can be forwarded to the backend without transformation.
 */
export interface DicomWebContext {
  wadoRoot?: string;       // WADO-RS base URL — used by tools as dicomweb_url
  qidoRoot?: string;       // QIDO-RS base URL
  wadoUriRoot?: string;    // WADO-URI base URL
  staticWado?: boolean;    // server serves pre-generated static files
  singlepart?: string;     // comma-sep modalities: "bulkdata,video"
}

export interface DicomSegInfo {
  seriesInstanceUID: string;
  seriesDescription?: string;
  referencedSeriesInstanceUID?: string;
}

export interface AgentAction {
  type: 'segmentation' | 'radiomics' | 'report' | 'query';
  parameters?: Record<string, unknown>;
}

export interface StreamMessage {
  type: 'thought' | 'action' | 'observation' | 'final' | 'error' | 'tool_start' | 'tool_end' | 'tool_progress';
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  /** Seconds elapsed since the current tool started (present on tool_progress events). */
  elapsed?: number;
}
