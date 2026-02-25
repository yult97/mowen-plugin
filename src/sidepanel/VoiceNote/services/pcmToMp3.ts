import { Mp3Encoder } from '@breezystack/lamejs';

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_CHANNELS = 1;
const DEFAULT_MP3_KBPS = 96;
const MP3_FRAME_SIZE = 1152;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function mergePcmChunksToInt16(chunks: Blob[]): Promise<Int16Array> {
  return Promise.all(chunks.map(chunk => chunk.arrayBuffer())).then(buffers => {
    const totalSamples = buffers.reduce((sum, buffer) => sum + Math.floor(buffer.byteLength / 2), 0);
    const merged = new Int16Array(totalSamples);
    let sampleOffset = 0;

    for (const buffer of buffers) {
      const view = new DataView(buffer);
      const sampleCount = Math.floor(buffer.byteLength / 2);

      for (let i = 0; i < sampleCount; i++) {
        merged[sampleOffset++] = view.getInt16(i * 2, true);
      }
    }

    return merged;
  });
}

export async function pcmChunksToMp3Blob(
  chunks: Blob[],
  sampleRate = DEFAULT_SAMPLE_RATE
): Promise<Blob | null> {
  if (chunks.length === 0) return null;

  const pcmSamples = await mergePcmChunksToInt16(chunks);
  if (pcmSamples.length === 0) return null;

  const encoder = new Mp3Encoder(DEFAULT_CHANNELS, sampleRate, DEFAULT_MP3_KBPS);
  const mp3Chunks: ArrayBuffer[] = [];

  for (let i = 0; i < pcmSamples.length; i += MP3_FRAME_SIZE) {
    const pcmChunk = pcmSamples.subarray(i, i + MP3_FRAME_SIZE);
    const encoded = encoder.encodeBuffer(pcmChunk);
    if (encoded.length > 0) {
      mp3Chunks.push(toArrayBuffer(encoded));
    }
  }

  const finalChunk = encoder.flush();
  if (finalChunk.length > 0) {
    mp3Chunks.push(toArrayBuffer(finalChunk));
  }

  if (mp3Chunks.length === 0) return null;
  return new Blob(mp3Chunks, { type: 'audio/mpeg' });
}
