/// <reference lib="webworker" />

const MAX_TEXT_CHARS = 50_000;
const MAX_MARKDOWN_CHARS = 30_000;
const MAX_HTML_CHARS = 80_000;
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_CSV_BYTES = 512 * 1024;
const MAX_DOCX_PREVIEW_BYTES = 6 * 1024 * 1024;
const MAX_XLSX_PREVIEW_BYTES = 6 * 1024 * 1024;
const MAX_ROWS = 200;
const MAX_COLS = 30;

const isDataUrl = (value: string) => value.startsWith('data:');

const dataUrlToText = (dataUrl: string) => {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) return '';
  const meta = dataUrl.slice(0, commaIdx);
  const payload = dataUrl.slice(commaIdx + 1);
  if (meta.includes(';base64')) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(bytes);
  }
  return decodeURIComponent(payload);
};

const dataUrlToArrayBuffer = (dataUrl: string) => {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) return new ArrayBuffer(0);
  const meta = dataUrl.slice(0, commaIdx);
  const payload = dataUrl.slice(commaIdx + 1);
  if (meta.includes(';base64')) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
  const text = decodeURIComponent(payload);
  return new TextEncoder().encode(text).buffer;
};

const sourceToText = async (src: string, maxBytes?: number) => {
  if (isDataUrl(src)) return { text: dataUrlToText(src), truncated: false };
  const res = await fetch(src, { credentials: 'include' });
  if (!res.ok) throw new Error('preview_fetch_failed');
  if (!maxBytes || !res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    return { text, truncated: false };
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      const nextTotal = total + value.length;
      if (nextTotal > maxBytes) {
        const remaining = Math.max(0, maxBytes - total);
        if (remaining > 0) {
          chunks.push(value.slice(0, remaining));
          total += remaining;
        }
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        break;
      }
      chunks.push(value);
      total = nextTotal;
    }
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  const text = new TextDecoder('utf-8').decode(buffer);
  return { text, truncated };
};

const sourceToArrayBuffer = async (src: string) => {
  if (isDataUrl(src)) return dataUrlToArrayBuffer(src);
  const res = await fetch(src, { credentials: 'include' });
  if (!res.ok) throw new Error('preview_fetch_failed');
  return res.arrayBuffer();
};

const truncateText = (value: string, maxChars = MAX_TEXT_CHARS) => {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(0, maxChars), truncated: true };
};

const limitRows = (rows: unknown[][]) => {
  const limited = rows.slice(0, MAX_ROWS).map((row) =>
    row.slice(0, MAX_COLS).map((cell) => (cell == null ? '' : String(cell))),
  );
  const truncated = rows.length > MAX_ROWS || rows.some((row) => row.length > MAX_COLS);
  return { rows: limited, truncated };
};

const parseCsvRows = (input: string) => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char === '"') {
      const nextChar = input[i + 1];
      if (inQuotes && nextChar === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === '\r') continue;
    if (char === '\n' && !inQuotes) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (rows.length >= MAX_ROWS) break;
      continue;
    }
    if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
      if (row.length >= MAX_COLS) {
        rows.push(row);
        row = [];
        cell = '';
        if (rows.length >= MAX_ROWS) break;
      }
      continue;
    }
    cell += char;
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return limitRows(rows);
};

type WorkerRequest = {
  id: string;
  src: string;
  fileName?: string;
  fileMime?: string;
  fileSize?: number | null;
  kind: string;
};

