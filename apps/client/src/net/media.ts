/**
 * 媒体上行与地址解析（对接服务端 mediasvc）。
 *
 * 服务端契约（server/internal/mediasvc/mediasvc.go，前端逐字对齐）：
 *   POST /api/media/upload  multipart/form-data, field "file"，Cookie 鉴权
 *     → 201 { media_id, size, mime, mtype }   （mtype: 1 image / 2 audio / 4 file）
 *     → 401 {error,code:"UNAUTHORIZED"} / 413 FILE_TOO_LARGE /
 *       415 UNSUPPORTED_TYPE / 429 RATE_LIMITED
 *   GET  /api/media/{media_id} → 原始字节（Content-Disposition: attachment）
 *
 * 客户端预检与服务端同源：magic bytes 白名单 + 扩展名一致 + 大小上限
 * （图片 8MB / 音频 2MB / 文件 20MB），限流 50 次/天由服务端执行。
 */
import type { Media, MediaType } from './proto/payload';

// ---------------------------------------------------------------------------
// 常量（与 mediasvc.go 逐字一致）
// ---------------------------------------------------------------------------

export const UPLOAD_LIMITS = {
  image: 8 * 1024 * 1024, // maxImageBytes
  audio: 2 * 1024 * 1024, // maxAudioBytes
  file: 20 * 1024 * 1024, // maxFileBytes
} as const;

export const DAILY_UPLOAD_LIMIT = 50; // 服务端 fixed-window，客户端仅提示

/** 与服务端 blockedExt 一致：可执行/脚本容器直接拒绝（SVG 是 XSS 向量）。 */
const BLOCKED_EXT = new Set([
  'exe', 'sh', 'bat', 'cmd', 'ps1', 'js', 'mjs', 'hta', 'jar', 'apk',
  'dll', 'scr', 'com', 'pif', 'svg', 'html', 'htm', 'php', 'py', 'pl',
]);

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
const AUDIO_EXT = new Set(['ogg', 'oga', 'opus', 'mp3']);

/** 服务端 magicTable 的镜像（offset, prefix, mtype）。 */
const MAGIC_TABLE: Array<{ offset: number; prefix: number[]; mtype: MediaMtype }> = [
  { offset: 0, prefix: [0xff, 0xd8, 0xff], mtype: 1 },
  { offset: 0, prefix: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mtype: 1 },
  { offset: 8, prefix: [0x57, 0x45, 0x42, 0x50], mtype: 1 }, // "WEBP"
  { offset: 0, prefix: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], mtype: 1 }, // GIF87a
  { offset: 0, prefix: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], mtype: 1 }, // GIF89a
  { offset: 0, prefix: [0x4f, 0x67, 0x67, 0x53], mtype: 2 }, // "OggS"
  { offset: 0, prefix: [0x49, 0x44, 0x33], mtype: 2 }, // "ID3"
  { offset: 0, prefix: [0xff, 0xfb], mtype: 2 },
];

export type MediaMtype = 1 | 2 | 4;

/**
 * wire mtype → 领域媒体类型。单一权威实现见 proto/payload.ts 的
 * mtypeToMediaType（含 video=3），此处转发，避免两处映射漂移。
 */
export { mtypeToMediaType } from './proto/payload';

/** Composer 的 accept：服务端白名单的并集（video 留 1.1）。 */
export const UPLOAD_ACCEPT = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'audio/ogg', 'audio/mpeg',
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.ogg', '.oga', '.opus', '.mp3',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.csv', '.zip',
].join(',');

// ---------------------------------------------------------------------------
// 错误码（与服务端 error.code 逐字对齐 + 客户端本地预检）
// ---------------------------------------------------------------------------

export type UploadErrorCode =
  | 'UNAUTHORIZED'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_TYPE'
  | 'RATE_LIMITED'
  | 'SERVER'
  | 'NETWORK';

export class MediaUploadError extends Error {
  constructor(public readonly code: UploadErrorCode, message: string) {
    super(message);
    this.name = 'MediaUploadError';
  }
}

// ---------------------------------------------------------------------------
// 客户端预检（与服务端 classify 同规则，提前给出可读提示）
// ---------------------------------------------------------------------------

export interface ClassifyResult {
  mtype: MediaMtype;
  mime: string;
}

const MIME_BY_MTYPE: Record<MediaMtype, string> = {
  1: 'image/*',
  2: 'audio/*',
  4: 'application/octet-stream',
};

