/**
 * Content Script Entry Point
 * 
 * This is the main entry point for the content script.
 * It handles message passing and initializes auto-extraction.
 * 
 * The heavy lifting is done by specialized modules:
 * - extractor.ts: Content extraction logic
 * - images.ts: Image extraction and filtering
 * - imageNormalizer.ts: CDN URL normalization
 * - imageFetcher.ts: Image data fetching for upload
 */

import {
  extractContent,
  getCachedResult,
  isExtractingContent,
  clearCache
} from './extractor';
import { clearQuoteUrlCache } from './twitterExtractor';
import { fetchImageAsBase64 } from './imageFetcher';
import { ExtractResult } from '../types';
import { initHighlighter } from './highlighter';

// State for auto-extraction
let observer: MutationObserver | null = null;
let isObserving = false;
let extractScheduled = false;

// ============ 麦克风录音状态 ============
let micStream: MediaStream | null = null;
let micAudioChunks: Blob[] = [];

/**
 * 开始麦克风录音
 * 使用 AudioContext 直接采集 PCM 数据（16kHz 16bit），绕过 MediaRecorder/WebM 编码
 */
async function startMicRecording(options: { timeslice?: number } = {}): Promise<void> {
  // 清理之前的录音
  micAudioChunks = [];

  // 火山引擎要求 16kHz 采样率
  const targetSampleRate = 16000;

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: targetSampleRate, // 尝试请求 16kHz（浏览器可能不支持）
    }
  });

  // 创建 AudioContext（使用设备原生采样率）
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(micStream);

  // 音频增强：高通滤波器（85Hz 截止频率，去除低频噪声如空调、风扇、电脑嗡鸣）
  // 人声基频 F0 通常 > 85Hz（男性 ~85-180Hz，女性 ~165-255Hz），85Hz 不会损伤语音
  const highPassFilter = audioContext.createBiquadFilter();
  highPassFilter.type = 'highpass';
  highPassFilter.frequency.value = 85;
  highPassFilter.Q.value = 0.707; // Butterworth 响应，平坦通带

  // 二级高通滤波器（级联两个 Butterworth = 4 阶滤波，衰减更陡峭 -24dB/oct）
  const highPassFilter2 = audioContext.createBiquadFilter();
  highPassFilter2.type = 'highpass';
  highPassFilter2.frequency.value = 85;
  highPassFilter2.Q.value = 0.707;

  // 使用 ScriptProcessorNode 采集音频数据
  // 缓冲区大小: 4096 samples (~85ms at 48kHz, ~256ms at 16kHz)
  const bufferSize = 4096;
  const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);

  // 计算重采样比率
  const resampleRatio = audioContext.sampleRate / targetSampleRate;

  // VAD（语音活动检测）参数：基于 RMS 能量的静音检测
  const vadRmsThreshold = 0.008; // RMS 阈值（提高灵敏度，过滤更多环境噪音）
  let consecutiveSilentFrames = 0;
  const maxSilentFrames = 15; // 连续静音帧数上限（~255ms at 48kHz），更快切断噪音
  // 语音起始保护：检测到语音后至少保持 hangover 帧，避免语音间隙被误切
  const vadHangoverFrames = 8; // ~136ms 的语音保持时间
  let speechHangover = 0;

  // 发送间隔（毫秒）- 降低到 100ms 以减少边界切断导致的漏字
  const sendInterval = options.timeslice || 100;
  let pcmBuffer: Int16Array[] = [];
  let lastSendTime = Date.now();

  processor.onaudioprocess = (event) => {
    // 检查扩展上下文是否仍然有效
    if (!chrome.runtime?.id) {
      // 扩展上下文已失效，静默清理
      console.log('[content] 扩展上下文已失效，停止音频处理');
      processor.disconnect();
      const win = window as unknown as {
        __micAudioContext?: AudioContext;
        __micHighPassFilter?: BiquadFilterNode;
        __micHighPassFilter2?: BiquadFilterNode;
        __micProcessor?: ScriptProcessorNode;
      };
      if (win.__micHighPassFilter2) {
        win.__micHighPassFilter2.disconnect();
        win.__micHighPassFilter2 = undefined;
      }
      if (win.__micHighPassFilter) {
        win.__micHighPassFilter.disconnect();
        win.__micHighPassFilter = undefined;
      }
      if (win.__micAudioContext) {
        win.__micAudioContext.close().catch(() => { });
        win.__micAudioContext = undefined;
      }
      win.__micProcessor = undefined;
      if (micStream) {
        micStream.getTracks().forEach(track => track.stop());
        micStream = null;
      }
      return;
    }

    const inputData = event.inputBuffer.getChannelData(0);

    // VAD：计算当前帧的 RMS 能量
    let sumSquares = 0;
    for (let i = 0; i < inputData.length; i++) {
      sumSquares += inputData[i] * inputData[i];
    }
    const rms = Math.sqrt(sumSquares / inputData.length);

    if (rms < vadRmsThreshold) {
      consecutiveSilentFrames++;
      // hangover 保护：语音刚结束后保持几帧，避免语音间隙被误切
      if (speechHangover > 0) {
        speechHangover--;
      } else if (consecutiveSilentFrames > maxSilentFrames) {
        // 持续静音且 hangover 已耗尽，跳过发送以节省带宽
        return;
      }
    } else {
      consecutiveSilentFrames = 0;
      speechHangover = vadHangoverFrames; // 检测到语音，重置 hangover
    }

    // 重采样到 16kHz 并转换为 16bit PCM（使用线性插值，提高精度）
    const outputLength = Math.floor(inputData.length / resampleRatio);
    const pcm16 = new Int16Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
      // 使用线性插值而非简单抽样，减少音频细节丢失
      const srcIndex = i * resampleRatio;
      const index0 = Math.floor(srcIndex);
      const index1 = Math.min(index0 + 1, inputData.length - 1);
      const fraction = srcIndex - index0;

      // 线性插值：sample = sample0 * (1 - fraction) + sample1 * fraction
      const sample0 = inputData[index0];
      const sample1 = inputData[index1];
      const sample = sample0 + (sample1 - sample0) * fraction;

      // 将 -1.0 ~ 1.0 的浮点数转换为 -32768 ~ 32767 的整数
      const clampedSample = Math.max(-1, Math.min(1, sample));
      pcm16[i] = clampedSample < 0 ? clampedSample * 0x8000 : clampedSample * 0x7FFF;
    }

    pcmBuffer.push(pcm16);

    // 定期发送数据
    const now = Date.now();
    if (now - lastSendTime >= sendInterval) {
      // 合并缓冲区
      const totalLength = pcmBuffer.reduce((sum, arr) => sum + arr.length, 0);
      const mergedPcm = new Int16Array(totalLength);
      let offset = 0;
      for (const chunk of pcmBuffer) {
        mergedPcm.set(chunk, offset);
        offset += chunk.length;
      }

      // 转换为 Base64 发送
      const uint8Array = new Uint8Array(mergedPcm.buffer);
      let binary = '';
      for (let i = 0; i < uint8Array.length; i++) {
        binary += String.fromCharCode(uint8Array[i]);
      }
      const base64 = btoa(binary);

      // 发送到 sidepanel（增强错误处理）
      chrome.runtime.sendMessage({
        type: 'MIC_AUDIO_DATA',
        data: base64,  // 直接发送 Base64（不是 Data URL）
        format: 'pcm_s16le_16k'  // 标记格式：PCM 16bit 小端 16kHz
      }).catch((err) => {
        // 检测 context invalidated 错误
        if (err?.message?.includes('Extension context invalidated')) {
          console.log('[content] 扩展上下文失效，停止音频处理');
          processor.disconnect();
        }
      });

      // 同时保存完整数据用于停止时导出
      micAudioChunks.push(new Blob([mergedPcm.buffer], { type: 'audio/pcm' }));

      pcmBuffer = [];
      lastSendTime = now;
    }
  };

  // 音频链路：麦克风 → 高通滤波器1 → 高通滤波器2（4阶级联）→ 处理器（采集 PCM）
  source.connect(highPassFilter);
  highPassFilter.connect(highPassFilter2);
  highPassFilter2.connect(processor);
  processor.connect(audioContext.destination);

  // 保存引用以便停止
  (window as unknown as { __micAudioContext?: AudioContext; __micHighPassFilter?: BiquadFilterNode; __micHighPassFilter2?: BiquadFilterNode }).__micAudioContext = audioContext;
  (window as unknown as { __micHighPassFilter?: BiquadFilterNode }).__micHighPassFilter = highPassFilter;
  (window as unknown as { __micHighPassFilter2?: BiquadFilterNode }).__micHighPassFilter2 = highPassFilter2;
  (window as unknown as { __micProcessor?: ScriptProcessorNode }).__micProcessor = processor;
}

