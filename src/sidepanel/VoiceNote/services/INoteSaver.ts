/**
 * 笔记保存器接口定义
 * 抽象保存服务，支持 Mock 和真实墨问 API 切换
 */

import { SaveResult, VoiceNoteSaveData } from '../types';

/** 笔记保存器接口 */
export interface INoteSaver {
    /**
     * 保存语音笔记
     * @param data 保存数据（文本 + 可选音频）
     * @returns 保存结果
     */
    save(data: VoiceNoteSaveData): Promise<SaveResult>;
}
