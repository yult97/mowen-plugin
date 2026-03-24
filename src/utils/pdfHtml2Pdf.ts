/**
 * html2pdf 运行时适配层：
 * 负责延迟加载 html2pdf，并补齐本项目导出所需的分页/overlay 行为补丁。
 */
// html2pdf.js 没有官方的 TypeScript 类型声明
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let html2pdfModule: any = null;
let html2pdfOverlayPatched = false;

function resolveHtml2CanvasScale(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  workerContext?: any
): number {
  const configuredScale = Number(workerContext?.opt?.html2canvas?.scale);
  if (Number.isFinite(configuredScale) && configuredScale > 0) {
    return configuredScale;
  }

  if (typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0) {
    return window.devicePixelRatio;
  }

  return 1;
}

export function computeCanvasAlignedPageMetricsFromExactCssWidth(
  exactCssWidth: number,
  exactRatio: number,
  scale: number
): {
  renderWidthPx: number;
  pageHeightPx: number;
  canvasPageHeightPx: number;
  ratio: number;
} {
  // 这里把 CSS 像素宽度与 html2canvas 的实际 canvas 尺寸对齐，
  // 目的是减少分页切片时的累计误差，避免长文出现页尾截断。
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const safeExactWidth = Number.isFinite(exactCssWidth) && exactCssWidth > 0 ? exactCssWidth : 1;
  const safeExactRatio = Number.isFinite(exactRatio) && exactRatio > 0 ? exactRatio : 1;
  const renderWidthPx = Math.max(1, Math.ceil(safeExactWidth));
  const canvasWidthPx = Math.max(1, Math.floor(renderWidthPx * safeScale));
  const canvasPageHeightPx = Math.max(1, Math.floor(canvasWidthPx * safeExactRatio));

  return {
    renderWidthPx,
    pageHeightPx: canvasPageHeightPx / safeScale,
    canvasPageHeightPx,
    ratio: canvasPageHeightPx / canvasWidthPx,
  };
}

function syncWorkerPageMetricsToCanvasPipeline(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  workerContext: any
): void {
  // html2pdf 内部的 pageSize 信息会影响后续切页逻辑，
  // 在这里把它同步为与 canvas 一致的像素尺寸。
  const pageSize = workerContext?.prop?.pageSize;
  const innerWidth = Number(pageSize?.inner?.width);
  const innerHeight = Number(pageSize?.inner?.height);
  const unitScale = Number(pageSize?.k);

  if (!Number.isFinite(innerWidth) || !Number.isFinite(innerHeight) || !Number.isFinite(unitScale)) {
    return;
  }

  const exactCssWidth = innerWidth * unitScale / 72 * 96;
  const metrics = computeCanvasAlignedPageMetricsFromExactCssWidth(
    exactCssWidth,
    innerHeight / innerWidth,
    resolveHtml2CanvasScale(workerContext)
  );

  pageSize.inner.px = pageSize.inner.px || {};
  pageSize.inner.px.width = metrics.renderWidthPx;
  pageSize.inner.px.height = metrics.pageHeightPx;
  pageSize.inner.ratio = metrics.ratio;
}

function getPdfRenderRootFromWorkerContext(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  workerContext: any,
  renderRootAttribute: string
): HTMLElement | null {
  const source = workerContext?.prop?.src;
  if (!(source instanceof Element)) {
    return null;
  }

  return source.closest<HTMLElement>(`[${renderRootAttribute}="true"]`);
}

function applyDetachedOverlayStyles(overlay: HTMLElement): void {
  overlay.style.position = 'absolute';
  overlay.style.left = '0';
  overlay.style.top = '0';
  overlay.style.right = 'auto';
  overlay.style.bottom = 'auto';
  overlay.style.width = '100%';
  overlay.style.height = 'auto';
  overlay.style.minHeight = '100%';
  overlay.style.opacity = '0';
  overlay.style.pointerEvents = 'none';
  overlay.style.overflow = 'hidden';
  overlay.style.zIndex = '-1';
}

