/**
 * PCM 转 WAV 工具
 * 将原始 PCM 16kHz 16bit 单声道数据转换为可播放的 WAV Blob
 */

/**
 * 将 PCM ArrayBuffer 转换为 WAV Blob
 *
 * WAV 文件 = 44 字节文件头 + 原始 PCM 数据
 * 无需编码，直接拼接即可被 <audio> 播放
 */
export function pcmToWavBlob(
    pcmData: ArrayBuffer,
    sampleRate = 16000,
    numChannels = 1,
    bitsPerSample = 16,
): Blob {
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = pcmData.byteLength;
    const headerSize = 44;

    const buffer = new ArrayBuffer(headerSize + dataSize);
    const view = new DataView(buffer);

    // RIFF chunk descriptor
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);  // ChunkSize
    writeString(view, 8, 'WAVE');

    // fmt sub-chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);             // Subchunk1Size (PCM = 16)
    view.setUint16(20, 1, true);              // AudioFormat (PCM = 1)
    view.setUint16(22, numChannels, true);    // NumChannels
    view.setUint32(24, sampleRate, true);     // SampleRate
    view.setUint32(28, byteRate, true);       // ByteRate
    view.setUint16(32, blockAlign, true);     // BlockAlign
    view.setUint16(34, bitsPerSample, true);  // BitsPerSample

    // data sub-chunk
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);       // Subchunk2Size

    // 写入 PCM 数据
    new Uint8Array(buffer, headerSize).set(new Uint8Array(pcmData));

    return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, str: string): void {
    for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
    }
}

/**
 * 将多个 PCM Blob 合并为单个 WAV Blob
 * 用于保存时生成完整的音频文件
 */
export async function pcmChunksToWavBlob(chunks: Blob[]): Promise<Blob | null> {
    if (chunks.length === 0) return null;

    const buffers = await Promise.all(chunks.map(b => b.arrayBuffer()));
    const totalLength = buffers.reduce((sum, buf) => sum + buf.byteLength, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const buf of buffers) {
        merged.set(new Uint8Array(buf), offset);
        offset += buf.byteLength;
    }

    return pcmToWavBlob(merged.buffer);
}

/**
 * 将多个 PCM Blob 合并后转为 WAV Blob URL
 * 用于录音过程中实时生成可播放的音频
 */
export async function pcmChunksToWavUrl(chunks: Blob[]): Promise<string> {
    const wavBlob = await pcmChunksToWavBlob(chunks);
    if (!wavBlob) return '';
    return URL.createObjectURL(wavBlob);
}
