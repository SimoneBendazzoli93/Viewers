import React from 'react';

interface QuickAction {
  id: string;
  label: string;
  icon: string;
  prompt: string;
  description: string;
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    id: 'report',
    label: 'Report',
    icon: '📄',
    prompt: 'Generate a structured radiology report for the current study.',
    description: 'Generate radiology report',
  },
  {
    id: 'segment',
    label: 'Segment',
    icon: '🫀',
    prompt: 'Run automatic organ segmentation on the current series.',
    description: 'Auto-segment organs',
  },
  {
    id: 'radiomics',
    label: 'Radiomics',
    icon: '📊',
    prompt: 'Extract radiomics features from the current series and any available segmentation.',
    description: 'Extract radiomics features',
  },
  {
    id: 'describe',
    label: 'Describe',
    icon: '🔍',
    prompt: 'Describe the current DICOM study, patient information, and notable findings.',
    description: 'Describe study findings',
  },
  {
    id: 'analyze_segmentation',
    label: 'Analyze Segmentation',
    icon: '🔍',
    prompt: 'Analyze the segmentation mask.',
    description: 'Analyze segmentation masks',
  },
];

interface Props {
  onAction: (prompt: string) => void;
  disabled?: boolean;
}

export function QuickActionBar({ onAction, disabled }: Props) {
  return (
    <div className="flex flex-wrap gap-1 border-t border-gray-700 px-2 py-2">
      {QUICK_ACTIONS.map(action => (
        <button
          key={action.id}
          onClick={() => onAction(action.prompt)}
          disabled={disabled}
          title={action.description}
          className="flex items-center gap-1 rounded border border-gray-600 bg-gray-800 px-2 py-1 text-xs text-gray-300 transition-colors hover:border-blue-500 hover:bg-gray-700 hover:text-white disabled:opacity-40"
        >
          <span>{action.icon}</span>
          <span>{action.label}</span>
        </button>
      ))}
    </div>
  );
}

export default QuickActionBar;
