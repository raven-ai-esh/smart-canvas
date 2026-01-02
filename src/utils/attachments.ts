import type { Attachment } from '../types';

const DEFAULT_MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const envMax = Number(import.meta.env.VITE_MAX_ATTACHMENT_BYTES);
export const MAX_ATTACHMENT_BYTES = Number.isFinite(envMax) && envMax > 0 ? envMax : DEFAULT_MAX_ATTACHMENT_BYTES;

const uploadAttachment = async (file: File, sessionId: string) => {
  const form = new FormData();
  form.append('file', file, file.name || 'Attachment');
  form.append('sessionId', sessionId);
  const res = await fetch(`/api/attachments?sessionId=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    body: form,
    credentials: 'include',
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = typeof payload?.error === 'string' ? payload.error : 'upload_failed';
    throw new Error(err);
  }
  return {
    id: String(payload.id),
    url: String(payload.url),
    name: typeof payload.name === 'string' && payload.name.trim() ? payload.name : file.name || 'Attachment',
    size: Number.isFinite(payload.size) ? Number(payload.size) : file.size,
    mime: typeof payload.mime === 'string' && payload.mime.trim() ? payload.mime : (file.type || 'application/octet-stream'),
  };
};

export async function filesToAttachments(files: File[], sessionId?: string | null) {
  const attachments: Attachment[] = [];
  const rejected: File[] = [];
  const failed: File[] = [];

  if (!sessionId) {
    return { attachments, rejected, failed: files };
  }

  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      rejected.push(file);
      continue;
    }
    try {
      const uploaded = await uploadAttachment(file, sessionId);
      const isImage = uploaded.mime.toLowerCase().startsWith('image/');
      attachments.push({
        id: uploaded.id,
        kind: isImage ? 'image' : 'file',
        name: uploaded.name || (isImage ? 'Image' : 'Attachment'),
        size: uploaded.size,
        mime: uploaded.mime,
        url: uploaded.url,
      });
    } catch {
      failed.push(file);
    }
  }

  return { attachments, rejected, failed };
}

export const resolveAttachmentUrl = (url?: string | null, shareToken?: string | null) => {
  if (!url) return '';
  if (!shareToken) return url;
  if (url.startsWith('data:')) return url;
  if (typeof window === 'undefined') return url;
  try {
    const parsed = new URL(url, window.location.origin);
    if (!parsed.pathname.startsWith('/api/attachments/')) return url;
    if (parsed.searchParams.has('share') || parsed.searchParams.has('shareToken')) return url;
    parsed.searchParams.set('share', shareToken);
    return parsed.toString();
  } catch {
    return url;
  }
};

export const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Math.max(0, bytes);
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(value >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
};
