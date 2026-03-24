/**
 * PDF 输出层：
 * 负责把 html2pdf/jsPDF 产出的二进制结果转换为 Blob，
 * 并在需要时追加阅读器兼容性后处理。
 */
let pdfLibModule: typeof import('pdf-lib') | null = null;

async function getPdfLib() {
  if (!pdfLibModule) {
    const module = await import('pdf-lib');
    pdfLibModule = module;
  }

  return pdfLibModule;
}

function toUint8Array(
  data: ArrayBuffer | Uint8Array | ArrayBufferView
): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  throw new Error('Unsupported PDF binary payload type');
}

function toArrayBuffer(data: ArrayBuffer | Uint8Array | ArrayBufferView): ArrayBuffer {
  if (data instanceof ArrayBuffer) {
    return data;
  }

  const bytes = toUint8Array(data);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export async function normalizePdfForViewerCompatibility(
  pdfBinary: ArrayBuffer | Uint8Array | ArrayBufferView
): Promise<Blob> {
  // 某些阅读器会受目录级 ViewerPreferences / OpenAction 影响，
  // 这里统一清理这些字段，减少扩展内预览与浏览器默认预览的兼容差异。
  const { PDFDocument, PDFName } = await getPdfLib();
  const sourceBytes = toUint8Array(pdfBinary);
  const pdfDocument = await PDFDocument.load(sourceBytes, {
    updateMetadata: false,
  });
  const catalog = pdfDocument.catalog;

  for (const key of ['OpenAction', 'PageLayout', 'PageMode', 'ViewerPreferences']) {
    catalog.delete(PDFName.of(key));
  }

  const normalizedBytes = await pdfDocument.save({
    useObjectStreams: false,
    updateFieldAppearances: false,
  });

  return new Blob([toArrayBuffer(normalizedBytes)], { type: 'application/pdf' });
}

export async function outputPdfBlob(
  worker: { outputPdf: (type: 'arraybuffer') => Promise<ArrayBuffer | Uint8Array | ArrayBufferView> },
  options: {
    normalizeForViewer?: boolean;
  } = {}
): Promise<Blob> {
  // 统一封装导出结果，避免业务层重复处理 ArrayBuffer / Blob 转换逻辑。
  const rawPdfBinary = await worker.outputPdf('arraybuffer');

  if (!options.normalizeForViewer) {
    return new Blob([toArrayBuffer(rawPdfBinary)], { type: 'application/pdf' });
  }

  try {
    return await normalizePdfForViewerCompatibility(rawPdfBinary);
  } catch (error) {
    console.warn('[pdfOutput] normalizePdfForViewerCompatibility failed:', error);
    return new Blob([toArrayBuffer(rawPdfBinary)], { type: 'application/pdf' });
  }
}
