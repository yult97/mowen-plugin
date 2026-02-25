/**
 * Transcriber 工厂
 * 根据配置返回对应的 Transcriber 实例
 */

import { ITranscriber } from './ITranscriber';
import { VolcengineTranscriber } from './VolcengineTranscriber';
import { getAsrConfig } from '../../../config/asrConfig';

export type AsrProvider = 'volcengine';

/**
 * 创建 Transcriber 实例
 *
 * 使用 VolcengineTranscriber 连接中转服务进行语音转写
 */
export function createTranscriber(): ITranscriber {
    const config = getAsrConfig();

    console.log('[TranscriberFactory] 使用 Volcengine Transcriber');
    return new VolcengineTranscriber({
        wsUrl: config.wsUrl,
        audioChunkMs: config.audioChunkMs,
        maxReconnect: config.maxReconnect,
    });
}
