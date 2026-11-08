// Turns an artist's picture into a square-ish JPEG no larger than `size` pixels.
export async function resizeCover(file: File, size = 1200): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => (blob ? resolve(blob) : reject(new Error('Couldn’t read that image.'))), 'image/jpeg', 0.85,
  ));
}

export async function decodeAudio(file: File): Promise<AudioBuffer> {
  const context = new AudioContext();
  try {
    return await context.decodeAudioData(await file.arrayBuffer());
  } finally {
    context.close();
  }
}

export const PREVIEW_SECONDS = 30;

// Cuts a clip from the song as a 16-bit WAV, with short fades so it doesn't click.
export function previewClip(buffer: AudioBuffer, startSeconds: number): Blob {
  const rate = buffer.sampleRate;
  const start = Math.floor(Math.max(0, Math.min(startSeconds, buffer.duration - PREVIEW_SECONDS)) * rate);
  const frames = Math.min(PREVIEW_SECONDS * rate, buffer.length - start);
  const channels = Math.min(2, buffer.numberOfChannels);
  const fade = Math.floor(0.5 * rate);
  const view = new DataView(new ArrayBuffer(44 + frames * channels * 2));
  const text = (offset: number, s: string) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + frames * channels * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, frames * channels * 2, true);
  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    const gain = Math.min(1, i / fade, (frames - 1 - i) / fade);
    for (let c = 0; c < channels; c++) {
      const sample = Math.max(-1, Math.min(1, data[c][start + i] * gain));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([view], { type: 'audio/wav' });
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
