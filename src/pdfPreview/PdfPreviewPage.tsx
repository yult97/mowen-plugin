import React, { useEffect, useState } from 'react';
import { Download, FileWarning, Loader2 } from 'lucide-react';
import { downloadPdfBlob } from '../utils/pdfPreview';
import { getPdfPreviewEntry } from '../utils/pdfPreviewStore';

type PreviewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; fileName: string; blob: Blob; viewerUrl: string };

function getPreviewIdFromLocation(): string {
  const searchParams = new URLSearchParams(window.location.search);
  return searchParams.get('id')?.trim() || '';
}

function formatPreviewError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return 'PDF 预览加载失败，请重新导出后再试。';
}

const PdfPreviewPage: React.FC = () => {
  const [previewState, setPreviewState] = useState<PreviewState>({ status: 'loading' });

  useEffect(() => {
    const previewId = getPreviewIdFromLocation();
    let currentObjectUrl: string | null = null;
    let isDisposed = false;

    const loadPreview = async () => {
      if (!previewId) {
        setPreviewState({
          status: 'error',
          message: '未找到 PDF 预览数据，请重新导出后再试。',
        });
        return;
      }

      try {
        const entry = await getPdfPreviewEntry(previewId);

        if (!entry) {
          setPreviewState({
            status: 'error',
            message: 'PDF 预览已失效或不存在，请重新导出后再试。',
          });
          return;
        }

        currentObjectUrl = URL.createObjectURL(entry.blob);
        document.title = `${entry.fileName} - PDF 预览`;

        if (!isDisposed) {
          setPreviewState({
            status: 'ready',
            fileName: entry.fileName,
            blob: entry.blob,
            viewerUrl: `${currentObjectUrl}#view=Fit`,
          });
        }
      } catch (error) {
        if (!isDisposed) {
          setPreviewState({
            status: 'error',
            message: formatPreviewError(error),
          });
        }
      }
    };

    void loadPreview();

    return () => {
      isDisposed = true;
      if (currentObjectUrl) {
        URL.revokeObjectURL(currentObjectUrl);
      }
    };
  }, []);

  const handleDownload = async () => {
    if (previewState.status !== 'ready') {
      return;
    }

    await downloadPdfBlob(previewState.fileName, previewState.blob);
  };

  return (
    <div className="pdf-preview-page">
      {previewState.status === 'ready' && (
        <>
          <iframe
            className="pdf-preview-frame"
            src={previewState.viewerUrl}
            title={`${previewState.fileName} PDF 预览`}
          />
          <div className="pdf-preview-floating-actions">
            <button
              type="button"
              className="pdf-preview-download-button"
              onClick={() => void handleDownload()}
            >
              <Download size={16} />
              <span>下载 PDF</span>
            </button>
          </div>
        </>
      )}

      {previewState.status === 'loading' && (
        <div className="pdf-preview-overlay">
          <div className="pdf-preview-status-card">
            <Loader2 className="pdf-preview-spin" size={22} />
            <div>
              <div className="pdf-preview-status-title">正在加载 PDF 预览</div>
              <div className="pdf-preview-status-text">将以整页适配方式打开</div>
            </div>
          </div>
        </div>
      )}

      {previewState.status === 'error' && (
        <div className="pdf-preview-overlay">
          <div className="pdf-preview-status-card pdf-preview-status-card-error">
            <FileWarning size={22} />
            <div>
              <div className="pdf-preview-status-title">无法打开 PDF 预览</div>
              <div className="pdf-preview-status-text">{previewState.message}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PdfPreviewPage;
