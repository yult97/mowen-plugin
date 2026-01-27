/**
 * 高亮管理器
 * 
 * 负责：
 * 1. 监听文本选择事件
 * 2. 管理划线高亮的渲染
 * 3. 与 Background 通信进行保存
 */

import { Highlight, HighlightNoteCache, SaveHighlightPayload, HighlightSaveResult } from '../../types';
import { SelectionToolbar, SelectionToolbarCallbacks } from './SelectionToolbar';
import { SelectionInfo } from './types';

// 生成 UUID
function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// 获取选中内容的 HTML
function getSelectionHtml(range: Range): string {
  const container = document.createElement('div');
  container.appendChild(range.cloneContents());
  return container.innerHTML;
}

export class HighlightManager {
  private toolbar: SelectionToolbar;
  private isEnabled: boolean = true;
  private isApiKeyConfigured: boolean = false;
  private styleElement: HTMLStyleElement | null = null;
  // 内存锁：防止并发创建多个笔记
  // Key: pageKey, Value: Promise<{noteId, noteUrl} | null>
  private pendingNoteCreation: Map<string, Promise<{ noteId: string; noteUrl: string } | null>> = new Map();

  constructor() {
    // 创建工具栏回调
    const callbacks: SelectionToolbarCallbacks = {
      onSave: (selectionInfo) => this.handleSave(selectionInfo),
      onClose: () => this.clearSelection(),
      onConfigureKey: () => this.openOptionsPage(),
    };

    this.toolbar = new SelectionToolbar(callbacks);

    // 初始化
    this.injectStyles();
    this.bindEvents();
    this.checkApiKey();
  }