/**
 * 停止麦克风录音
 * 清理 AudioContext 和相关资源
 */
async function stopMicRecording(): Promise<string | null> {
  // 清理 AudioContext
  const win = window as unknown as {
    __micAudioContext?: AudioContext;
    __micHighPassFilter?: BiquadFilterNode;
    __micHighPassFilter2?: BiquadFilterNode;
    __micProcessor?: ScriptProcessorNode;
  };

  if (win.__micProcessor) {
    win.__micProcessor.disconnect();
    win.__micProcessor = undefined;
  }

  if (win.__micHighPassFilter2) {
    win.__micHighPassFilter2.disconnect();
    win.__micHighPassFilter2 = undefined;
  }

  if (win.__micHighPassFilter) {
    win.__micHighPassFilter.disconnect();
    win.__micHighPassFilter = undefined;
  }

  if (win.__micAudioContext) {
    await win.__micAudioContext.close();
    win.__micAudioContext = undefined;
  }

  // 停止媒体流
  if (micStream) {
    micStream.getTracks().forEach(track => track.stop());
    micStream = null;
  }

  // 合并所有 PCM 数据并返回
  if (micAudioChunks.length === 0) {
    return null;
  }

  // 合并 Blob
  const allData = await Promise.all(
    micAudioChunks.map(blob => blob.arrayBuffer())
  );
  const totalLength = allData.reduce((sum, buf) => sum + buf.byteLength, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const buf of allData) {
    merged.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }

  // 转换为 Base64
  let binary = '';
  for (let i = 0; i < merged.length; i++) {
    binary += String.fromCharCode(merged[i]);
  }
  const base64 = btoa(binary);

  micAudioChunks = [];
  return base64;
}

