import type { ExtractResult, SaveProgress, SaveStatus } from '../types';

export interface SaveProgressVisualState {
  overallProgress: number;
  phaseLabel: string;
  phaseDetail: string;
  hasImages: boolean;
  hasNotes: boolean;
  imagePhaseActive: boolean;
  notePhaseActive: boolean;
}

function normalizeSaveStatus(status: SaveStatus): SaveStatus {
  if (status === 'uploading') {
    return 'uploading_images';
  }

  if (status === 'creating') {
    return 'creating_note';
  }

  return status;
}

export function normalizeSaveProgress(progress: SaveProgress): SaveProgress {
  return {
    ...progress,
    status: normalizeSaveStatus(progress.status),
  };
}

export function createInitialSaveProgress(
  extractResult: ExtractResult,
  options: { includeImages: boolean; maxImages: number }
): SaveProgress {
  const totalImages = options.includeImages ? Math.min(extractResult.images.length, options.maxImages) : 0;
  const totalParts = Math.max(1, Math.ceil(Math.max(extractResult.wordCount || 0, 0) / 19000));

  return {
    status: totalImages > 0 ? 'uploading_images' : 'creating_note',
    uploadedImages: 0,
    totalImages,
    currentPart: 0,
    totalParts,
  };
}

export function getSaveProgressVisualState(progress: SaveProgress): SaveProgressVisualState {
  const normalizedProgress = normalizeSaveProgress(progress);
  const totalImages = normalizedProgress.totalImages || 0;
  const uploadedImages = Math.min(normalizedProgress.uploadedImages || 0, totalImages);
  const totalParts = normalizedProgress.totalParts || 0;
  const currentPart = Math.min(normalizedProgress.currentPart || 0, totalParts);
  const hasImages = totalImages > 0;
  const hasNotes = totalParts > 0;

  let overallProgress = 0;
  let phaseLabel = normalizedProgress.status === 'paused' ? '任务已暂停' : '处理中…';
  let phaseDetail = '';
  let imagePhaseActive = false;
  let notePhaseActive = false;

  if (hasImages) {
    const imageProgress = totalImages > 0 ? uploadedImages / totalImages : 0;
    const imagesComplete = uploadedImages >= totalImages;

    if (!imagesComplete || normalizedProgress.status === 'uploading_images') {
      overallProgress = imageProgress * 50;
      phaseLabel = normalizedProgress.status === 'paused' ? '已暂停在图片上传阶段' : '正在上传图片';
      phaseDetail = `${uploadedImages}/${totalImages}`;
      imagePhaseActive = true;
    } else if (hasNotes) {
      const noteProgress = totalParts > 0 ? currentPart / totalParts : 0;
      overallProgress = 50 + (noteProgress * 50);
      phaseLabel = normalizedProgress.status === 'paused' ? '已暂停在笔记创建阶段' : '正在创建笔记';
      phaseDetail = `${currentPart}/${totalParts}`;
      notePhaseActive = true;
    } else {
      overallProgress = 50;
      phaseLabel = normalizedProgress.status === 'paused' ? '已暂停，等待创建笔记' : '图片上传完成，准备创建笔记';
      notePhaseActive = true;
    }
  } else if (hasNotes) {
    const noteProgress = totalParts > 0 ? currentPart / totalParts : 0;
    overallProgress = noteProgress * 100;
    phaseLabel = normalizedProgress.status === 'paused' ? '已暂停在笔记创建阶段' : '正在创建笔记';
    phaseDetail = `${currentPart}/${totalParts}`;
    notePhaseActive = true;
  }

  return {
    overallProgress: Math.max(0, Math.min(overallProgress, 100)),
    phaseLabel,
    phaseDetail,
    hasImages,
    hasNotes,
    imagePhaseActive,
    notePhaseActive,
  };
}