  /**
   * 启用/禁用划线功能
   */
  setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
    if (!enabled) {
      this.toolbar.hide();
    }
  }

  /**
   * 销毁管理器
   */
  destroy(): void {
    this.toolbar.destroy();
    this.removeStyles();
    this.unbindEvents();
  }

  /**
   * 注入样式
   */
  private injectStyles(): void {
    if (this.styleElement) return;

    this.styleElement = document.createElement('style');
    this.styleElement.id = 'mowen-highlighter-styles';
    this.styleElement.textContent = this.getStyles();
    document.head.appendChild(this.styleElement);
  }

  /**
   * 移除样式
   */
  private removeStyles(): void {
    if (this.styleElement) {
      this.styleElement.remove();
      this.styleElement = null;
    }
  }

  /**
   * 获取内联样式（从 styles.css 提取关键样式）
   */
  private getStyles(): string {
    return `
      /* ====== 工具栏容器 ====== */
      .mowen-selection-toolbar {
        position: fixed !important;
        z-index: 2147483647 !important;
        display: none;
        align-items: center !important;
        gap: 6px !important;
        height: 40px !important;
        padding: 0 6px !important;
        margin: 0 !important;
        background: #FFFFFF !important;
        backdrop-filter: blur(12px) !important;
        -webkit-backdrop-filter: blur(12px) !important;
        border: 1px solid rgba(0, 0, 0, 0.08) !important;
        border-radius: 20px !important;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1) !important;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif !important;
        font-size: 13px !important;
        font-weight: normal !important;
        line-height: 1 !important;
        text-align: left !important;
        color: #1F2937 !important;
        transform: translateY(-8px);
        opacity: 0;
        animation: mowen-toolbar-fadein 0.2s ease-out forwards;
        user-select: none !important;
        box-sizing: border-box !important;
        pointer-events: auto !important;
      }
      @keyframes mowen-toolbar-fadein {
        from { opacity: 0; transform: translateY(-4px); }
        to { opacity: 1; transform: translateY(-8px); }
      }
      .mowen-toolbar-fadeout {
        animation: mowen-toolbar-fadeout 0.15s ease-in forwards !important;
      }
      @keyframes mowen-toolbar-fadeout {
        from { opacity: 1; transform: translateY(-8px); }
        to { opacity: 0; transform: translateY(-4px); }
      }

      /* ====== 主按钮（胶囊按钮）====== */
      .mowen-toolbar-save-btn {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 6px !important;
        height: 32px !important;
        min-width: 110px !important;
        padding: 0 12px !important;
        margin: 0 !important;
        background: #BF4045 !important;
        color: #FFFFFF !important;
        border: none !important;
        border-radius: 16px !important;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
        font-size: 13px !important;
        font-weight: 500 !important;
        line-height: 1 !important;
        text-decoration: none !important;
        cursor: pointer !important;
        transition: all 0.15s ease !important;
        white-space: nowrap !important;
        box-sizing: border-box !important;
        outline: none !important;
      }
      .mowen-toolbar-save-btn:hover:not(:disabled) { 
        background: #A8383D !important;
        transform: translateY(-1px) !important;
        box-shadow: 0 4px 12px rgba(191, 64, 69, 0.3) !important;
      }
      .mowen-toolbar-save-btn:active:not(:disabled) { 
        background: #8F2F33 !important;
        transform: translateY(0) !important;
      }
      .mowen-toolbar-save-btn:disabled { 
        opacity: 0.85 !important;
        cursor: not-allowed !important;
      }

      /* 按钮内部图标 */
      .mowen-btn-icon {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 16px !important;
        height: 16px !important;
        flex-shrink: 0 !important;
      }
      .mowen-btn-icon svg {
        width: 16px !important;
        height: 16px !important;
        display: block !important;
      }

      /* 按钮内部文本 */
      .mowen-btn-text {
        display: inline-block !important;
        line-height: 1 !important;
      }

      /* ====== 状态样式 ====== */
      /* Saving 状态：保持主色红底 + spinner */
      .mowen-toolbar-save-btn.mowen-btn-saving {
        background: #BF4045 !important;
      }

      /* Loading Spinner */
      .mowen-btn-spinner {
        display: inline-block !important;
        width: 14px !important;
        height: 14px !important;
        border: 2px solid rgba(255, 255, 255, 0.3) !important;
        border-top-color: #FFFFFF !important;
        border-radius: 50% !important;
        animation: mowen-spin 0.7s linear infinite !important;
        flex-shrink: 0 !important;
      }
      @keyframes mowen-spin { 
        to { transform: rotate(360deg); } 
      }

      /* Success 状态：保持主色红底 */
      .mowen-toolbar-save-btn.mowen-btn-success {
        background: #BF4045 !important;
      }

      /* Error 状态：稍浅的红色底 + 白色文字 */
      .mowen-toolbar-save-btn.mowen-btn-error {
        background: #DC6B6F !important;
      }
      .mowen-toolbar-save-btn.mowen-btn-error:hover:not(:disabled) {
        background: #BF4045 !important;
      }

      /* 未配置状态 */
      .mowen-toolbar-save-btn.mowen-btn-unconfigured {
        background: #6B7280 !important;
      }
      .mowen-toolbar-save-btn.mowen-btn-unconfigured:hover {
        background: #4B5563 !important;
      }

      /* ====== 关闭按钮 ====== */
      .mowen-toolbar-close-btn {
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 26px !important;
        height: 26px !important;
        padding: 0 !important;
        margin: 0 !important;
        background: transparent !important;
        border: none !important;
        border-radius: 13px !important;
        color: #9CA3AF !important;
        cursor: pointer !important;
        transition: all 0.15s ease !important;
        box-sizing: border-box !important;
        outline: none !important;
        flex-shrink: 0 !important;
      }
      .mowen-toolbar-close-btn:hover { 
        background: rgba(0, 0, 0, 0.06) !important; 
        color: #6B7280 !important;
      }
      .mowen-toolbar-close-btn svg {
        width: 12px !important;
        height: 12px !important;
      }

      /* ====== 高亮样式 ====== */
      .mowen-highlight {
        background-color: rgba(191, 64, 69, 0.2) !important;
        border-radius: 2px !important;
        padding: 0 2px !important;
        margin: 0 -2px !important;
      }

      /* ====== Toast 提示（右上角显示）====== */
      .mowen-toast {
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 14px 20px;
        background: #FFFFFF;
        border: 1px solid rgba(0, 0, 0, 0.06);
        border-radius: 16px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        font-weight: 500;
        color: #1F2937;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.06);
        animation: mowen-toast-in 0.3s ease-out forwards;
      }
      @keyframes mowen-toast-in {
        from { opacity: 0; transform: translateY(-10px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .mowen-toast-out {
        animation: mowen-toast-out 0.2s ease-in forwards;
      }
      @keyframes mowen-toast-out {
        from { opacity: 1; transform: translateY(0); }
        to { opacity: 0; transform: translateY(-10px); }
      }
      /* Toast 图标容器 */
      .mowen-toast-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        flex-shrink: 0;
      }
      .mowen-toast-icon svg {
        width: 24px;
        height: 24px;
      }
      /* Toast 消息文本 */
      .mowen-toast-message {
        flex: 1;
        color: #1F2937;
        white-space: nowrap;
      }
      /* Toast 操作按钮 */
      .mowen-toast-action {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 8px 14px;
        background: rgba(0, 0, 0, 0.04);
        border: none;
        border-radius: 20px;
        color: #6B7280;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        text-decoration: none;
        white-space: nowrap;
        transition: all 0.15s ease;
      }
      .mowen-toast-action:hover {
        background: rgba(0, 0, 0, 0.08);
        color: #374151;
      }
      /* 保存中状态的 spinner */
      .mowen-toast-spinner {
        display: inline-block;
        width: 20px;
        height: 20px;
        border: 2.5px solid rgba(191, 64, 69, 0.2);
        border-top-color: #BF4045;
        border-radius: 50%;
        animation: mowen-toast-spin 0.7s linear infinite;
      }
      @keyframes mowen-toast-spin {
        to { transform: rotate(360deg); }
      }
      /* 成功状态图标 */
      .mowen-toast.success .mowen-toast-icon {
        color: #BF4045;
      }
      /* 错误状态图标 */
      .mowen-toast.error .mowen-toast-icon {
        color: #EF4444;
      }
      /* 警告/重复状态图标 */
      .mowen-toast.warning .mowen-toast-icon {
        color: #F59E0B;
      }
      /* 加载状态 */
      .mowen-toast.loading .mowen-toast-icon {
        color: #BF4045;
      }
    `;
  }

  /**
   * 绑定事件
   */
  private bindEvents(): void {
    document.addEventListener('mouseup', this.handleMouseUp);
    document.addEventListener('mousedown', this.handleMouseDown);
    document.addEventListener('keydown', this.handleKeyDown);
  }

  /**
   * 解绑事件
   */
  private unbindEvents(): void {
    document.removeEventListener('mouseup', this.handleMouseUp);
    document.removeEventListener('mousedown', this.handleMouseDown);
    document.removeEventListener('keydown', this.handleKeyDown);
  }

  /**
   * 处理鼠标抬起事件
   */
  private handleMouseUp = (event: MouseEvent): void => {
    if (!this.isEnabled) return;

    // 延迟执行，确保选区已更新（双击选中需要更长时间）
    setTimeout(() => {
      const selection = window.getSelection();

      // 如果没有选区或选区为空，隐藏工具栏（用户单击了空白处）
      if (!selection || selection.isCollapsed) {
        if (this.toolbar.isVisible()) {
          this.toolbar.hide();
        }
        return;
      }

      const text = selection.toString().trim();
      if (!text || text.length < 2) {
        return;
      }

      // 检查是否点击在工具栏上
      const target = event.target as HTMLElement;
      if (target.closest('.mowen-selection-toolbar')) {
        return;
      }

      // 获取选区信息
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      const selectionInfo: SelectionInfo = {
        text,
        html: getSelectionHtml(range),
        rect,
        range: range.cloneRange(),
      };

      // 显示工具栏
      this.toolbar.show(selectionInfo);
    }, 50);  // 增加延迟，确保双击选中后选区正确更新
  };


  /**
   * 处理鼠标按下事件
   * 注意：这里不立即隐藏工具栏，而是在 selectionchange 或真正需要时隐藏
   * 这样用户可以双击选中后拖拽扩展选区
   */
  private handleMouseDown = (event: MouseEvent): void => {
    // 如果点击在工具栏上，不做任何处理
    const target = event.target as HTMLElement;
    if (target.closest('.mowen-selection-toolbar')) {
      return;
    }

    // 如果工具栏可见，但用户开始新的选择操作（可能是拖拽扩展选区），
    // 不立即隐藏工具栏，而是在 mouseup 时根据选区情况决定
    // 这样可以支持"双击选中后拖拽扩展选区"的场景
  };

  /**
   * 处理键盘事件
   */
  private handleKeyDown = (event: KeyboardEvent): void => {
    // ESC 键隐藏工具栏
    if (event.key === 'Escape' && this.toolbar.isVisible()) {
      this.toolbar.hide();
      this.clearSelection();
    }
  };

  /**
   * 清除选区
   */
  private clearSelection(): void {
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
    }
  }

  /**
   * 检查 API Key 配置状态
   */
  private async checkApiKey(): Promise<void> {
    try {
      // API Key 存储在 'mowen_settings' 对象中，而不是单独的 'apiKey' key
      const result = await chrome.storage.sync.get('mowen_settings');
      const settings = result.mowen_settings as { apiKey?: string } | undefined;
      this.isApiKeyConfigured = !!settings?.apiKey;
      this.toolbar.setApiKeyConfigured(this.isApiKeyConfigured);
      console.log('[Highlighter] API Key configured:', this.isApiKeyConfigured);
    } catch (error) {
      console.error('[Highlighter] Failed to check API key:', error);
      // 如果读取失败，默认认为已配置，避免阻塞用户
      this.isApiKeyConfigured = true;
      this.toolbar.setApiKeyConfigured(true);
    }
  }

  /**
   * 打开设置页
   */
  private openOptionsPage(): void {
    chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS_PAGE' });
  }

  /**
   * 处理保存操作
   */
  private async handleSave(selectionInfo: SelectionInfo): Promise<{ success: boolean; noteUrl?: string; isAppend?: boolean; error?: string }> {
    console.log('[Highlighter] 🎯 handleSave called with:', selectionInfo.text.substring(0, 30));
    const pageUrl = window.location.href;
    const pageTitle = document.title;
    const pageKey = this.getPageKey(pageUrl);
    const cacheKey = `highlight_note_${pageKey}`;
    console.log('[Highlighter] 🔑 pageKey:', pageKey, 'cacheKey:', cacheKey);

    // 创建划线数据
    const highlight: Highlight = {
      id: generateId(),
      text: selectionInfo.text,
      html: selectionInfo.html,
      sourceUrl: pageUrl,
      pageTitle: pageTitle,
      createdAt: new Date().toISOString(),
    };

    // 检查是否有正在进行的笔记创建请求（防止并发竞态）
    const pendingPromise = this.pendingNoteCreation.get(pageKey);
    if (pendingPromise) {
      console.log('[Highlighter] ⏳ Waiting for pending note creation to complete...');
      await pendingPromise;
      console.log('[Highlighter] ✅ Pending note creation completed, continuing...');
    }

    // 检查是否已有该页面的笔记
    let existingNoteId: string | undefined;
    let existingCache: HighlightNoteCache | undefined;

    try {
      const cached = await chrome.storage.local.get([cacheKey]);
      existingCache = cached[cacheKey] as HighlightNoteCache | undefined;
      if (existingCache?.noteId) {
        // 缓存过期检查（24小时）
        const isExpired = existingCache.expiresAt && new Date(existingCache.expiresAt) < new Date();
        if (isExpired) {
          console.log('[Highlighter] ⚠️ Cache expired, will create new note');
          existingCache = undefined;
        } else {
          existingNoteId = existingCache.noteId;
          console.log('[Highlighter] ✅ Found existing noteId:', existingNoteId);
        }
      } else {
        console.log('[Highlighter] ℹ️ No existing noteId, will create new note. cacheKey:', cacheKey);
      }
    } catch (error) {
      console.error('[Highlighter] Failed to get cache:', error);
    }

    // 发送保存请求到 Background
    console.log('[Highlighter] 🔧 Building payload...');
    const payload: SaveHighlightPayload = {
      highlight,
      isPublic: false,
      enableAutoTag: true,
      existingNoteId,
      existingBody: existingCache?.body,  // 传递本地缓存的 body
    };
    console.log('[Highlighter] 🔧 Payload built, existingNoteId:', existingNoteId, 'hasBody:', !!existingCache?.body);

    // 如果没有 existingNoteId，说明要创建新笔记，需要设置锁
    // 使用辅助函数封装释放逻辑，避免 TypeScript 类型推断问题
    let releaseLock: ((result: { noteId: string; noteUrl: string } | null) => void) | undefined;

    if (!existingNoteId) {
      const creationPromise = new Promise<{ noteId: string; noteUrl: string } | null>((resolve) => {
        releaseLock = (result) => {
          resolve(result);
          this.pendingNoteCreation.delete(pageKey);
          if (result) {
            console.log('[Highlighter] 🔓 Lock released, noteId:', result.noteId);
          } else {
            console.log('[Highlighter] 🔓 Lock released (failed)');
          }
        };
      });
      this.pendingNoteCreation.set(pageKey, creationPromise);
      console.log('[Highlighter] 🔒 Lock acquired for new note creation');
    }

    try {
      // 显示保存中 Toast
      this.showToast('保存中...', 'loading');

      console.log('[Highlighter] 📤 Sending SAVE_HIGHLIGHT to background...', { existingNoteId, highlightText: highlight.text.substring(0, 50) });
      const response = await chrome.runtime.sendMessage({
        type: 'SAVE_HIGHLIGHT',
        payload,
      }) as HighlightSaveResult | undefined;
      console.log('[Highlighter] 📥 Received response from background:', response);

      // 防御性检查：如果 response 为 undefined，说明消息通道断开或 Background 异常
      if (!response) {
        console.error('[Highlighter] Save failed: No response from background');
        this.showToast('保存失败：后台服务无响应', 'error');
        // 释放锁
        releaseLock?.(null);
        return {
          success: false,
          error: '后台服务无响应',
        };
      }

      if (response.success) {
        // 空值检查：确保返回的 noteId 和 noteUrl 存在
        if (!response.noteId || !response.noteUrl) {
          console.error('[Highlighter] ❌ Missing noteId or noteUrl in success response');
          this.showToast('服务返回数据异常', 'error');
          return {
            success: false,
            error: '服务返回数据异常',
          };
        }

        // 更新缓存（使用已获取的 existingCache 避免重复读取）
        const newCache: HighlightNoteCache = {
          noteId: response.noteId,
          noteUrl: response.noteUrl,
          pageUrl,
          pageTitle,
          createdAt: existingCache?.createdAt || new Date().toISOString(),
          lastUpdatedAt: new Date().toISOString(),
          highlightCount: (existingCache?.highlightCount || 0) + 1,
          // 缓存更新后的 body（用于下次追加）
          body: response.updatedBody || existingCache?.body,
          // 设置缓存过期时间（24小时后）
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        };
        await chrome.storage.local.set({ [cacheKey]: newCache });

        // 释放锁并传递结果
        releaseLock?.({ noteId: response.noteId, noteUrl: response.noteUrl });

        // 显示 Toast（已保存/追加成功）
        this.showToast(
          response.isAppend ? '保存成功' : '保存成功',
          'success',
          response.noteUrl
        );

        return {
          success: true,
          noteUrl: response.noteUrl,
          isAppend: response.isAppend,
        };
      } else {
        // 失败时：如果是笔记不存在(404)，清除缓存
        if (response.errorCode === 'NOTE_NOT_FOUND') {
          await chrome.storage.local.remove(cacheKey);
          console.log('[Highlighter] 🗑️ Cache cleared due to note not found');
        }
        this.showToast(response.error || '保存失败', 'error');
        return {
          success: false,
          error: response.error,
        };
      }
    } catch (error) {
      console.error('[Highlighter] Save failed:', error);
      const errorMsg = error instanceof Error ? error.message : '保存失败';
      this.showToast(errorMsg, 'error');
      return {
        success: false,
        error: errorMsg,
      };
    } finally {
      // 确保锁一定会被释放
      if (releaseLock && this.pendingNoteCreation.has(pageKey)) {
        releaseLock(null);
      }
    }
  }

  /**
   * 获取页面缓存 Key（去除 hash 和部分 query）
   */
  private getPageKey(url: string): string {
    try {
      const urlObj = new URL(url);
      return `${urlObj.origin}${urlObj.pathname}`;
    } catch {
      return url;
    }
  }

  /**
   * 显示 Toast 提示
   * @param message 消息内容
   * @param type 类型：success | error | warning | loading
   * @param linkUrl 可选的链接 URL（用于"去 YouMind 查看"按钮）
   */
  private showToast(message: string, type: 'success' | 'error' | 'warning' | 'loading' = 'success', linkUrl?: string): void {
    // 移除已有的 toast
    const existingToast = document.querySelector('.mowen-toast');
    if (existingToast) {
      existingToast.remove();
    }

    const toast = document.createElement('div');
    toast.className = `mowen-toast ${type}`;

    // 根据类型选择图标
    const iconHtml = this.getToastIcon(type);

    let html = `
      <span class="mowen-toast-icon">${iconHtml}</span>
      <span class="mowen-toast-message">${message}</span>
    `;

    // 如果有链接，添加操作按钮
    if (linkUrl) {
      html += `<a href="${linkUrl}" target="_blank" class="mowen-toast-action">去墨问笔记查看</a>`;
    }

    toast.innerHTML = html;
    document.body.appendChild(toast);

    // loading 状态不自动消失；其他状态 3 秒后自动消失
    if (type !== 'loading') {
      setTimeout(() => {
        toast.classList.add('mowen-toast-out');
        setTimeout(() => toast.remove(), 200);
      }, 3000);
    }
  }

  /**
   * 获取 Toast 图标（SVG）
   */
  private getToastIcon(type: 'success' | 'error' | 'warning' | 'loading'): string {
    switch (type) {
      case 'loading':
        return `<span class="mowen-toast-spinner"></span>`;
      case 'success':
        // 保存成功图标（带星星的盒子）
        return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M5 7H19V19C19 20.1046 18.1046 21 17 21H7C5.89543 21 5 20.1046 5 19V7Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
                    <path d="M8 7V5C8 3.89543 8.89543 3 10 3H14C15.1046 3 16 3.89543 16 5V7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
                    <path d="M12 10L12.9 12.2L15 12.5L13.5 14L13.8 16.5L12 15.4L10.2 16.5L10.5 14L9 12.5L11.1 12.2L12 10Z" fill="currentColor"/>
                </svg>`;
      case 'warning':
        // 重复/警告图标（带星星的盒子 + 橙色）
        return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M5 7H19V19C19 20.1046 18.1046 21 17 21H7C5.89543 21 5 20.1046 5 19V7Z" stroke="#F59E0B" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
                    <path d="M8 7V5C8 3.89543 8.89543 3 10 3H14C15.1046 3 16 3.89543 16 5V7" stroke="#F59E0B" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
                    <path d="M12 10L12.9 12.2L15 12.5L13.5 14L13.8 16.5L12 15.4L10.2 16.5L10.5 14L9 12.5L11.1 12.2L12 10Z" fill="#F59E0B"/>
                </svg>`;
      case 'error':
        // 错误图标（X）
        return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8" fill="none"/>
                    <path d="M15 9L9 15M9 9L15 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                </svg>`;
      default:
        return '';
    }
  }
}