/**
 * 暂停麦克风录音
 * 使用 AudioContext.suspend() 暂停音频处理
 */
async function pauseMicRecording(): Promise<void> {
  const win = window as unknown as { __micAudioContext?: AudioContext };
  if (win.__micAudioContext && win.__micAudioContext.state === 'running') {
    await win.__micAudioContext.suspend();
    console.log('[content] 麦克风录音已暂停');
  }
}

/**
 * 继续麦克风录音
 * 使用 AudioContext.resume() 恢复音频处理
 */
async function resumeMicRecording(): Promise<void> {
  const win = window as unknown as { __micAudioContext?: AudioContext };
  const ctx = win.__micAudioContext;

  if (!ctx) {
    console.warn('[content] 无法恢复录音：AudioContext 不存在');
    return;
  }

  console.log('[content] AudioContext 当前状态:', ctx.state);

  if (ctx.state === 'suspended') {
    await ctx.resume();
    console.log('[content] 麦克风录音已恢复，当前状态:', ctx.state);
  } else if (ctx.state === 'running') {
    console.log('[content] AudioContext 已在运行中，无需恢复');
  } else {
    console.warn('[content] AudioContext 状态异常:', ctx.state);
  }
}

// URL 变化检测（用于 SPA 路由）
let lastKnownUrl = window.location.href;

