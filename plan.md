# 音频回放功能实现计划

## 目标
在录音态和编辑态都展示音频播放器（上方音频，下方文字），用户可以边听边看/改文字。

## 核心思路

### 数据来源
- **录音态**：`useAudioRecorder` 的 `onDataAvailable` 回调每 100ms 产生一个 PCM chunk，在 SidePanel 侧实时累积这些 chunk，每当有新 chunk 到达时重新生成可播放的 WAV Blob URL
- **编辑态**：录音停止后 `recordingBlobRef` 已保存完整 PCM Blob，直接用它生成 WAV

### 格式转换
PCM 16kHz 16bit 单声道无法被 `<audio>` 直接播放。方案：在前端拼接 44 字节 WAV 文件头，零编码开销，兼容所有浏览器。

## 实现步骤

### Step 1: 新建 `pcmToWav.ts` 工具函数
- 路径：`src/sidepanel/VoiceNote/services/pcmToWav.ts`
- 功能：接收 PCM `ArrayBuffer`，返回带 WAV 头的 `Blob`
- 参数：sampleRate=16000, numChannels=1, bitsPerSample=16

### Step 2: 新建 `AudioPlayer.tsx` 组件
- 路径：`src/sidepanel/VoiceNote/components/AudioPlayer.tsx`
- 功能：接收 WAV Blob URL，渲染自定义播放器 UI
- UI 元素：播放/暂停按钮、进度条、当前时间/总时长
- 风格：与现有 styles.css 的设计语言一致（米色背景、红棕品牌色、圆角卡片）

### Step 3: 修改 `useAudioRecorder.ts` — 实时累积 PCM chunks
- 在 `onDataAvailable` 回调中，除了发送给 transcriber，同时将 chunk 累积到一个 ref 数组
- 新增返回值 `audioChunks: Blob[]`（或合并后的 Blob）供播放器使用
- 停止录音时保留完整数据

### Step 4: 修改 `VoiceNotePage.tsx` — 集成播放器
- 录音态：将累积的 PCM chunks 转为 WAV URL，传给 AudioPlayer
- 编辑态：将 `recordingBlobRef` 的完整 PCM 转为 WAV URL，传给 AudioPlayer
- 布局：AudioPlayer 放在 TranscriptView / EditorView 上方

### Step 5: 修改 `TranscriptView.tsx` — 录音态布局调整
- 在 props 中新增可选的 `audioUrl`
- 有 audioUrl 时在转写文本上方渲染 AudioPlayer

### Step 6: 修改 `EditorView.tsx` — 编辑态布局调整
- 在 props 中新增可选的 `audioUrl`
- 有 audioUrl 时在编辑区上方渲染 AudioPlayer

### Step 7: 补充 CSS 样式
- 在 `styles.css` 中添加 AudioPlayer 相关样式

### Step 8: 导出更新
- `components/index.ts` 导出 AudioPlayer

### Step 9: TypeScript 类型检查
- 运行 `tsc --noEmit` 确认零报错