/** 读文件头 magic bytes + 扩展名，按服务端规则分类/拒绝。 */
export async function classifyUpload(file: File): Promise<ClassifyResult> {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  if (BLOCKED_EXT.has(ext)) {
    throw new MediaUploadError('UNSUPPORTED_TYPE', `extension .${ext} blocked`);
  }
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  let mtype: MediaMtype | 0 = 0;
  for (const rule of MAGIC_TABLE) {
    if (head.length < rule.offset + rule.prefix.length) continue;
    const match = rule.prefix.every((byte, i) => head[rule.offset + i] === byte);
    if (!match) continue;
    mtype = rule.mtype;
    break;
  }
  if (mtype === 0) {
    if (!ext) throw new MediaUploadError('UNSUPPORTED_TYPE', 'unknown file type');
    mtype = 4;
  } else if (mtype === 1 && ext && !IMAGE_EXT.has(ext)) {
    throw new MediaUploadError('UNSUPPORTED_TYPE', 'extension does not match file content');
  } else if (mtype === 2 && ext && !AUDIO_EXT.has(ext)) {
    throw new MediaUploadError('UNSUPPORTED_TYPE', 'extension does not match file content');
  }
  const cap = mtype === 1 ? UPLOAD_LIMITS.image : mtype === 2 ? UPLOAD_LIMITS.audio : UPLOAD_LIMITS.file;
  if (file.size > cap) {
    throw new MediaUploadError('FILE_TOO_LARGE', `file exceeds ${cap} bytes`);
  }
  const mime = mtype === 4 ? file.type || MIME_BY_MTYPE[4] : file.type || MIME_BY_MTYPE[mtype];
  return { mtype, mime };
}

// ---------------------------------------------------------------------------
// 上传（XHR 以获得 upload.onprogress；同源 Cookie 自动携带）
// ---------------------------------------------------------------------------

export interface UploadResult {
  mediaId: string;
  size: number;
  mime: string;
  mtype: MediaMtype;
}

/**
 * 可选附加字段（与服务端 mediasvc 新契约对齐）：
 *  - thumbData：图片缩略图 base64 data URI（≤8KB）
 *  - waveform：24 个 0-100 整数（音频）
 */
export interface UploadExtras {
  thumbData?: string;
  waveform?: number[];
}

export function uploadMedia(
  file: File,
  onProgress?: (ratio: number) => void,
  extras?: UploadExtras,
): Promise<UploadResult> {
  if (isMockMode()) {
    return mockUpload(file, onProgress);
  }
  return new Promise<UploadResult>((resolve, reject) => {
    void (async () => {
      let classified: ClassifyResult;
      try {
        classified = await classifyUpload(file);
      } catch (error) {
        reject(error);
        return;
      }
      const form = new FormData();
      form.append('file', file, file.name);
      if (extras?.thumbData) form.append('thumb_data', extras.thumbData);
      if (extras?.waveform && extras.waveform.length > 0) {
        form.append('waveform', JSON.stringify(extras.waveform));
      }
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/media/upload');
      xhr.withCredentials = true;
      xhr.responseType = 'text';
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
      };
      xhr.onload = () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(xhr.responseText) as Record<string, unknown>;
        } catch {
          /* 非 JSON 响应走下面的通用分支 */
        }
        if (xhr.status >= 200 && xhr.status < 300 && typeof body.media_id === 'string') {
          resolve({
            mediaId: body.media_id,
            size: Number(body.size) || file.size,
            mime: typeof body.mime === 'string' ? body.mime : classified.mime,
            mtype: (Number(body.mtype) || classified.mtype) as MediaMtype,
          });
          return;
        }
        const code = typeof body.code === 'string' ? body.code : '';
        if (xhr.status === 401) reject(new MediaUploadError('UNAUTHORIZED', 'please sign in'));
        else if (xhr.status === 413 || code === 'FILE_TOO_LARGE')
          reject(new MediaUploadError('FILE_TOO_LARGE', 'file too large'));
        else if (xhr.status === 415 || code === 'UNSUPPORTED_TYPE')
          reject(new MediaUploadError('UNSUPPORTED_TYPE', 'file type not allowed'));
        else if (xhr.status === 429 || code === 'RATE_LIMITED')
          reject(new MediaUploadError('RATE_LIMITED', 'daily upload limit reached'));
        else reject(new MediaUploadError('SERVER', `upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new MediaUploadError('NETWORK', 'network error'));
      xhr.send(form);
    })();
  });
}

async function mockUpload(file: File, onProgress?: (ratio: number) => void): Promise<UploadResult> {
  const { mockUploadMedia } = await import('./mock/mockBridge');
  const result = await mockUploadMedia(file, onProgress);
  return result;
}

// ---------------------------------------------------------------------------
// 媒体地址解析（renderers 用）
// ---------------------------------------------------------------------------

/** mock 演示模式的内存 blob URL 注册表（mockBridge 上传/演示数据写入）。 */
const mockMediaUrls = new Map<string, string>();

export function registerMockMediaUrl(mediaId: string, url: string): void {
  mockMediaUrls.set(mediaId, url);
}

export function getMockMediaUrl(mediaId: string): string | undefined {
  return mockMediaUrls.get(mediaId);
}

export function isMockMode(): boolean {
  return typeof import.meta !== 'undefined' && import.meta.env?.VITE_MOCK === '1';
}

/**
 * 渲染地址优先级：
 *   1) 显式 url（data:/blob:/http…，mock 演示数据用）；
 *   2) mock 模式 → mockBridge 注册的内存 blob URL（media/{id}）；
 *   3) 真实模式 → GET /api/media/{media_id}（Cookie 鉴权）。
 */
export function resolveMediaUrl(media: Pick<Media, 'mediaId' | 'url'>): string | undefined {
  const url = media.url;
  if (url && /^(data:|blob:|https?:)/.test(url)) return url;
  if (isMockMode()) return getMockMediaUrl(media.mediaId);
  if (media.mediaId) return `/api/media/${encodeURIComponent(media.mediaId)}`;
  return url || undefined;
}
