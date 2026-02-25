/**
 * 转写器接口定义
 * 抽象 ASR 服务，支持 Mock 和真实实现切换
 */

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';

/** 转写器事件回调 */
export interface TranscriberCallbacks {
    /** 临时吐字更新 */
    onPartial: (text: string) => void;
    /** 确认文本追加 */
    onFinal: (text: string) => void;
    /** 修订事件 */
    onRevise: (blockIndex: number, newText: string) => void;
    /** 错误回调 */
    onError?: (error: Error) => void;
    /** 连接状态变更 */
    onStatusChange?: (status: ConnectionStatus) => void;
}

/** 转写器接口 */
export interface ITranscriber {
    /** 预连接：仅建立 WebSocket 连接，不启动 ASR 会话（可选） */
    preconnect?(): Promise<void>;
    /** 开始转写 */
    start(): Promise<void>;
    /** 停止转写 */
    stop(): void;
    /** 暂停转写 */
    pause(): void;
    /** 恢复转写 */
    resume(): void;
    /** 设置事件回调 */
    setCallbacks(callbacks: TranscriberCallbacks): void;
    /** 释放资源 */
    dispose(): void;
    /** 发送音频数据块（可选，用于真实 ASR 实现） */
    sendAudioChunk?(data: Blob | ArrayBuffer): void;
}
