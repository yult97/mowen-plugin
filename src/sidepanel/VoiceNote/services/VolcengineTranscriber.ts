/**
 * 火山引擎 ASR Transcriber
 * 通过中转服务连接火山引擎流式语音识别
 */

import { ITranscriber, TranscriberCallbacks } from './ITranscriber';

/** 中转服务配置 */
export interface VolcengineTranscriberConfig {
    /** 中转服务 WebSocket 地址 */
    wsUrl: string;
    /** 音频分包时长（毫秒） */
    audioChunkMs?: number;
    /** 自动重连次数 */
    maxReconnect?: number;
}

/** 连接状态 */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

/** 连接状态变化回调 */
export type ConnectionStatusCallback = (status: ConnectionStatus) => void;

/**
 * 火山引擎 Transcriber 实现
 * 
 * 职责：
 * 1. 连接中转服务（ws://localhost:8765）
 * 2. 发送音频数据
 * 3. 接收识别结果并调用回调
 */
export class VolcengineTranscriber implements ITranscriber {
    private ws: WebSocket | null = null;
    private callbacks: TranscriberCallbacks | null = null;
    private config: Required<VolcengineTranscriberConfig>;
    private isRunning = false;
    private isPaused = false;
    private reconnectCount = 0;
    private sessionId = '';
    private pendingAudioChunks: ArrayBuffer[] = [];
    private readonly maxPendingAudioChunks = 100;
    constructor(config: VolcengineTranscriberConfig) {
        this.config = {
            wsUrl: config.wsUrl,
            audioChunkMs: config.audioChunkMs ?? 160,
            maxReconnect: config.maxReconnect ?? 3,
        };
    }

    setCallbacks(callbacks: TranscriberCallbacks): void {
        this.callbacks = callbacks;
    }

