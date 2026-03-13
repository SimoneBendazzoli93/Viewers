import React, { useState, useEffect, useCallback } from 'react';
import type { AgentConfig, LLMProvider, SegmentationModelConfig } from '../types';
import { DEFAULT_LLM_MODELS } from '../services/AIAgentService';

interface Props {
  config: AgentConfig;
  onSave: (config: AgentConfig) => void;
  onClose: () => void;
  availableSegmentationModels?: SegmentationModelConfig[];
}

const PROVIDERS: { value: LLMProvider; label: string }[] = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'ollama', label: 'Ollama (local)' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'azure', label: 'Azure OpenAI' },
];

export function AgentConfigPanel({ config, onSave, onClose, availableSegmentationModels }: Props) {
  const [local, setLocal] = useState<AgentConfig>({ ...config });
  const [customModelInput, setCustomModelInput] = useState('');
  const [customSegModelName, setCustomSegModelName] = useState('');
  const [customSegModelEndpoint, setCustomSegModelEndpoint] = useState('');

  const filteredModels = DEFAULT_LLM_MODELS.filter(m => m.provider === local.llmProvider);

  const handleProviderChange = (provider: LLMProvider) => {
    const firstModel = DEFAULT_LLM_MODELS.find(m => m.provider === provider);
    setLocal(prev => ({
      ...prev,
      llmProvider: provider,
      llmModel: firstModel?.id ?? '',
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
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-white"
          aria-label="Close config"
        >
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

        {/* LLM Model */}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-300">Model</label>
          {filteredModels.length > 0 ? (
            <select
              className="w-full rounded border border-gray-600 bg-gray-800 px-2 py-1.5 text-sm text-white focus:border-blue-500 focus:outline-none"
              value={local.llmModel}
              onChange={e => setLocal(prev => ({ ...prev, llmModel: e.target.value }))}
            >
              {filteredModels.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              className="w-full rounded border border-gray-600 bg-gray-800 px-2 py-1.5 text-sm text-white focus:border-blue-500 focus:outline-none"
              value={local.llmModel}
              onChange={e => setLocal(prev => ({ ...prev, llmModel: e.target.value }))}
              placeholder="Enter model name (e.g. llama3.2)"
            />
          )}
        </div>

        {/* API Key */}
        {local.llmProvider !== 'ollama' && (
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-300">
              API Key{' '}
              <span className="text-gray-500">(stored locally)</span>
            </label>
            <input
              type="password"
              className="w-full rounded border border-gray-600 bg-gray-800 px-2 py-1.5 text-sm text-white focus:border-blue-500 focus:outline-none"
              value={local.apiKey ?? ''}
              onChange={e => setLocal(prev => ({ ...prev, apiKey: e.target.value }))}
              placeholder="sk-..."
            />
          </div>
        )}

        {/* Segmentation Models */}
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

        {/* Registered segmentation models */}
        <div>
          <label className="mb-2 block text-xs font-medium text-gray-300">
            Segmentation Models
          </label>
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
                    <div className="text-xs text-gray-500 truncate max-w-[160px]">{m.endpoint}</div>
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
