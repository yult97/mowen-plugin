/**
 * 划线功能类型定义
 */

/**
 * 工具栏位置
 */
export interface ToolbarPosition {
    top: number;
    left: number;
}

/**
 * 选区信息
 */
export interface SelectionInfo {
    text: string;
    html: string;
    rect: DOMRect;
    range: Range;
}

/**
 * 工具栏配置选项
 */
export interface ToolbarOptions {
    // 是否自动隐藏（点击外部区域）
    autoHide: boolean;
    // 工具栏动画持续时间
    animationDuration: number;
}

/**
 * 高亮颜色（使用品牌色系）
 */
export const HIGHLIGHT_COLOR = 'rgba(191, 64, 69, 0.25)'; // 品牌红 25% 透明度
