import { v4 as uuidv4 } from 'uuid';
import type { Attachment } from '../types';

export const MAX_ATTACHMENT_BYTES = 8_000_000;

const readFileAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('file_read_failed'));
    reader.readAsDataURL(file);
  });

export async function filesToAttachments(files: File[]) {
  const attachments: Attachment[] = [];
  const rejected: File[] = [];

  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      rejected.push(file);
      continue;
    }
    const dataUrl = await readFileAsDataUrl(file);
    const isImage = file.type.startsWith('image/');
    attachments.push({
      id: uuidv4(),
      kind: isImage ? 'image' : 'file',
      name: file.name || (isImage ? 'Image' : 'Attachment'),
      size: file.size,
      mime: file.type || 'application/octet-stream',
      dataUrl,
    });
  }

  return { attachments, rejected };
}

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