    /**
     * 预连接：仅建立 WebSocket 连接，不启动 ASR 会话
     * 在用户进入语音笔记页面时调用，提前建立连接以减少录音启动延迟
     */
    async preconnect(): Promise<void> {
        // 已有可用连接则跳过
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }
        await this.connect({ sendStart: false });
        // 通知后端预连接 ASR 引擎
        this.sendMessage({ type: 'preconnect' });
    }

    async start(): Promise<void> {
        if (this.isRunning) return;

        this.isRunning = true;
        this.isPaused = false;
        this.reconnectCount = 0;
        this.pendingAudioChunks = [];

        // 如果预连接已建立，直接发送 start 消息
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.sendStartMessage();
            this.flushPendingAudio();
            return;
        }

        // 否则走完整连接流程
        await this.connect({ sendStart: true });
    }

    stop(): void {
        this.isRunning = false;
        this.pendingAudioChunks = [];
        this.sendMessage({ type: 'stop' });
        // 延迟断开，给 WebSocket 缓冲区时间发送 stop 消息
        // connect() 方法会正确清理旧连接，所以即使延迟断开也不会有问题
        setTimeout(() => {
            this.disconnect();
        }, 100);
    }

    pause(): void {
        this.isPaused = true;
        this.sendMessage({ type: 'pause' });
    }

    resume(): void {
        this.isPaused = false;
        this.reconnectCount = 0; // 重置重连计数，确保恢复后有完整重连能力
        this.sendMessage({ type: 'resume' });
    }

    dispose(): void {
        this.stop();
        this.callbacks = null;
    }

    /**
     * 发送音频数据
     * 供外部调用（如 useAudioRecorder 的 onDataAvailable）
     * 使用 WebSocket Binary Frame 直接发送，避免 Base64 编码开销
     */
    sendAudioChunk(data: ArrayBuffer | Blob): void {
        if (!this.isRunning || this.isPaused) {
            return;
        }

        if (data instanceof Blob) {
            data.arrayBuffer().then(buffer => {
                this.sendOrQueueAudio(buffer);
            }).catch(error => {
                console.error('[VolcengineTranscriber] 音频分片读取失败:', error);
            });
        } else {
            this.sendOrQueueAudio(data);
        }
    }

    private async connect(options: { sendStart: boolean } = { sendStart: true }): Promise<void> {
        // 清理任何现有的 WebSocket 连接，避免重复连接
        if (this.ws) {
            this.ws.onclose = null; // 移除旧的事件处理器，防止触发重连
            this.ws.onerror = null;
            this.ws.onmessage = null;
            this.ws.onopen = null;
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                this.ws.close();
            }
            this.ws = null;
        }

        this.updateConnectionStatus('connecting');

        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(this.config.wsUrl);

                this.ws.onopen = () => {
                    console.log('[VolcengineTranscriber] 已连接');
                    this.updateConnectionStatus('connected');

                    if (options.sendStart) {
                        this.sendStartMessage();
                        this.flushPendingAudio();
                    }

                    resolve();
                };

                this.ws.onmessage = (event) => {
                    this.handleMessage(event.data);
                };

                this.ws.onerror = (_event) => {
                    // WebSocket onerror 事件是 Event 类型，不是 Error
                    // 尝试获取更有意义的错误信息
                    const errorMessage = this.ws?.url
                        ? `无法连接到 ${this.ws.url}`
                        : 'WebSocket 连接错误';
                    console.error('[VolcengineTranscriber] 连接错误:', errorMessage);
                    this.updateConnectionStatus('error');
                    this.callbacks?.onError?.(new Error(errorMessage));
                };

                this.ws.onclose = () => {
                    console.log('[VolcengineTranscriber] 连接关闭');
                    if (this.isRunning) {
                        this.tryReconnect();
                    } else {
                        this.updateConnectionStatus('disconnected');
                    }
                };

            } catch (error) {
                this.updateConnectionStatus('error');
                reject(error);
            }
        });
    }

    private disconnect(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.updateConnectionStatus('disconnected');
    }

    private async tryReconnect(): Promise<void> {
        if (this.reconnectCount >= this.config.maxReconnect) {
            console.log('[VolcengineTranscriber] 重连次数已用尽');
            this.updateConnectionStatus('error');
            this.callbacks?.onError?.(new Error('重连失败，请检查网络'));
            return;
        }

        this.reconnectCount++;
        this.updateConnectionStatus('reconnecting');
        console.log(`[VolcengineTranscriber] 尝试重连 (${this.reconnectCount}/${this.config.maxReconnect})`);

        // 指数退避
        const delay = Math.min(300 * Math.pow(2, this.reconnectCount - 1), 3000);
        await new Promise(resolve => setTimeout(resolve, delay));

        if (this.isRunning) {
            await this.connect();
        }
    }

    private sendMessage(data: object): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    private sendStartMessage(): void {
        this.sendMessage({
            type: 'start',
            audioConfig: {
                sampleRate: 16000,
                encoding: 'pcm',
            },
        });
    }

    private handleMessage(data: string): void {
        try {
            const message = JSON.parse(data);
            const type = message.type;

            switch (type) {
                case 'ready':
                    this.sessionId = message.sessionId;
                    console.log(`[VolcengineTranscriber] 会话就绪: ${this.sessionId}`);
                    this.flushPendingAudio();
                    break;

                case 'event_partial':
                    this.callbacks?.onPartial(message.text);
                    break;

                case 'event_final':
                    this.callbacks?.onFinal(message.text);
                    break;

                case 'event_revise':
                    this.callbacks?.onRevise(message.block_index ?? message.blockIndex, message.text);
                    break;

                case 'event_corrected':
                    // LLM 纠错结果：用纠正后的文本替换对应 block
                    this.callbacks?.onRevise(message.blockIndex, message.corrected);
                    break;

                case 'error':
                    console.error('[VolcengineTranscriber] 服务错误:', message);
                    if (message.retriable) {
                        // 可重试错误，尝试重连
                        this.tryReconnect();
                    } else {
                        this.callbacks?.onError?.(new Error(message.message));
                    }
                    break;

                case 'metrics':
                    console.log('[VolcengineTranscriber] 指标:', message);
                    break;

                default:
                    console.log('[VolcengineTranscriber] 未知消息:', message);
            }
        } catch (error) {
            console.error('[VolcengineTranscriber] 解析消息失败:', error);
        }
    }

    private updateConnectionStatus(status: ConnectionStatus): void {
        this.callbacks?.onStatusChange?.(status);
    }

    private sendOrQueueAudio(buffer: ArrayBuffer): void {
        if (!this.isRunning || this.isPaused) {
            return;
        }

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(buffer);
            return;
        }

        if (this.pendingAudioChunks.length >= this.maxPendingAudioChunks) {
            // 连接未就绪时保留最新音频，避免队列无限增长。
            this.pendingAudioChunks.shift();
        }
        this.pendingAudioChunks.push(buffer);
    }

    private flushPendingAudio(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.pendingAudioChunks.length === 0) {
            return;
        }

        for (const chunk of this.pendingAudioChunks) {
            this.ws.send(chunk);
        }
        this.pendingAudioChunks = [];
    }
}