const ctx = self as DedicatedWorkerGlobalScope;

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const data = event.data as WorkerRequest;
  if (!data || !data.id || !data.src) return;

  const id = data.id;
  const src = data.src;
  const fileName = typeof data.fileName === 'string' ? data.fileName : '';
  const fileMime = typeof data.fileMime === 'string' ? data.fileMime : '';
  const kind = data.kind;
  const ext = (() => {
    const trimmed = fileName.trim();
    const idx = trimmed.lastIndexOf('.');
    if (idx === -1) return '';
    return trimmed.slice(idx + 1).toLowerCase();
  })();
  const mime = fileMime.toLowerCase();
  const isMarkdown = kind === 'markdown' || ext === 'md' || mime === 'text/markdown' || mime === 'text/x-markdown';
  const isText = kind === 'text' || ext === 'txt' || mime.startsWith('text/plain');
  const isJson = kind === 'json' || ext === 'json' || mime === 'application/json';
  const isCsv = kind === 'csv' || ext === 'csv' || mime === 'text/csv';
  const isDocx = kind === 'docx' || ext === 'docx' || mime.includes('wordprocessingml');
  const isXlsx = kind === 'xlsx' || ext === 'xlsx' || mime.includes('spreadsheet') || mime.includes('excel');

  try {
    if (isMarkdown || isText) {
      const raw = await sourceToText(src, MAX_TEXT_BYTES);
      const { text, truncated } = truncateText(raw.text, isMarkdown ? MAX_MARKDOWN_CHARS : MAX_TEXT_CHARS);
      ctx.postMessage({ id, status: 'ready', kind: isMarkdown ? 'markdown' : 'text', text, truncated: truncated || raw.truncated });
      return;
    }
    if (isJson) {
      const raw = await sourceToText(src, MAX_TEXT_BYTES);
      const trimmed = truncateText(raw.text);
      if (trimmed.truncated) {
        ctx.postMessage({ id, status: 'ready', kind: 'json', text: trimmed.text, truncated: true });
        return;
      }
      let text = raw.text;
      try {
        text = JSON.stringify(JSON.parse(raw.text), null, 2);
      } catch {
        // Keep raw JSON if parsing fails.
      }
      const limited = truncateText(text);
      ctx.postMessage({ id, status: 'ready', kind: 'json', text: limited.text, truncated: limited.truncated || raw.truncated });
      return;
    }
    if (isCsv) {
      const raw = await sourceToText(src, MAX_CSV_BYTES);
      const { rows, truncated } = parseCsvRows(raw.text);
      ctx.postMessage({ id, status: 'ready', kind: 'table', rows, truncated: truncated || raw.truncated });
      return;
    }
    if (isDocx) {
      if (Number.isFinite(data.fileSize) && data.fileSize && data.fileSize > MAX_DOCX_PREVIEW_BYTES) {
        ctx.postMessage({ id, status: 'error', message: 'Preview is disabled for large .docx files. Download instead.' });
        return;
      }
      const buffer = await sourceToArrayBuffer(src);
      const mammothModule: any = await import('mammoth/mammoth.browser');
      const convert = typeof mammothModule.convertToHtml === 'function'
        ? mammothModule.convertToHtml
        : mammothModule.default?.convertToHtml;
      if (!convert) throw new Error('docx_preview_unavailable');
      const result = await convert({ arrayBuffer: buffer });
      const html = String(result?.value ?? '');
      if (html.length > MAX_HTML_CHARS) {
        ctx.postMessage({ id, status: 'error', message: 'Preview is too large. Download the file instead.' });
        return;
      }
      ctx.postMessage({ id, status: 'ready', kind: 'html', html });
      return;
    }
    if (isXlsx) {
      if (Number.isFinite(data.fileSize) && data.fileSize && data.fileSize > MAX_XLSX_PREVIEW_BYTES) {
        ctx.postMessage({ id, status: 'error', message: 'Preview is disabled for large .xlsx files. Download instead.' });
        return;
      }
      const buffer = await sourceToArrayBuffer(src);
      const xlsxModule: any = await import('xlsx');
      const XLSX = xlsxModule.default ?? xlsxModule;
      if (!XLSX.read || !XLSX.utils?.sheet_to_json) throw new Error('xlsx_preview_unavailable');
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheetName = workbook.SheetNames?.[0];
      if (!sheetName) throw new Error('xlsx_preview_empty');
      const sheet = workbook.Sheets[sheetName];
      const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false }) as unknown[][];
      const { rows, truncated } = limitRows(rawRows);
      ctx.postMessage({ id, status: 'ready', kind: 'table', rows, truncated });
      return;
    }
    ctx.postMessage({ id, status: 'error', message: 'Preview is not available for this file type.' });
  } catch {
    ctx.postMessage({ id, status: 'error', message: 'Failed to load preview.' });
  }
};
