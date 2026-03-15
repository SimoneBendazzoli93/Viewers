import { Types } from '@ohif/core';
import { AIAgentService } from './services/AIAgentService';

const agentService = new AIAgentService();

function getCommandsModule({ servicesManager, commandsManager }): Types.CommandsModule {
  const { uiNotificationService } = servicesManager.services;

  return {
    definitions: {
      /**
       * Trigger the AI agent to run segmentation on the active viewport series.
       */
      runAISegmentation: {
        commandFn: async ({ segmentationModel }: { segmentationModel?: string } = {}) => {
          if (segmentationModel) {
            agentService.updateConfig({ activeSegmentationModel: segmentationModel });
          }

          uiNotificationService?.show?.({
            title: 'MAIA Radiology Assistant',
            message: 'Segmentation request sent to AI agent.',
            type: 'info',
            duration: 3000,
          });

          // The panel handles actual streaming; this command can be invoked
          // programmatically or from other extensions as an integration point.
        },
      },

      /**
       * Generate a radiology report for the active study via AI.
       */
      generateAIReport: {
        commandFn: async () => {
          uiNotificationService?.show?.({
            title: 'MAIA Radiology Assistant',
            message:
              'Report generation requested. Open the MAIA Radiology Assistant panel to view progress.',
            type: 'info',
            duration: 4000,
          });
        },
      },

      /**
       * Extract radiomics features via AI agent.
       */
      extractAIRadiomics: {
        commandFn: async () => {
          uiNotificationService?.show?.({
            title: 'MAIA Radiology Assistant',
            message:
              'Radiomics extraction requested. Open the MAIA Radiology Assistant panel to view progress.',
            type: 'info',
            duration: 4000,
          });
        },
      },

      /**
       * Check whether the AI backend is reachable.
       */
      checkAIBackendHealth: {
        commandFn: async () => {
          const { ok, version } = await agentService.checkBackendHealth();
          uiNotificationService?.show?.({
            title: 'MAIA Backend',
            message: ok
              ? `Backend is online${version ? ` (v${version})` : ''}.`
              : 'Backend is unreachable. Check configuration in the MAIA Radiology Assistant panel.',
            type: ok ? 'success' : 'error',
            duration: 4000,
          });
          return ok;
        },
      },

      /**
       * Update AI agent configuration programmatically.
       */
      updateAIConfig: {
        commandFn: (config: Partial<import('./types').AgentConfig>) => {
          agentService.updateConfig(config);
        },
      },
    },
    defaultContext: 'VIEWER',
  };
}

export default getCommandsModule;
