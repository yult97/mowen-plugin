/**
 * ASR 配置管理
 * 支持灰度开关和远程配置
 */

export type AsrProvider = 'volcengine' | 'tencent';

export interface AsrConfig {
    /** ASR 提供商 */
    provider: AsrProvider;
    /** 中转服务 WebSocket 地址 */
    wsUrl: string;
    /** 音频分包时长（毫秒） */
    audioChunkMs: number;
    /** 最大重连次数 */
    maxReconnect: number;
}

/** 默认配置 */
const DEFAULT_CONFIG: AsrConfig = {
    provider: 'volcengine',
    wsUrl: 'ws://localhost:8765',
    audioChunkMs: 160,
    maxReconnect: 3,
};

/** 本地存储 Key */
const ASR_CONFIG_KEY = 'mowen_asr_config';

/**
 * 获取 ASR 配置
 *
 * 优先级：
 * 1. provider 始终使用默认配置（防止旧缓存导致问题）
 * 2. 其他设置从 localStorage 缓存读取
 */
export function getAsrConfig(): AsrConfig {
    try {
        const cached = localStorage.getItem(ASR_CONFIG_KEY);
        if (cached) {
            const parsed = JSON.parse(cached);
            // provider 始终使用默认配置，防止旧缓存导致问题
            return {
                ...DEFAULT_CONFIG,
                ...parsed,
                provider: DEFAULT_CONFIG.provider  // 强制使用默认 provider
            };
        }
    } catch (e) {
        console.warn('[asrConfig] 读取配置失败:', e);
    }

    return DEFAULT_CONFIG;
}

/**
 * 更新 ASR 配置
 * 用于远程配置下发或开发时手动切换
 */
export function setAsrConfig(config: Partial<AsrConfig>): void {
    try {
        const current = getAsrConfig();
        const updated = { ...current, ...config };
        localStorage.setItem(ASR_CONFIG_KEY, JSON.stringify(updated));
        console.log('[asrConfig] 配置已更新:', updated);
    } catch (e) {
        console.error('[asrConfig] 保存配置失败:', e);
    }
}

/**
 * 重置为默认配置
 */
export function resetAsrConfig(): void {
    try {
        localStorage.removeItem(ASR_CONFIG_KEY);
        console.log('[asrConfig] 配置已重置');
    } catch (e) {
        console.error('[asrConfig] 重置配置失败:', e);
    }
}

/**
 * 切换到 Volcengine 模式（开发/调试用）
 */
export function enableVolcengine(wsUrl?: string): void {
    setAsrConfig({
        provider: 'volcengine',
        wsUrl: wsUrl ?? DEFAULT_CONFIG.wsUrl,
    });
}

/**
 * 切换到腾讯云模式（开发/调试用）
 */
export function enableTencent(wsUrl?: string): void {
    setAsrConfig({
        provider: 'tencent',
        wsUrl: wsUrl ?? DEFAULT_CONFIG.wsUrl,
    });
}
