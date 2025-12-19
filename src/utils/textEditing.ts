export type TextSelection = { start: number; end: number };

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

export function wrapSelection(
  text: string,
  selection: TextSelection,
  prefix: string,
  suffix: string = prefix,
): { nextText: string; nextSelection: TextSelection } {
  const start = clamp(selection.start, 0, text.length);
  const end = clamp(selection.end, 0, text.length);
  const a = Math.min(start, end);
  const b = Math.max(start, end);

  const before = text.slice(0, a);
  const selected = text.slice(a, b);
  const after = text.slice(b);

  if (selected.length === 0) {
    const nextText = `${before}${prefix}${suffix}${after}`;
    const cursor = a + prefix.length;
    return { nextText, nextSelection: { start: cursor, end: cursor } };
  }

  const nextText = `${before}${prefix}${selected}${suffix}${after}`;
  return {
    nextText,
    nextSelection: { start: a + prefix.length, end: b + prefix.length },
  };
}

function lineRange(text: string, start: number, end: number) {
  const a = clamp(Math.min(start, end), 0, text.length);
  const b = clamp(Math.max(start, end), 0, text.length);
  const lineStart = text.lastIndexOf('\n', a - 1) + 1;
  const lineEndIdx = text.indexOf('\n', b);
  const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx;
  return { lineStart, lineEnd, a, b };
}

export function prefixLines(
  text: string,
  selection: TextSelection,
  prefix: string,
): { nextText: string; nextSelection: TextSelection } {
  const { lineStart, lineEnd, a, b } = lineRange(text, selection.start, selection.end);
  const before = text.slice(0, lineStart);
  const block = text.slice(lineStart, lineEnd);
  const after = text.slice(lineEnd);

  const lines = block.split('\n');
  const nextBlock = lines.map((line) => (line.length ? `${prefix}${line}` : line)).join('\n');
  const nextText = `${before}${nextBlock}${after}`;

  const addedPerLine = prefix.length;
  const affectedLines = lines.filter((l) => l.length).length;
  const totalAdded = affectedLines * addedPerLine;

  return {
    nextText,
    nextSelection: {
      start: a + (a >= lineStart ? addedPerLine : 0),
      end: b + totalAdded,
    },
  };
}

export function numberLines(
  text: string,
  selection: TextSelection,
  startAt: number = 1,
): { nextText: string; nextSelection: TextSelection } {
  const { lineStart, lineEnd, a, b } = lineRange(text, selection.start, selection.end);
  const before = text.slice(0, lineStart);
  const block = text.slice(lineStart, lineEnd);
  const after = text.slice(lineEnd);

  const lines = block.split('\n');
  let i = startAt;
  const nextLines = lines.map((line) => {
    if (!line.length) return line;
    const prefix = `${i}. `;
    i += 1;
    return `${prefix}${line}`;
  });
  const nextBlock = nextLines.join('\n');
  const nextText = `${before}${nextBlock}${after}`;

  // Approximate selection expansion: add first prefix near start, plus all prefixes across non-empty lines.
  const nonEmptyCount = lines.filter((l) => l.length).length;
  const firstPrefixLen = `${startAt}. `.length;
  // Average prefix length changes with digits; keep simple and safe.
  const added = nonEmptyCount * firstPrefixLen;

  return {
    nextText,
    nextSelection: {
      start: a + (a >= lineStart ? firstPrefixLen : 0),
      end: b + added,
    },
  };
}