// 定期检测 URL 变化（用于 Twitter 等 SPA）
setInterval(() => {
  if (window.location.href !== lastKnownUrl) {
    console.log(`[content] 🔄 URL changed: ${lastKnownUrl} -> ${window.location.href}`);
    lastKnownUrl = window.location.href;
    clearCache();
    clearQuoteUrlCache(); // 同时清理 Quote URL 缓存
    // 如果正在观察，触发新的提取
    if (isObserving) {
      scheduleExtraction();
    }
  }
}, 500);

// Listen for messages from popup/background
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // console.log('[content] Received message:', message.type);

  // PING: Health check
  if (message.type === 'PING') {
    sendResponse({ success: true, status: 'ready' });
    return false;
  }

  // START_EXTRACTION: Enable observer and trigger extraction
  if (message.type === 'START_EXTRACTION') {
    console.log('[content] 🚀 START_EXTRACTION received');
    startAutoExtraction();

    // 内容稳定性检测：连续两次提取结果字数差异 < 5% 时认为内容已稳定
    const extractWithStability = async (maxAttempts: number, interval: number, stabilityThreshold: number = 0.05) => {
      let lastResult: ExtractResult | null = null;
      let lastWordCount = 0;

      for (let i = 0; i < maxAttempts; i++) {
        try {
          const result = await extractContent();
          const currentWordCount = result.wordCount;

          // 计算与上次提取的字数差异比例
          const diff = lastWordCount > 0
            ? Math.abs(currentWordCount - lastWordCount) / lastWordCount
            : 1; // 首次提取，差异设为 100%

          console.log(`[content] 提取 #${i + 1}: ${currentWordCount} 字, 变化: ${(diff * 100).toFixed(1)}%`);

          // 稳定性判定：字数变化 < 阈值 且 字数 > 50 且 有标题
          if (diff < stabilityThreshold && currentWordCount > 50 && result.title) {
            console.log(`[content] ✅ 内容已稳定，返回结果`);
            return result;
          }

          lastResult = result;
          lastWordCount = currentWordCount;
        } catch (error) {
          console.error(`[content] ⚠️ 提取 #${i + 1} 失败:`, error);
        }

        if (i < maxAttempts - 1) {
          await new Promise(r => setTimeout(r, interval));
        }
      }

      if (lastResult) {
        console.log(`[content] ⏱️ 达到最大尝试次数，返回最后结果 (${lastResult.wordCount} 字)`);
        return lastResult;
      }
      throw new Error('All extraction attempts failed');
    };

    // 使用稳定性检测提取内容
    // 最多尝试 6 次，每次间隔 500ms，稳定阈值 1%（更严格）
    extractWithStability(6, 500, 0.01)
      .then((result) => {
        sendResponse({ success: true, data: result });
      })
      .catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  // STOP_EXTRACTION: Disable observer
  if (message.type === 'STOP_EXTRACTION') {
    console.log('[content] 🛑 STOP_EXTRACTION received');
    stopAutoExtraction();
    sendResponse({ success: true });
    return false;
  }

  // GET_CACHED_CONTENT: Return cached content if available
  if (message.type === 'GET_CACHED_CONTENT') {
    console.log('[content] 💾 GET_CACHED_CONTENT request');
    const cached = getCachedResult();
    const isExtracting = isExtractingContent();

    console.log('[content] Cache status:', {
      hasCache: !!cached,
      isExtracting,
      extractScheduled,
      isObserving,
    });

    if (cached) {
      sendResponse({
        success: true,
        data: cached,
        fromCache: true,
      });
      return false;
    }

    if (isExtracting) {
      sendResponse({
        success: false,
        extracting: true,
        error: 'Extraction in progress',
      });
      return false;
    }

    // If we are not observing, we might need to start it, or just do a one-off extraction
    // But usually GET_CACHED_CONTENT implies we want something fast.
    // If no cache, trigger extraction (same as before)
    extractContent()
      .then((result) => {
        sendResponse({ success: true, data: result, fromCache: false });
      })
      .catch((error) => {
        console.error('[content] ❌ Extraction failed:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep channel open for async response
  }

  // EXTRACT_CONTENT: Force fresh extraction
  if (message.type === 'EXTRACT_CONTENT') {
    // If we receive this, we should also ensure observer is running if the user expects auto-updates
    if (!isObserving) {
      startAutoExtraction();
    }

    extractContent()
      .then((result) => {
        console.log('[content] Extraction successful, word count:', result.wordCount);
        sendResponse({ success: true, data: result });
      })
      .catch((error) => {
        console.error('[content] ❌ Extraction failed:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  // FETCH_IMAGE: Fetch image as base64 for upload
  if (message.type === 'FETCH_IMAGE') {
    fetchImageAsBase64(message.payload.url)
      .then((result) => {
        if (result) {
          sendResponse({ success: true, data: result });
        } else {
          sendResponse({ success: false, error: 'Failed to fetch image' });
        }
      })
      .catch((error) => {
        console.error('[content] ❌ FETCH_IMAGE error:', error.message);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  // LOG_DEBUG: Debug logging proxy from background
  if (message.type === 'LOG_DEBUG') {
    console.log(`[🔍 Extension Log] ${message.payload}`);
    sendResponse({ success: true });
    return false;
  }

  // HIGHLIGHT_RESULT: 处理右键菜单保存结果（显示 Toast）
  if (message.type === 'HIGHLIGHT_RESULT') {
    const result = message.payload as { success: boolean; noteUrl?: string; isAppend?: boolean; error?: string };
    showHighlightResultToast(result);
    sendResponse({ success: true });
    return false;
  }

  // ============ 麦克风录音相关消息 ============

  // START_MIC_RECORDING: 开始麦克风录音
  if (message.type === 'START_MIC_RECORDING') {
    startMicRecording(message.options || {})
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // STOP_MIC_RECORDING: 停止麦克风录音
  if (message.type === 'STOP_MIC_RECORDING') {
    stopMicRecording()
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // PAUSE_MIC_RECORDING: 暂停录音
  if (message.type === 'PAUSE_MIC_RECORDING') {
    pauseMicRecording()
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // RESUME_MIC_RECORDING: 继续录音
  if (message.type === 'RESUME_MIC_RECORDING') {
    resumeMicRecording()
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // GET_MIC_STATE: 获取录音状态
  if (message.type === 'GET_MIC_STATE') {
    const win = window as unknown as { __micAudioContext?: AudioContext };
    const isRecording = win.__micAudioContext && win.__micAudioContext.state === 'running';
    sendResponse({
      success: true,
      state: isRecording ? 'recording' : 'inactive'
    });
    return false;
  }

  // Unknown message types
  return false;
});

/**
 * 显示划线保存结果 Toast（用于右键菜单保存）
 * 样式与 HighlightManager 的 showToast 保持一致
 */
function showHighlightResultToast(result: { success: boolean; noteUrl?: string; isAppend?: boolean; error?: string }): void {
  // 移除已有的 toast
  const existingToast = document.querySelector('.mowen-toast');
  if (existingToast) {
    existingToast.remove();
  }

  const toast = document.createElement('div');
  const type = result.success ? 'success' : 'error';
  toast.className = `mowen-toast ${type}`;

  const message = result.success
    ? '保存成功'
    : (result.error || '保存失败');

  // 根据类型选择图标（与 HighlightManager 一致）
  const iconHtml = result.success
    ? `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M5 7H19V19C19 20.1046 18.1046 21 17 21H7C5.89543 21 5 20.1046 5 19V7Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
        <path d="M8 7V5C8 3.89543 8.89543 3 10 3H14C15.1046 3 16 3.89543 16 5V7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M12 10L12.9 12.2L15 12.5L13.5 14L13.8 16.5L12 15.4L10.2 16.5L10.5 14L9 12.5L11.1 12.2L12 10Z" fill="currentColor"/>
       </svg>`
    : `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8" fill="none"/>
        <path d="M15 9L9 15M9 9L15 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
       </svg>`;

  let html = `
    <span class="mowen-toast-icon">${iconHtml}</span>
    <span class="mowen-toast-message">${message}</span>
  `;

  // 如果有链接，添加操作按钮
  if (result.success && result.noteUrl) {
    html += `<a href="${result.noteUrl}" target="_blank" class="mowen-toast-action">去墨问笔记查看</a>`;
  }

  toast.innerHTML = html;

  // 注入 Toast 样式（如果尚未注入）
  injectToastStyles();

  document.body.appendChild(toast);

  // 3秒后自动消失
  setTimeout(() => {
    toast.classList.add('mowen-toast-out');
    setTimeout(() => toast.remove(), 200);
  }, 3000);
}

/**
 * 注入 Toast 样式（与 HighlightManager 一致）
 */
function injectToastStyles(): void {
  if (document.getElementById('mowen-toast-styles')) return;

  const style = document.createElement('style');
  style.id = 'mowen-toast-styles';
  style.textContent = `
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
    .mowen-toast-message {
      flex: 1;
      color: #1F2937;
      white-space: nowrap;
    }
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
    .mowen-toast.success .mowen-toast-icon { color: #BF4045; }
    .mowen-toast.error .mowen-toast-icon { color: #EF4444; }
  `;
  document.head.appendChild(style);
}

/**
 * Schedule content extraction with debouncing.
 */
function scheduleExtraction(): void {
  if (extractScheduled) {
    console.log('[content] ⏸️ Extraction already scheduled, skipping');
    return;
  }

  extractScheduled = true;
  console.log('[content] 📅 Scheduling extraction in 1.5s');

  setTimeout(() => {
    extractScheduled = false;
    console.log('[content] ⏰ Scheduled extraction triggered');
    extractContent()
      .then((result) => {
        // Notify popup/sidepanel about the update
        chrome.runtime.sendMessage({
          type: 'CONTENT_UPDATED',
          data: result
        }).catch(() => {
          // Ignore error if popup is closed
        });
      })
      .catch((err) => {
        console.error('[content] ❌ Auto-extraction failed:', err);
      });
  }, 1500);
}

/**
 * Start auto-extraction (MutationObserver)
 */
function startAutoExtraction(): void {
  if (isObserving) {
    console.log('[content] ✅ Already observing');
    return;
  }

  console.log('[content] 🎯 Starting auto-extraction observer');

  // Watch for dynamic content changes
  console.log('[content] 👁️ Setting up MutationObserver');

  if (observer) {
    observer.disconnect();
  }

  observer = new MutationObserver((mutations) => {
    const hasSignificantChanges = mutations.some((mutation) => {
      if (mutation.type !== 'childList') return false;

      return mutation.addedNodes.length > 0 &&
        Array.from(mutation.addedNodes).some((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as Element;
            return !['SCRIPT', 'STYLE', 'IFRAME'].includes(el.tagName) &&
              (el.children.length > 0 || (el.textContent?.length || 0) > 50);
          }
          return false;
        });
    });

    if (hasSignificantChanges) {
      console.log('[content] 🔄 Significant page change detected, invalidating cache');
      clearCache();
      scheduleExtraction();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  isObserving = true;
}

/**
 * Stop auto-extraction
 */
function stopAutoExtraction(): void {
  if (!isObserving) return;

  console.log('[content] 🛑 Stopping auto-extraction observer');
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  isObserving = false;
}

// Initialize
console.log('[墨问笔记助手] Content script loaded (Lazy Mode)');
console.log('[content] Page URL:', window.location.href);

// Note: We NO LONGER automatically call startAutoExtraction()
// It will be triggered by the sidepanel/popup sending 'START_EXTRACTION'

// Notify popup/sidepanel that content script is ready
// This enables event-driven communication instead of polling
setTimeout(() => {
  chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY' }).catch(() => {
    // Ignore error if popup is not open
  });
}, 100);

// ============================================
// 划线功能初始化
// ============================================
// 默认启用划线功能
// 延迟初始化，确保页面 DOM 已就绪
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initHighlighter();
  });
} else {
  // DOM 已就绪，直接初始化
  setTimeout(() => {
    initHighlighter();
  }, 500);
}
