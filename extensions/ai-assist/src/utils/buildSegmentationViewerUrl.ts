import type { ViewerReloadPayload } from '../types';

/**
 * Build an OHIF viewer URL that opens segmentation mode with the study and
 * both the source image series and the DICOM SEG series loaded.
 */
export function buildSegmentationViewerUrl(
  payload: ViewerReloadPayload,
  dataSourceName?: string
): string {
  const source = dataSourceName ?? payload.dataSourceName ?? 'dicomweb';
  const params = new URLSearchParams();
  params.set('StudyInstanceUIDs', payload.studyInstanceUID);

  const seriesUids = payload.seriesInstanceUIDs.filter(Boolean);
  if (seriesUids.length > 0) {
    params.set('SeriesInstanceUIDs', seriesUids.join(','));
  }
  if (payload.initialSeriesInstanceUID) {
    params.set('initialSeriesInstanceUID', payload.initialSeriesInstanceUID);
  }

  const current = new URLSearchParams(window.location.search);
  for (const key of ['configUrl', 'token']) {
    const value = current.get(key);
    if (value) {
      params.set(key, value);
    }
  }

  const routerBasename =
    (window as Window & { config?: { routerBasename?: string } }).config?.routerBasename ?? '/';
  const base = routerBasename.replace(/\/$/, '');
  const mode = payload.mode || 'segmentation';
  const path = `${base}/${mode}/${source}`.replace(/\/{2,}/g, '/');

  return `${path}?${params.toString()}`;
}
