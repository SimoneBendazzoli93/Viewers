import React, { useState, useEffect, useCallback } from 'react';
import type { AgentConfig, LLMModelOption, LLMProvider, SegmentationModelConfig } from '../types';
import { DEFAULT_LLM_MODELS } from '../services/AIAgentService';

interface Props {
  config: AgentConfig;
  onSave: (config: AgentConfig) => void;
  onClose: () => void;
}

const PROVIDERS: { value: LLMProvider; label: string }[] = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'azure', label: 'Azure OpenAI' },
];

const API_KEY_PLACEHOLDER: Record<LLMProvider, string> = {
  openai: 'sk-...',
  anthropic: 'sk-ant-...',
  ollama: 'Bearer token (if required by your Ollama server)',
  openrouter: 'sk-or-...',
  azure: 'Azure API key',
};

export function AgentConfigPanel({ config, onSave, onClose }: Props) {
  const [local, setLocal] = useState<AgentConfig>({ ...config });
  const [customSegModelName, setCustomSegModelName] = useState('');
  const [customSegModelEndpoint, setCustomSegModelEndpoint] = useState('');

  // Ollama model fetching state
  const [ollamaModels, setOllamaModels] = useState<LLMModelOption[]>([]);
  const [ollamaLoading, setOllamaLoading] = useState(false);
  const [ollamaError, setOllamaError] = useState<string | null>(null);

  // For non-Ollama providers, use the static list
  const staticModels = DEFAULT_LLM_MODELS.filter(m => m.provider === local.llmProvider);
  const isOllama = local.llmProvider === 'ollama';
  const activeModels = isOllama ? ollamaModels : staticModels;

  const fetchOllamaModels = useCallback(async () => {
    setOllamaLoading(true);
    setOllamaError(null);
    try {
      const url = new URL(`${local.backendUrl}/api/ollama/models`);
      const headers: Record<string, string> = {};
      if (local.apiKey) {
        headers['Authorization'] = `Bearer ${local.apiKey}`;
      }
      const resp = await fetch(url.toString(), { headers });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const models: LLMModelOption[] = (data.models ?? []).map((m: { id: string; name: string; description?: string }) => ({
        id: m.id,
        name: m.name,
        provider: 'ollama' as LLMProvider,
        description: m.description,
      }));
      setOllamaModels(models);
      if (models.length > 0 && !models.find(m => m.id === local.llmModel)) {
        setLocal(prev => ({ ...prev, llmModel: models[0].id }));
      }
    } catch (err: unknown) {
      setOllamaError(err instanceof Error ? err.message : 'Could not reach Ollama server');
      setOllamaModels([]);
    } finally {
      setOllamaLoading(false);
    }
  }, [local.backendUrl, local.apiKey, local.llmModel]);

  // Fetch Ollama models whenever we're on the Ollama provider
  useEffect(() => {
    if (isOllama) {
      fetchOllamaModels();
    }
  }, [isOllama]); // intentionally only on provider switch, not on every keystroke

  const handleProviderChange = (provider: LLMProvider) => {
    const firstStatic = DEFAULT_LLM_MODELS.find(m => m.provider === provider);
    setLocal(prev => ({
      ...prev,
      llmProvider: provider,
      llmModel: firstStatic?.id ?? '',
    }));
  };

  const handleAddCustomSegModel = useCallback(() => {
    if (!customSegModelName.trim() || !customSegModelEndpoint.trim()) return;
    const newModel: SegmentationModelConfig = {
      id: `custom-${Date.now()}`,
      name: customSegModelName.trim(),
      description: 'Custom segmentation model',
      type: 'custom',
      endpoint: customSegModelEndpoint.trim(),
    };
    setLocal(prev => ({
      ...prev,
      segmentationModels: [...prev.segmentationModels, newModel],
    }));
    setCustomSegModelName('');
    setCustomSegModelEndpoint('');
  }, [customSegModelName, customSegModelEndpoint]);

  const handleRemoveSegModel = (id: string) => {
    setLocal(prev => ({
      ...prev,
      segmentationModels: prev.segmentationModels.filter(m => m.id !== id),
      activeSegmentationModel:
        prev.activeSegmentationModel === id
          ? prev.segmentationModels[0]?.id ?? ''
          : prev.activeSegmentationModel,
    }));
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-gray-700 px-4 py-3">
        <span className="text-sm font-semibold text-white">Agent Configuration</span>
        <button onClick={onClose} className="text-gray-400 hover:text-white" aria-label="Close config">
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">

        {/* Backend URL */}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-300">Backend URL</label>
          <input
            type="text"
            className="w-full rounded border border-gray-600 bg-gray-800 px-2 py-1.5 text-sm text-white focus:border-blue-500 focus:outline-none"
            value={local.backendUrl}
            onChange={e => setLocal(prev => ({ ...prev, backendUrl: e.target.value }))}
            placeholder="http://localhost:8000"
          />
        </div>

        {/* LLM Provider */}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-300">LLM Provider</label>
          <select
            className="w-full rounded border border-gray-600 bg-gray-800 px-2 py-1.5 text-sm text-white focus:border-blue-500 focus:outline-none"
            value={local.llmProvider}
            onChange={e => handleProviderChange(e.target.value as LLMProvider)}
          >
            {PROVIDERS.map(p => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>

        {/* API Key — shown for all providers */}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-300">
            API Key
            <span className="ml-1 text-gray-500">(stored in browser only)</span>
          </label>
          <input
            type="password"
            className="w-full rounded border border-gray-600 bg-gray-800 px-2 py-1.5 text-sm text-white focus:border-blue-500 focus:outline-none"
            value={local.apiKey ?? ''}
            onChange={e => setLocal(prev => ({ ...prev, apiKey: e.target.value }))}
            placeholder={API_KEY_PLACEHOLDER[local.llmProvider]}
          />
        </div>

        {/* LLM Model */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-xs font-medium text-gray-300">Model</label>
            {isOllama && (
              <button
                onClick={fetchOllamaModels}
                disabled={ollamaLoading}
                className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40"
              >
                {ollamaLoading ? '⟳ Loading...' : '↻ Refresh'}
              </button>
            )}
          </div>

          {isOllama ? (
            ollamaLoading ? (
              <div className="rounded border border-gray-600 bg-gray-800 px-2 py-2 text-xs text-gray-400">
                Fetching models from Ollama server...
              </div>
            ) : ollamaError ? (
              <div className="space-y-1.5">
                <div className="rounded border border-red-800 bg-red-950 px-2 py-1.5 text-xs text-red-300">
                  {ollamaError}
                </div>
                <input
                  type="text"
                  className="w-full rounded border border-gray-600 bg-gray-800 px-2 py-1.5 text-sm text-white focus:border-blue-500 focus:outline-none"
                  value={local.llmModel}
                  onChange={e => setLocal(prev => ({ ...prev, llmModel: e.target.value }))}
                  placeholder="Enter model name manually (e.g. qwen3:32b)"
                />
              </div>
            ) : ollamaModels.length > 0 ? (
              <select
                className="w-full rounded border border-gray-600 bg-gray-800 px-2 py-1.5 text-sm text-white focus:border-blue-500 focus:outline-none"
                value={local.llmModel}
                onChange={e => setLocal(prev => ({ ...prev, llmModel: e.target.value }))}
              >
                {ollamaModels.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.name}{m.description ? ` — ${m.description}` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                className="w-full rounded border border-gray-600 bg-gray-800 px-2 py-1.5 text-sm text-white focus:border-blue-500 focus:outline-none"
                value={local.llmModel}
                onChange={e => setLocal(prev => ({ ...prev, llmModel: e.target.value }))}
                placeholder="Enter model name (e.g. qwen3:32b)"
              />
            )
          ) : activeModels.length > 0 ? (
            <select
              className="w-full rounded border border-gray-600 bg-gray-800 px-2 py-1.5 text-sm text-white focus:border-blue-500 focus:outline-none"
              value={local.llmModel}
              onChange={e => setLocal(prev => ({ ...prev, llmModel: e.target.value }))}
            >
              {activeModels.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              className="w-full rounded border border-gray-600 bg-gray-800 px-2 py-1.5 text-sm text-white focus:border-blue-500 focus:outline-none"
              value={local.llmModel}
              onChange={e => setLocal(prev => ({ ...prev, llmModel: e.target.value }))}
              placeholder="Enter model name"
            />
          )}
        </div>

        {/* Active Segmentation Model */}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-300">
            Active Segmentation Model
          </label>
          <select
            className="w-full rounded border border-gray-600 bg-gray-800 px-2 py-1.5 text-sm text-white focus:border-blue-500 focus:outline-none"
            value={local.activeSegmentationModel}
            onChange={e => setLocal(prev => ({ ...prev, activeSegmentationModel: e.target.value }))}
          >
            {local.segmentationModels.map(m => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>

        {/* Segmentation model list */}
        <div>
          <label className="mb-2 block text-xs font-medium text-gray-300">Segmentation Models</label>
          <div className="space-y-1">
            {local.segmentationModels.map(m => (
              <div
                key={m.id}
                className="flex items-center justify-between rounded border border-gray-700 bg-gray-800 px-2 py-1.5"
              >
                <div>
                  <span className="text-sm text-white">{m.name}</span>
                  <span className="ml-2 rounded bg-gray-700 px-1 text-xs text-gray-400">{m.type}</span>
                  {m.endpoint && (
                    <div className="truncate max-w-[160px] text-xs text-gray-500">{m.endpoint}</div>
                  )}
                </div>
                {m.type === 'custom' && (
                  <button
                    onClick={() => handleRemoveSegModel(m.id)}
                    className="ml-2 text-xs text-red-400 hover:text-red-300"
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Add custom segmentation model */}
          <div className="mt-3 rounded border border-dashed border-gray-600 p-3">
            <p className="mb-2 text-xs font-medium text-gray-400">Add Custom Model</p>
            <input
              type="text"
              className="mb-1.5 w-full rounded border border-gray-600 bg-gray-900 px-2 py-1 text-xs text-white focus:border-blue-500 focus:outline-none"
              value={customSegModelName}
              onChange={e => setCustomSegModelName(e.target.value)}
              placeholder="Model name (e.g. My Liver Segmenter)"
            />
            <input
              type="text"
              className="mb-2 w-full rounded border border-gray-600 bg-gray-900 px-2 py-1 text-xs text-white focus:border-blue-500 focus:outline-none"
              value={customSegModelEndpoint}
              onChange={e => setCustomSegModelEndpoint(e.target.value)}
              placeholder="Endpoint URL (e.g. http://localhost:9000)"
            />
            <button
              onClick={handleAddCustomSegModel}
              disabled={!customSegModelName.trim() || !customSegModelEndpoint.trim()}
              className="w-full rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-500 disabled:opacity-40"
            >
              Add Model
            </button>
          </div>
        </div>

      </div>

      <div className="flex gap-2 border-t border-gray-700 px-4 py-3">
        <button
          onClick={onClose}
          className="flex-1 rounded border border-gray-600 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700"
        >
          Cancel
        </button>
        <button
          onClick={() => onSave(local)}
          className="flex-1 rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500"
        >
          Save
        </button>
      </div>
    </div>
  );
}

export default AgentConfigPanel;
