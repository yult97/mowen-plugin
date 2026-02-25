/**
 * 墨问笔记保存器实现
 * 真正调用墨问 API 保存语音笔记（含音频上传）
 *
 * 流程：
 * 1. 如果有音频，先上传音频文件（/upload/prepare + OSS 上传）
 * 2. 构建 NoteAtom 结构（包含文本段落和音频节点）
 * 3. 调用 /note/create 创建笔记
 */

import { INoteSaver } from './INoteSaver';
import { SaveResult, VoiceNoteSaveData } from '../types';
import { uploadLocalFile, uploadPrepare, createNoteWithBody } from '../../../services/api';
import { getSettings } from '../../../utils/storage';

export class MowenNoteSaver implements INoteSaver {
  async save(data: VoiceNoteSaveData): Promise<SaveResult> {
    console.log('[MowenNoteSaver] 开始保存语音笔记', {
      contentLength: data.content.length,
      hasAudio: !!data.audioBlob,
      duration: data.duration,
    });

    try {
      // 获取 API Key
      const settings = await getSettings();
      const apiKey = settings.apiKey;

      if (!apiKey) {
        return {
          success: false,
          error: '未配置 API Key',
        };
      }

      let audioUuid: string | undefined;

      // Step 1: 如果有音频，先上传
      if (data.audioBlob && data.audioBlob.size > 0) {
        console.log('[MowenNoteSaver] 开始上传音频文件', {
          size: data.audioBlob.size,
          type: data.audioBlob.type,
        });

        const uploadResult = await this.uploadAudio(apiKey, data.audioBlob);
        if (uploadResult.success && uploadResult.uuid) {
          audioUuid = uploadResult.uuid;
          console.log('[MowenNoteSaver] 音频上传成功', { uuid: audioUuid });
        } else {
          console.warn('[MowenNoteSaver] 音频上传失败，继续保存文本', uploadResult.error);
        }
      }

      // Step 2: 构建 NoteAtom
      const body = this.buildNoteAtom(data.content, audioUuid, data.duration);
      console.log('[MowenNoteSaver] 构建 NoteAtom', {
        hasAudioUuid: !!audioUuid,
        audioUuid,
        bodyContentLength: (body.content as unknown[])?.length,
        body: JSON.stringify(body).substring(0, 500),
      });

      // Step 3: 创建笔记
      const result = await createNoteWithBody(apiKey, body, false, settings.enableAutoTag);

      if (result.success && result.noteId) {
        console.log('[MowenNoteSaver] 笔记创建成功', { noteId: result.noteId });
        return {
          success: true,
          noteId: result.noteId,
        };
      } else {
        console.error('[MowenNoteSaver] 笔记创建失败', result.error);
        return {
          success: false,
          error: result.error || '创建笔记失败',
        };
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : '未知错误';
      console.error('[MowenNoteSaver] 保存失败', error);
      return {
        success: false,
        error: errMsg,
      };
    }
  }



  /**
   * 上传音频文件到墨问
   * 使用两步上传法：/upload/prepare 获取授权 -> 上传到 OSS
   * 注意：音频上传需要使用 fileType=2
   */
  private async uploadAudio(
    apiKey: string,
    audioBlob: Blob
  ): Promise<{ success: boolean; uuid?: string; fileId?: string; uid?: string; error?: string }> {
    try {
      // Step 1: 获取上传授权（fileType=2 表示音频）
      const fileName = this.generateAudioFileName(audioBlob.type);

      const prepareResult = await this.uploadPrepareAudio(apiKey, fileName);

      if (!prepareResult.success || !prepareResult.endpoint || !prepareResult.form) {
        return { success: false, error: prepareResult.error || '获取上传授权失败' };
      }

      // 从 form 中提取回退字段（某些 OSS 回调可能不返回 file 对象）
      const fileIdFromForm = prepareResult.form['x:file_id'];
      const fileUid = prepareResult.form['x:file_uid'];
      console.log('[MowenNoteSaver] 从 prepare 响应获取 file 标识:', {
        fileIdFromForm,
        fileUid,
      });

      // Step 2: 上传文件到 OSS
      const uploadResult = await uploadLocalFile(
        prepareResult.endpoint,
        prepareResult.form,
        audioBlob,
        fileName
      );

      if (uploadResult.success) {
        // 关键：NoteAtom 的 uuid 优先使用 fileId（与图片上传一致）
        const fileId = uploadResult.uploadedFile?.fileId || fileIdFromForm;
        const uid = uploadResult.uploadedFile?.uid || fileUid;
        const uuid = fileId || uid;
        console.log('[MowenNoteSaver] 音频上传结果标识:', {
          fileId,
          uid,
          selectedUuid: uuid,
          selectedSource: fileId ? 'fileId' : (uid ? 'uid' : 'none'),
        });
        if (uuid) {
          return { success: true, uuid, fileId, uid };
        }
        return { success: false, error: '上传成功但未获取到文件 UUID' };
      }

      return { success: false, error: uploadResult.error || '上传失败' };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : '上传失败';
      return { success: false, error: errMsg };
    }
  }

  /**
   * 获取音频上传授权
   * API: POST /upload/prepare
   * 使用 fileType=2 表示音频文件
   */
  private async uploadPrepareAudio(
    apiKey: string,
    fileName: string
  ): Promise<{ success: boolean; endpoint?: string; form?: Record<string, string>; error?: string }> {
    return uploadPrepare(apiKey, fileName, 2);
  }

  private generateAudioFileName(mimeType: string): string {
    const ext = this.getAudioFileExtension(mimeType);
    return `voice_note_${Date.now()}${ext}`;
  }

  private getAudioFileExtension(mimeType: string): string {
    switch (mimeType) {
      case 'audio/mpeg':
        return '.mp3';
      case 'audio/mp4':
      case 'audio/m4a':
      case 'audio/x-m4a':
      case 'audio/mp4a-latm':
        return '.m4a';
      default:
        return '.wav';
    }
  }


  /**
   * 构建 NoteAtom 结构
   * 包含音频节点（如果有）和文本段落节点
   */
  private buildNoteAtom(
    content: string,
    audioUuid?: string,
    duration?: number
  ): Record<string, unknown> {
    const contentNodes: Array<Record<string, unknown>> = [];

    // 添加音频节点（如果有）
    if (audioUuid) {
      contentNodes.push({
        type: 'audio',
        attrs: {
          'audio-uuid': audioUuid,
          ...(duration ? { 'show-note': this.formatDurationNote(duration) } : {}),
        },
      });
    }

    // 将文本内容按段落分割
    const paragraphs = content.split(/\n\n+/).filter(p => p.trim());

    for (const paragraph of paragraphs) {
      // 处理段落内的换行
      const lines = paragraph.split('\n').filter(l => l.trim());
      const textNodes: Array<Record<string, unknown>> = [];

      for (let i = 0; i < lines.length; i++) {
        textNodes.push({ type: 'text', text: lines[i].trim() });
        if (i < lines.length - 1) {
          textNodes.push({ type: 'text', text: '\n' });
        }
      }

      if (textNodes.length > 0) {
        contentNodes.push({
          type: 'paragraph',
          content: textNodes,
        });
      }
    }

    // 确保至少有一个段落
    if (contentNodes.length === 0 || (contentNodes.length === 1 && audioUuid)) {
      contentNodes.push({
        type: 'paragraph',
        content: [{ type: 'text', text: ' ' }],
      });
    }

    return {
      type: 'doc',
      content: contentNodes,
    };
  }

  /**
   * 格式化时长备注
   */
  private formatDurationNote(duration: number): string {
    const minutes = Math.floor(duration / 60);
    const seconds = Math.floor(duration % 60);
    return `00:00 语音笔记 (${minutes}:${seconds.toString().padStart(2, '0')})`;
  }
}
