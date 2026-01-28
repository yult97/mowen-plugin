/**
 * 浮动工具栏组件
 * 
 * 用户选中文本后，在选区上方显示浮动工具栏，
 * 提供"保存到墨问"按钮。
 * 
 * 工作1：按钮与图标统一为胶囊按钮（图标作为按钮前缀）
 * 工作2：完善状态反馈（idle/saving/success/error）
 */

import { ToolbarPosition, SelectionInfo } from './types';

// 品牌 Logo SVG（白色 M 图标，用于按钮内部）
const MOWEN_ICON_WHITE = `
<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M4 18V6L12 14L20 6V18" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;

// 勾选图标（用于成功状态）
const CHECK_ICON_SVG = `
<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M20 6L9 17L4 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;

// 关闭图标
const CLOSE_ICON_SVG = `
<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;

// Loading Spinner（CSS 动画实现）
const LOADING_SPINNER = `
<span class="mowen-btn-spinner"></span>
`;

export type ToolbarState = 'idle' | 'saving' | 'success' | 'error';

export interface SelectionToolbarCallbacks {
    onSave: (selectionInfo: SelectionInfo) => Promise<{ success: boolean; noteUrl?: string; isAppend?: boolean; error?: string }>;
    onClose: () => void;
    onConfigureKey: () => void;
    onDisable: (type: 'domain' | 'global') => void;
    onOpenSettings: () => void;
}

export class SelectionToolbar {
    private container: HTMLDivElement | null = null;
    private currentSelection: SelectionInfo | null = null;
    private state: ToolbarState = 'idle';
    private callbacks: SelectionToolbarCallbacks;
    private isApiKeyConfigured: boolean = false;
    private hideTimeout: ReturnType<typeof setTimeout> | null = null;
    private resetTimeout: ReturnType<typeof setTimeout> | null = null;
    private disableMenu: HTMLDivElement | null = null;

    constructor(callbacks: SelectionToolbarCallbacks) {
        this.callbacks = callbacks;
    }

    /**
     * 设置 API Key 配置状态
     */
    setApiKeyConfigured(configured: boolean): void {
        this.isApiKeyConfigured = configured;
    }

    /**
     * 显示工具栏
     */
    show(selectionInfo: SelectionInfo): void {
        this.currentSelection = selectionInfo;
        this.state = 'idle';

        // 清除之前的定时器
        if (this.resetTimeout) {
            clearTimeout(this.resetTimeout);
            this.resetTimeout = null;
        }

        // 计算位置
        const position = this.calculatePosition(selectionInfo.rect);

        // 创建或更新工具栏
        if (!this.container) {
            this.createToolbar();
        }

        this.updateToolbar();
        this.setPosition(position);

        if (this.container) {
            this.container.style.display = 'flex';
            this.container.classList.remove('mowen-toolbar-fadeout');
        }
    }

    /**
     * 隐藏工具栏
     */
    hide(): void {
        if (this.container) {
            this.container.classList.add('mowen-toolbar-fadeout');
            this.hideTimeout = setTimeout(() => {
                if (this.container) {
                    this.container.style.display = 'none';
                }
            }, 150);
        }
        this.currentSelection = null;
        this.state = 'idle';
    }

    /**
     * 销毁工具栏
     */
    destroy(): void {
        if (this.hideTimeout) {
            clearTimeout(this.hideTimeout);
        }
        if (this.resetTimeout) {
            clearTimeout(this.resetTimeout);
        }
        this.hideDisableMenu();
        if (this.container) {
            this.container.remove();
            this.container = null;
        }
    }

    /**
     * 检查工具栏是否可见
     */
    isVisible(): boolean {
        return this.container?.style.display === 'flex';
    }

    /**
     * 计算工具栏位置
     */
    private calculatePosition(rect: DOMRect): ToolbarPosition {
        const toolbarWidth = 200; // 预估宽度
        const toolbarHeight = 48; // 预估高度
        const padding = 10;

        let left = rect.left + (rect.width - toolbarWidth) / 2;
        let top = rect.top - toolbarHeight - padding;

        // 边界检查
        if (left < padding) {
            left = padding;
        }
        if (left + toolbarWidth > window.innerWidth - padding) {
            left = window.innerWidth - toolbarWidth - padding;
        }
        if (top < padding) {
            // 如果上方空间不足，显示在下方
            top = rect.bottom + padding;
        }

        return { top, left };
    }

    /**
     * 创建工具栏 DOM
     */
    private createToolbar(): void {
        this.container = document.createElement('div');
        this.container.className = 'mowen-selection-toolbar';
        this.container.style.display = 'none';

        // 阻止工具栏点击冒泡，避免触发外部点击隐藏
        this.container.addEventListener('mousedown', (e) => {
            e.stopPropagation();
        });

        document.body.appendChild(this.container);
    }

    /**
     * 更新工具栏内容
     */
    private updateToolbar(): void {
        if (!this.container) return;

        if (!this.isApiKeyConfigured) {
            // 未配置 API Key 状态
            this.container.innerHTML = `
                <button class="mowen-toolbar-save-btn mowen-btn-unconfigured">
                    <span class="mowen-btn-icon">${MOWEN_ICON_WHITE}</span>
                    <span class="mowen-btn-text">请配置 API Key</span>
                </button>
                <button class="mowen-toolbar-close-btn">${CLOSE_ICON_SVG}</button>
            `;

            // 绑定配置按钮事件
            const configBtn = this.container.querySelector('.mowen-toolbar-save-btn');
            configBtn?.addEventListener('click', () => {
                this.callbacks.onConfigureKey();
                this.hide();
            });
        } else {
            // 正常状态 - 胶囊按钮（图标 + 文案）
            const buttonContent = this.getButtonContent();
            const buttonClass = this.getButtonClass();
            const isDisabled = this.state === 'saving';

            this.container.innerHTML = `
                <button class="mowen-toolbar-save-btn ${buttonClass}" ${isDisabled ? 'disabled' : ''}>
                    ${buttonContent}
                </button>
                <button class="mowen-toolbar-close-btn">${CLOSE_ICON_SVG}</button>
            `;

            // 绑定保存按钮事件
            const saveBtn = this.container.querySelector('.mowen-toolbar-save-btn');
            saveBtn?.addEventListener('click', () => this.handleSave());
        }

        // 绑定关闭按钮事件（单击弹出菜单）
        this.bindCloseButtonEvents();
    }

    /**
     * 绑定关闭按钮事件（单击弹出菜单）
     */
    private closeButtonHandler: ((e: Event) => void) | null = null;

    private bindCloseButtonEvents(): void {
        const closeBtn = this.container?.querySelector('.mowen-toolbar-close-btn');
        if (!closeBtn) return;

        // 移除旧的事件监听器（避免重复绑定）
        if (this.closeButtonHandler) {
            closeBtn.removeEventListener('click', this.closeButtonHandler);
        }

        // 创建并绑定新的事件监听器
        this.closeButtonHandler = (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
            this.showDisableMenu();
        };
        closeBtn.addEventListener('click', this.closeButtonHandler);
    }

    /**
     * 显示关闭选项菜单
     */
    private showDisableMenu(): void {
        // 如果已存在，先移除
        this.hideDisableMenu();

        const closeBtn = this.container?.querySelector('.mowen-toolbar-close-btn');
        if (!closeBtn) return;

        const rect = closeBtn.getBoundingClientRect();

        this.disableMenu = document.createElement('div');
        this.disableMenu.className = 'mowen-disable-menu';
        this.disableMenu.innerHTML = `
            <div class="mowen-disable-menu-item" data-action="session">隐藏直到下次访问</div>
            <div class="mowen-disable-menu-item" data-action="domain">在此网站禁用</div>
            <div class="mowen-disable-menu-item" data-action="global">全局禁用</div>
            <div class="mowen-disable-menu-footer">
                <span>您可以在此处重新启用</span>
                <a href="#" class="mowen-disable-menu-link">设置</a>
            </div>
        `;

        // 定位在关闭按钮下方，右边缘对齐
        this.disableMenu.style.position = 'fixed';
        this.disableMenu.style.top = `${rect.bottom + 6}px`;
        this.disableMenu.style.right = `${window.innerWidth - rect.right}px`; // 右对齐

        document.body.appendChild(this.disableMenu);

        // 绑定菜单项事件
        this.disableMenu.querySelectorAll('.mowen-disable-menu-item').forEach(item => {
            item.addEventListener('click', (e) => {
                const action = (e.target as HTMLElement).getAttribute('data-action') as 'session' | 'domain' | 'global';
                if (action === 'session') {
                    // 隐藏直到下次访问：直接关闭工具栏
                    this.callbacks.onClose();
                    this.hideDisableMenu();
                    this.hide();
                } else if (action) {
                    this.callbacks.onDisable(action);
                    this.hideDisableMenu();
                    this.hide();
                }
            });
        });

        // 绑定设置链接
        const settingsLink = this.disableMenu.querySelector('.mowen-disable-menu-link');
        settingsLink?.addEventListener('click', (e) => {
            e.preventDefault();
            this.callbacks.onOpenSettings();
            this.hideDisableMenu();
            this.hide();
        });

        // 点击外部关闭菜单
        setTimeout(() => {
            document.addEventListener('click', this.handleOutsideClick);
        }, 0);
    }

    /**
     * 隐藏禁用菜单
     */
    private hideDisableMenu(): void {
        if (this.disableMenu) {
            this.disableMenu.remove();
            this.disableMenu = null;
        }
        document.removeEventListener('click', this.handleOutsideClick);
    }

    /**
     * 处理菜单外部点击
     */
    private handleOutsideClick = (e: MouseEvent): void => {
        if (this.disableMenu && !this.disableMenu.contains(e.target as Node)) {
            this.hideDisableMenu();
        }
    };

    /**
     * 获取按钮内容（图标 + 文本）
     */
    private getButtonContent(): string {
        switch (this.state) {
            case 'saving':
                return `
                    ${LOADING_SPINNER}
                    <span class="mowen-btn-text">保存中…</span>
                `;
            case 'success':
                return `
                    <span class="mowen-btn-icon">${CHECK_ICON_SVG}</span>
                    <span class="mowen-btn-text">已保存</span>
                `;
            case 'error':
                return `
                    <span class="mowen-btn-icon">${MOWEN_ICON_WHITE}</span>
                    <span class="mowen-btn-text">保存失败，重试</span>
                `;
            default:
                return `
                    <span class="mowen-btn-icon">${MOWEN_ICON_WHITE}</span>
                    <span class="mowen-btn-text">保存到墨问</span>
                `;
        }
    }

    /**
     * 获取按钮样式类
     */
    private getButtonClass(): string {
        switch (this.state) {
            case 'saving':
                return 'mowen-btn-saving';
            case 'success':
                return 'mowen-btn-success';
            case 'error':
                return 'mowen-btn-error';
            default:
                return '';
        }
    }

    /**
     * 设置工具栏位置
     */
    private setPosition(position: ToolbarPosition): void {
        if (this.container) {
            this.container.style.top = `${position.top}px`;
            this.container.style.left = `${position.left}px`;
        }
    }

    /**
     * 处理保存操作
     */
    private async handleSave(): Promise<void> {
        console.log('[SelectionToolbar] handleSave called, current state:', this.state);

        // 防止并发：saving 状态下不响应点击
        if (!this.currentSelection || this.state === 'saving') {
            console.log('[SelectionToolbar] handleSave blocked - no selection or already saving');
            return;
        }

        console.log('[SelectionToolbar] Setting state to saving...');
        this.state = 'saving';
        this.updateToolbar();
        console.log('[SelectionToolbar] updateToolbar called, state is now:', this.state);

        // 最小显示时间（确保用户能看到"保存中"状态）
        const MIN_LOADING_TIME = 400; // ms
        const startTime = Date.now();

        try {
            console.log('[SelectionToolbar] Calling onSave callback...');
            const result = await this.callbacks.onSave(this.currentSelection);
            console.log('[SelectionToolbar] onSave callback returned:', result);

            // 等待剩余的最小显示时间
            const elapsed = Date.now() - startTime;
            if (elapsed < MIN_LOADING_TIME) {
                await new Promise(resolve => setTimeout(resolve, MIN_LOADING_TIME - elapsed));
            }

            if (result.success) {
                this.state = 'success';
                this.updateToolbar();

                // 1.5 秒后自动隐藏工具栏
                this.resetTimeout = setTimeout(() => {
                    this.hide();
                }, 1500);
            } else {
                this.state = 'error';
                this.updateToolbar();

                // error 状态下按钮可点击，允许重试
                // 5 秒后自动恢复 idle（如果用户没有操作）
                this.resetTimeout = setTimeout(() => {
                    if (this.state === 'error') {
                        this.state = 'idle';
                        this.updateToolbar();
                    }
                }, 5000);
            }
        } catch (error) {
            console.error('[Highlighter] Save error:', error);
            this.state = 'error';
            this.updateToolbar();

            // 5 秒后自动恢复 idle
            this.resetTimeout = setTimeout(() => {
                if (this.state === 'error') {
                    this.state = 'idle';
                    this.updateToolbar();
                }
            }, 5000);
        }
    }
}