function attachWorkerCleanup(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  workerResult: any,
  cleanup: () => void
): void {
  let cleanedUp = false;
  const runCleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    cleanup();
  };

  if (workerResult && typeof workerResult.thenExternal === 'function') {
    workerResult.thenExternal(runCleanup, runCleanup);
    return;
  }

  if (workerResult && typeof workerResult.finally === 'function') {
    workerResult.finally(runCleanup);
    return;
  }

  runCleanup();
}

function patchHtml2PdfOverlayBehavior(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  html2pdf: any,
  renderRootAttribute: string
): void {
  // html2pdf 默认会把 overlay 直接挂到 body。
  // 扩展场景下这么做容易影响当前页面滚动、布局和清理时机，
  // 因此统一重定向到离屏渲染根节点，并修补清理逻辑。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workerPrototype = html2pdf?.Worker?.prototype as Record<string, any> | undefined;
  if (!workerPrototype || workerPrototype.__mowenDetachedOverlayPatched) {
    return;
  }

  const originalSetPageSize = workerPrototype.setPageSize;
  const originalToContainer = workerPrototype.toContainer;
  const originalToCanvas = workerPrototype.toCanvas;

  if (typeof originalSetPageSize === 'function') {
    workerPrototype.setPageSize = function patchedSetPageSize(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this: any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...args: any[]
    ) {
      return originalSetPageSize.apply(this, args).then(function afterSetPageSize(this: any) {
        syncWorkerPageMetricsToCanvasPipeline(this);
      });
    };
  }

  if (typeof originalToContainer === 'function') {
    workerPrototype.toContainer = function patchedToContainer(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this: any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...args: any[]
    ) {
      const body = document.body;
      const originalAppendChild = body.appendChild;

      body.appendChild = (<T extends Node>(node: T): T => {
        if (node instanceof HTMLElement && node.classList.contains('html2pdf__overlay')) {
          const renderRoot = getPdfRenderRootFromWorkerContext(this, renderRootAttribute);
          if (renderRoot) {
            applyDetachedOverlayStyles(node);
            return renderRoot.appendChild(node) as T;
          }
        }

        return originalAppendChild.call(body, node) as T;
      }) as typeof body.appendChild;

      try {
        return originalToContainer.apply(this, args);
      } finally {
        body.appendChild = originalAppendChild;
      }
    };
  }

  if (typeof originalToCanvas === 'function') {
    workerPrototype.toCanvas = function patchedToCanvas(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this: any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...args: any[]
    ) {
      const body = document.body;
      const originalContains = body.contains;
      const originalRemoveChild = body.removeChild;

      body.contains = ((node: Node | null): boolean => {
        if (node) {
          const overlayParent = this?.prop?.overlay?.parentNode;
          if (overlayParent instanceof Element && overlayParent.contains(node)) {
            return true;
          }
        }

        return originalContains.call(body, node);
      }) as typeof body.contains;

      body.removeChild = (<T extends Node>(child: T): T => {
        if (child === this?.prop?.overlay && child.parentNode && child.parentNode !== body) {
          child.parentNode.removeChild(child);
          return child;
        }

        return originalRemoveChild.call(body, child) as T;
      }) as typeof body.removeChild;

      const restoreBodyMethods = () => {
        body.contains = originalContains;
        body.removeChild = originalRemoveChild;
      };

      try {
        const workerResult = originalToCanvas.apply(this, args);
        attachWorkerCleanup(workerResult, restoreBodyMethods);
        return workerResult;
      } catch (error) {
        restoreBodyMethods();
        throw error;
      }
    };
  }

  workerPrototype.__mowenDetachedOverlayPatched = true;
}

export async function getPatchedHtml2Pdf(renderRootAttribute: string) {
  if (!html2pdfModule) {
    // 只在真正进入导出链路时加载，避免普通浏览路径提前承担解析成本。
    const module = await import('html2pdf.js');
    html2pdfModule = module.default || module;
  }

  if (!html2pdfOverlayPatched) {
    patchHtml2PdfOverlayBehavior(html2pdfModule, renderRootAttribute);
    html2pdfOverlayPatched = true;
  }

  return html2pdfModule;
}
