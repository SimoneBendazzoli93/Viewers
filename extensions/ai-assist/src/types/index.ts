export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'log';
  content: string;
  timestamp: Date;
  toolName?: string;
  toolStatus?: 'running' | 'success' | 'error';
  toolResult?: string;
  /** Elapsed-time string injected by tool_progress events while the tool runs. */
  toolProgress?: string;
  /** Live log lines streamed from long-running tools (e.g. Docker segmentation). */
  toolLogs?: string[];
  /** True while a log message is still receiving streamed lines. */
  logActive?: boolean;
  /** Full URL to a downloadable result file produced by the tool (e.g. CSV). */
  downloadUrl?: string;
  /** Human-readable filename shown on the download button. */
  downloadFilename?: string;
  /** OHIF viewer reload target after segmentation completes. */
  viewerReload?: ViewerReloadPayload;
  /** Pre-built viewer URL for opening segmentation mode with the new DICOM SEG. */
  viewerReloadUrl?: string;
}

/** Parameters for reloading OHIF in segmentation mode with a DICOM SEG series. */
export interface ViewerReloadPayload {
  mode: string;
  studyInstanceUID: string;
  seriesInstanceUIDs: string[];
  initialSeriesInstanceUID?: string;
  segSeriesInstanceUID?: string;
  dataSourceName?: string;
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
  language: string;
}

export type LLMProvider = 'openai' | 'anthropic' | 'ollama' | 'openrouter' | 'azure';

export interface SegmentationModelConfig {
  id: string;
  name: string;
  description: string;
  type: 'totalsegmentator' | 'monet' | 'custom';
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

/** One entry in the list returned by GET /api/reports/{studyUID}. */
export interface ReportEntry {
  /** Sequential version number starting at 1, newest = highest. */
  version: number;
  /** Filename on the server, e.g. "v003_20240115_143022.md". */
  filename: string;
  /** ISO-8601 creation timestamp (from file mtime). */
  created_at: string;
  /** File size in bytes. */
  size: number;
}

export interface StreamMessage {
  type: 'thought' | 'action' | 'observation' | 'final' | 'error' | 'tool_start' | 'tool_end' | 'tool_progress' | 'tool_log' | 'report_saved';
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  /** Seconds elapsed since the current tool started (present on tool_progress events). */
  elapsed?: number;
  /** Server-relative download path for result files produced by a tool (e.g. CSV). */
  downloadUrl?: string;
  /** Viewer reload parameters when a segmentation tool produced a DICOM SEG. */
  viewerReload?: ViewerReloadPayload;
}
