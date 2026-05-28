import { Types } from '@ohif/core';
import { AIAgentService } from './services/AIAgentService';
import { buildSegmentationViewerUrl } from './utils/buildSegmentationViewerUrl';
import { discoverStudySegmentations } from './utils/discoverStudySegmentations';

const agentService = new AIAgentService();

function getStudyUIDFromServices(servicesManager: AppTypes.ServicesManager): string | null {
  try {
    const { viewportGridService, displaySetService } = servicesManager.services;
    const { activeViewportId, viewports } = viewportGridService.getState();
    const viewport = viewports.get(activeViewportId);
    if (!viewport?.displaySetInstanceUIDs?.length) {
      return null;
    }
    const displaySet = displaySetService.getDisplaySetByUID(viewport.displaySetInstanceUIDs[0]);
    return displaySet?.StudyInstanceUID ?? null;
  } catch {
    return null;
  }
}

function getCommandsModule({ servicesManager, extensionManager }): Types.CommandsModule {
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
       * Reload the viewer in segmentation mode with a DICOM SEG series loaded.
       */
      openStudyInSegmentationMode: {
        commandFn: async ({
          studyInstanceUID,
        }: {
          studyInstanceUID?: string;
          seriesInstanceUIDs?: string[];
          initialSeriesInstanceUID?: string;
          segSeriesInstanceUID?: string;
        } = {}) => {
          const studyUID =
            studyInstanceUID ?? getStudyUIDFromServices(servicesManager);
          const discovery = await discoverStudySegmentations(
            extensionManager,
            servicesManager,
            studyUID
          );
          if (!discovery) {
            uiNotificationService?.show?.({
              title: 'MAIA Radiology Assistant',
              message: 'No DICOM SEG series found for the active study.',
              type: 'warning',
              duration: 5000,
            });
            return;
          }
          const dataSourceName = extensionManager?.activeDataSourceName as string | undefined;
          window.location.assign(
            buildSegmentationViewerUrl(discovery.viewerReload, dataSourceName)
          );
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
