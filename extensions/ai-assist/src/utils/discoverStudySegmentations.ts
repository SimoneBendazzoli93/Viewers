import type { ViewerReloadPayload } from '../types';

export interface StudySegmentationDiscovery {
  studyInstanceUID: string;
  segSeriesInstanceUIDs: string[];
  imageSeriesInstanceUID: string;
  viewerReload: ViewerReloadPayload;
}

function getActiveImageSeriesUID(servicesManager: AppTypes.ServicesManager): string | null {
  try {
    const { viewportGridService, displaySetService } = servicesManager.services;
    const { activeViewportId, viewports } = viewportGridService.getState();
    const viewport = viewports.get(activeViewportId);
    if (!viewport?.displaySetInstanceUIDs?.length) {
      return null;
    }
    const displaySet = displaySetService.getDisplaySetByUID(viewport.displaySetInstanceUIDs[0]);
    if (!displaySet || displaySet.Modality === 'SEG') {
      return null;
    }
    return displaySet.SeriesInstanceUID ?? null;
  } catch {
    return null;
  }
}

function segSeriesFromDisplaySets(
  servicesManager: AppTypes.ServicesManager,
  studyInstanceUID: string
): { segUids: string[]; referencedImageUids: string[] } {
  const { displaySetService } = servicesManager.services;
  const allDisplaySets: AppTypes.DisplaySet[] = displaySetService.activeDisplaySets ?? [];
  const segUids: string[] = [];
  const referencedImageUids: string[] = [];

  for (const ds of allDisplaySets) {
    if (ds.StudyInstanceUID !== studyInstanceUID || ds.Modality !== 'SEG') {
      continue;
    }
    if (ds.SeriesInstanceUID) {
      segUids.push(ds.SeriesInstanceUID);
    }
    const refUid =
      (ds as AppTypes.DisplaySet & { referencedSeriesInstanceUID?: string }).referencedSeriesInstanceUID ??
      (ds as AppTypes.DisplaySet & { ReferencedSeriesInstanceUID?: string }).ReferencedSeriesInstanceUID;
    if (refUid) {
      referencedImageUids.push(refUid);
    }
  }

  return { segUids, referencedImageUids };
}

type QidoSeries = {
  seriesInstanceUid?: string;
  modality?: string;
};

/**
 * Find DICOM SEG series for a study from loaded display sets and QIDO-RS.
 * QIDO is used so newly generated segmentations on the PACS are found even
 * before the current viewer session has loaded them.
 */
export async function discoverStudySegmentations(
  extensionManager: AppTypes.ExtensionManager | undefined,
  servicesManager: AppTypes.ServicesManager | undefined,
  studyInstanceUID: string | null
): Promise<StudySegmentationDiscovery | null> {
  if (!studyInstanceUID || !servicesManager) {
    return null;
  }

  const fromDisplaySets = segSeriesFromDisplaySets(servicesManager, studyInstanceUID);
  const segUidSet = new Set<string>(fromDisplaySets.segUids);
  let qidoSeries: QidoSeries[] = [];

  if (extensionManager) {
    try {
      const [dataSource] = extensionManager.getActiveDataSource?.() ?? [];
      const search = dataSource?.query?.series?.search;
      if (typeof search === 'function') {
        qidoSeries = (await search.call(dataSource.query.series, studyInstanceUID)) ?? [];
        for (const series of qidoSeries) {
          if (series.modality === 'SEG' && series.seriesInstanceUid) {
            segUidSet.add(series.seriesInstanceUid);
          }
        }
      }
    } catch {
      // Fall back to display sets only.
    }
  }

  const segSeriesInstanceUIDs = [...segUidSet];
  if (segSeriesInstanceUIDs.length === 0) {
    return null;
  }

  const activeImageUid = getActiveImageSeriesUID(servicesManager);
  const referencedImageUid = fromDisplaySets.referencedImageUids.find(Boolean);
  const fallbackImageFromQido = qidoSeries.find(s => s.modality && s.modality !== 'SEG')
    ?.seriesInstanceUid;
  const imageSeriesInstanceUID =
    activeImageUid ?? referencedImageUid ?? fallbackImageFromQido ?? segSeriesInstanceUIDs[0];

  const seriesInstanceUIDs = [
    ...new Set([imageSeriesInstanceUID, ...segSeriesInstanceUIDs].filter(Boolean)),
  ];

  return {
    studyInstanceUID,
    segSeriesInstanceUIDs,
    imageSeriesInstanceUID,
    viewerReload: {
      mode: 'segmentation',
      studyInstanceUID,
      seriesInstanceUIDs,
      initialSeriesInstanceUID: imageSeriesInstanceUID,
      segSeriesInstanceUID: segSeriesInstanceUIDs[segSeriesInstanceUIDs.length - 1],
    },
  };
}
