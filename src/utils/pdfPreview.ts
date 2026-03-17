import { savePdfPreviewEntry } from './pdfPreviewStore';

function ensurePdfFileName(fileName: string): string {
  const trimmedFileName = fileName.trim();
  const normalizedFileName = trimmedFileName || '导出笔记.pdf';

  return normalizedFileName.toLowerCase().endsWith('.pdf')
    ? normalizedFileName
    : `${normalizedFileName}.pdf`;
}

/**
 * 触发浏览器下载 PDF Blob。
 */
export async function downloadPdfBlob(fileName: string, blob: Blob): Promise<void> {
  const normalizedFileName = ensurePdfFileName(fileName);
  const objectUrl = URL.createObjectURL(blob);
  const downloadLink = document.createElement('a');

  downloadLink.href = objectUrl;
  downloadLink.download = normalizedFileName;
  downloadLink.rel = 'noopener';
  downloadLink.style.display = 'none';

  document.body.appendChild(downloadLink);
  downloadLink.click();

  window.setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
    downloadLink.remove();
  }, 1000);
}

/**
 * 在扩展内的新标签页中打开受控 PDF 预览，强制使用整页适配。
 */
export async function openPdfPreviewTab(fileName: string, blob: Blob): Promise<void> {
  const normalizedFileName = ensurePdfFileName(fileName);
  const previewId = crypto.randomUUID();

  await savePdfPreviewEntry({
    id: previewId,
    fileName: normalizedFileName,
    blob,
    createdAt: Date.now(),
  });

  const previewUrl = chrome.runtime.getURL(`pdfPreview.html?id=${encodeURIComponent(previewId)}`);

  if (chrome.tabs?.create) {
    await chrome.tabs.create({ url: previewUrl });
    return;
  }

  window.open(previewUrl, '_blank', 'noopener,noreferrer');
}

/**
 * 下载 PDF，并立即打开一个整页适配的受控预览页。
 */
export async function downloadAndPreviewPdf(fileName: string, blob: Blob): Promise<void> {
  const normalizedFileName = ensurePdfFileName(fileName);

  await downloadPdfBlob(normalizedFileName, blob);

  try {
    await openPdfPreviewTab(normalizedFileName, blob);
  } catch (error) {
    console.warn('[pdfPreview] Failed to open controlled preview tab:', error);
  }
}
