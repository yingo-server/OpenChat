/**
 * 客户端媒体编码（§ D）：上传前在浏览器本地生成
 *   - makeThumbnail：图片缩略图（data URI，JPEG，长边 ≤320，>8KB 自动降质重试）
 *   - makeWaveform：音频峰值包络（24 段 0-100 整数）
 *
 * 纯计算部分（computeThumbSize / waveformFromChannelData）抽成独立导出函数，
 * 便于 node 环境单测；浏览器 API（createImageBitmap / OffscreenCanvas /
 * AudioContext）只在实际调用时触碰。
 */

export const THUMB_LIMIT_BYTES = 8 * 1024;

/** 缩略图重试阶梯：首次长边 320 q0.7；超限降到 240 q0.5；再不行 160 q0.4。 */
export const THUMB_ATTEMPTS: ReadonlyArray<{ maxEdge: number; quality: number }> = [
  { maxEdge: 320, quality: 0.7 },
  { maxEdge: 240, quality: 0.5 },
  { maxEdge: 160, quality: 0.4 },
];

/**
 * 等比缩放到长边 ≤ maxEdge（纯计算）。非法尺寸回退为 maxEdge×maxEdge 方框。
 */
export function computeThumbSize(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const w = Number.isFinite(width) && width > 0 ? width : 0;
  const h = Number.isFinite(height) && height > 0 ? height : 0;
  if (w === 0 || h === 0) return { width: maxEdge, height: maxEdge };
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

/** 估算 data URI 解码后字节数（base64 部分 length*3/4）。 */
export function estimateDataUriBytes(uri: string): number {
  const comma = uri.indexOf(',');
  const base64 = comma >= 0 ? uri.slice(comma + 1) : uri;
  let padding = 0;
  if (base64.endsWith('==')) padding = 2;
  else if (base64.endsWith('=')) padding = 1;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

// ---------------------------------------------------------------------------
// 缩略图
// ---------------------------------------------------------------------------

interface BitmapSource {
  source: CanvasImageSource;
  width: number;
  height: number;
  dispose(): void;
}

async function loadBitmap(file: File): Promise<BitmapSource> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      dispose: () => bitmap.close?.(),
    };
  }
  if (typeof Image !== 'undefined' && typeof URL !== 'undefined') {
    const url = URL.createObjectURL(file);
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('image decode failed'));
      image.src = url;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      dispose: () => URL.revokeObjectURL(url),
    };
  }
  throw new Error('no image decoding available');
}

function createCanvas(width: number, height: number): {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
} {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('offscreen 2d context unavailable');
    return { canvas, ctx };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  return { canvas, ctx };
}

async function canvasToJpegDataUri(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  quality: number,
): Promise<string> {
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return await blobToDataUri(blob);
  }
  return (canvas as HTMLCanvasElement).toDataURL('image/jpeg', quality);
}

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('blob read failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * 生成图片缩略图 data URI。
 * 结果超过 8KB 时按 THUMB_ATTEMPTS 逐级降质/缩小重试，最多 3 次；
 * 全部超限则返回最后一次结果（仍可用作占位）。失败返回空串（不阻塞发送）。
 */
export async function makeThumbnail(file: File, maxEdge = 320): Promise<string> {
  let bitmap: BitmapSource;
  try {
    bitmap = await loadBitmap(file);
  } catch (error) {
    console.warn('[media-encode] thumbnail source failed', error);
    return '';
  }
  const attempts =
    maxEdge === THUMB_ATTEMPTS[0].maxEdge
      ? THUMB_ATTEMPTS
      : [{ maxEdge, quality: 0.7 }, ...THUMB_ATTEMPTS.slice(1)];
  let lastUri = '';
  try {
    for (const attempt of attempts) {
      const { width, height } = computeThumbSize(bitmap.width, bitmap.height, attempt.maxEdge);
      const { canvas, ctx } = createCanvas(width, height);
      ctx.drawImage(bitmap.source, 0, 0, width, height);
      const uri = await canvasToJpegDataUri(canvas, attempt.quality);
      lastUri = uri;
      if (estimateDataUriBytes(uri) <= THUMB_LIMIT_BYTES) return uri;
    }
    return lastUri;
  } catch (error) {
    console.warn('[media-encode] thumbnail render failed', error);
    return lastUri;
  } finally {
    bitmap.dispose();
  }
}

// ---------------------------------------------------------------------------
// 波形
// ---------------------------------------------------------------------------

/**
 * 从单声道采样数据计算 bars 段峰值包络，归一化到 0-100 整数（纯函数）。
 * 全静音返回全 0。
 */
export function waveformFromChannelData(data: Float32Array, bars = 24): number[] {
  const n = Math.max(1, Math.floor(bars));
  const out = new Array<number>(n).fill(0);
  const length = data ? data.length : 0;
  if (length === 0) return out;

  const peaks = new Array<number>(n).fill(0);
  let maxPeak = 0;
  const seg = length / n;
  for (let i = 0; i < n; i += 1) {
    const start = Math.floor(i * seg);
    let end = Math.floor((i + 1) * seg);
    if (end <= start) end = start + 1;
    let peak = 0;
    for (let j = start; j < end && j < length; j += 1) {
      const value = Math.abs(data[j]);
      if (value > peak) peak = value;
    }
    peaks[i] = peak;
    if (peak > maxPeak) maxPeak = peak;
  }
  for (let i = 0; i < n; i += 1) {
    out[i] = maxPeak > 0 ? Math.round((peaks[i] / maxPeak) * 100) : 0;
  }
  return out;
}

/**
 * 解码音频文件并计算波形（24 段 0-100）。解码失败返回全 0 数组（不阻塞发送）。
 */
export async function makeWaveform(file: File, bars = 24): Promise<number[]> {
  try {
    const AudioCtor: typeof AudioContext | undefined =
      typeof AudioContext !== 'undefined'
        ? AudioContext
        : (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return new Array(bars).fill(0);
    const ctx = new AudioCtor();
    try {
      const buffer = await file.arrayBuffer();
      const audio = await ctx.decodeAudioData(buffer);
      return waveformFromChannelData(audio.getChannelData(0), bars);
    } finally {
      void ctx.close();
    }
  } catch (error) {
    console.warn('[media-encode] waveform decode failed', error);
    return new Array(bars).fill(0);
  }
}
