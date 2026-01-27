/**
 * 划线功能模块入口
 * 
 * 导出初始化和销毁方法，供 content/index.ts 调用
 */

import { HighlightManager } from './HighlightManager';

let highlightManager: HighlightManager | null = null;

/**
 * 初始化划线功能
 */
export function initHighlighter(): void {
    if (highlightManager) {
        console.log('[Highlighter] Already initialized');
        return;
    }

    console.log('[Highlighter] Initializing...');
    highlightManager = new HighlightManager();
    console.log('[Highlighter] Initialized successfully');
}

/**
 * 销毁划线功能
 */
export function destroyHighlighter(): void {
    if (highlightManager) {
        console.log('[Highlighter] Destroying...');
        highlightManager.destroy();
        highlightManager = null;
        console.log('[Highlighter] Destroyed');
    }
}

/**
 * 设置划线功能启用状态
 */
export function setHighlighterEnabled(enabled: boolean): void {
    if (highlightManager) {
        highlightManager.setEnabled(enabled);
    }
}

/**
 * 检查划线功能是否已初始化
 */
export function isHighlighterInitialized(): boolean {
    return highlightManager !== null;
}

// 导出类型
export * from './types';
