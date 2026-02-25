/**
 * Offscreen Document — 标签页音频采集
 * 通过 tabCapture streamId 获取标签页音频，处理为 PCM 16kHz 16-bit 格式
 */

let audioContext = null;
let processor = null;
let stream = null;
let playbackAudio = null;
let isPaused = false;
let pcmBuffer = [];
let allPcmChunks = [];
let lastSendTime = 0;
const TARGET_SAMPLE_RATE = 16000;
const SEND_INTERVAL = 100;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  switch (message.type) {
    case 'START_TAB_RECORDING':
      startTabRecording(message.streamId)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'STOP_TAB_RECORDING':
      const data = stopTabRecording();
      sendResponse({ success: true, data });
      break;

    case 'PAUSE_TAB_RECORDING':
      isPaused = true;
      sendResponse({ success: true });
      break;

    case 'RESUME_TAB_RECORDING':
      isPaused = false;
      sendResponse({ success: true });
      break;
  }
});

async function startTabRecording(streamId) {
  // 获取标签页音频流
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
  });

  // 回放原始音频，让用户仍能听到标签页声音
  playbackAudio = new Audio();
  playbackAudio.srcObject = stream;
  playbackAudio.play();

  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const bufferSize = 4096;
  processor = audioContext.createScriptProcessor(bufferSize, 1, 1);
  const resampleRatio = audioContext.sampleRate / TARGET_SAMPLE_RATE;

  pcmBuffer = [];
  allPcmChunks = [];
  isPaused = false;
  lastSendTime = Date.now();

  processor.onaudioprocess = (event) => {
    // 暂停时跳过数据采集，但 AudioContext 和回放继续运行
    if (isPaused) return;

    const inputData = event.inputBuffer.getChannelData(0);

    // 重采样到 16kHz（线性插值）
    const outputLength = Math.floor(inputData.length / resampleRatio);
    const pcm16 = new Int16Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i * resampleRatio;
      const index0 = Math.floor(srcIndex);
      const index1 = Math.min(index0 + 1, inputData.length - 1);
      const fraction = srcIndex - index0;
      const sample = inputData[index0] * (1 - fraction) + inputData[index1] * fraction;
      pcm16[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    }

    pcmBuffer.push(pcm16);
    allPcmChunks.push(new Int16Array(pcm16));

    // 每 100ms 发送一次
    const now = Date.now();
    if (now - lastSendTime >= SEND_INTERVAL) {
      lastSendTime = now;
      flushBuffer();
    }
  };

  source.connect(processor);
  processor.connect(audioContext.destination);
}

function flushBuffer() {
  if (pcmBuffer.length === 0) return;

  // 合并所有待发送的 PCM 数据
  let totalLength = 0;
  for (const chunk of pcmBuffer) {
    totalLength += chunk.length;
  }
  const merged = new Int16Array(totalLength);
  let offset = 0;
  for (const chunk of pcmBuffer) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  pcmBuffer = [];

  // 转 Base64
  const bytes = new Uint8Array(merged.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);

  chrome.runtime.sendMessage({
    type: 'TAB_AUDIO_DATA',
    data: base64,
    format: 'pcm_s16le_16k',
  }).catch(() => {});
}

function stopTabRecording() {
  // 刷新剩余缓冲
  flushBuffer();

  // 清理音频节点
  if (processor) {
    processor.disconnect();
    processor.onaudioprocess = null;
    processor = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }
  if (playbackAudio) {
    playbackAudio.pause();
    playbackAudio.srcObject = null;
    playbackAudio = null;
  }

  // 合并所有 PCM 数据返回
  if (allPcmChunks.length === 0) return null;

  let totalLength = 0;
  for (const chunk of allPcmChunks) {
    totalLength += chunk.length;
  }
  const merged = new Int16Array(totalLength);
  let offset = 0;
  for (const chunk of allPcmChunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  allPcmChunks = [];

  const bytes = new Uint8Array(merged.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
