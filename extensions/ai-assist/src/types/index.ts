export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: Date;
  toolName?: string;
  toolStatus?: 'running' | 'success' | 'error';
  toolResult?: string;
}

export interface AgentConfig {
  backendUrl: string;
  llmProvider: LLMProvider;
  llmModel: string;
  segmentationModels: SegmentationModelConfig[];
  activeSegmentationModel: string;
  apiKey?: string;
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

export interface AgentAction {
  type: 'segmentation' | 'radiomics' | 'report' | 'query';
  parameters?: Record<string, unknown>;
}

export interface StreamMessage {
  type: 'thought' | 'action' | 'observation' | 'final' | 'error' | 'tool_start' | 'tool_end';
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
}
