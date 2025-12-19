type Point = { x: number; y: number };

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

function bbox(points: Point[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

function polylineLength(points: Point[]) {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += dist(points[i - 1], points[i]);
  return len;
}

function pointLineDistance(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return dist(p, a);
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy), 0, 1);
  const proj = { x: a.x + t * dx, y: a.y + t * dy };
  return dist(p, proj);
}

function rdp(points: Point[], epsilon: number): Point[] {
  if (points.length <= 2) return points;
  const a = points[0];
  const b = points[points.length - 1];
  let maxD = -1;
  let idx = -1;
  for (let i = 1; i < points.length - 1; i++) {
    const d = pointLineDistance(points[i], a, b);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= epsilon) return [a, b];
  const left: Point[] = rdp(points.slice(0, idx + 1), epsilon);
  const right: Point[] = rdp(points.slice(idx), epsilon);
  return [...left.slice(0, -1), ...right];
}

function resample(points: Point[], step: number) {
  if (points.length < 2) return points;
  const out: Point[] = [points[0]];
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    let a = points[i - 1];
    const b = points[i];
    let seg = dist(a, b);
    if (seg === 0) continue;
    while (acc + seg >= step) {
      const t = (step - acc) / seg;
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      out.push(p);
      a = p;
      seg = dist(a, b);
      acc = 0;
    }
    acc += seg;
  }
  if (out.length === 1 || dist(out[out.length - 1], points[points.length - 1]) > step * 0.5) {
    out.push(points[points.length - 1]);
  }
  return out;
}

export function catmullRomToBezierPath(points: Point[]) {
  if (points.length < 2) return '';
  if (points.length === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;

    const cp1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const cp2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

function recognizeLine(points: Point[]) {
  if (points.length < 2) return null;
  const a = points[0];
  const b = points[points.length - 1];
  const chord = dist(a, b);
  const len = polylineLength(points);
  if (len < 30) return null;
  if (chord / len < 0.985) return null;
  let maxDev = 0;
  for (const p of points) maxDev = Math.max(maxDev, pointLineDistance(p, a, b));
  if (maxDev / len > 0.02) return null;
  return { a, b };
}

function recognizeCircle(points: Point[]) {
  if (points.length < 10) return null;
  const { minX, minY, maxX, maxY, w, h } = bbox(points);
  const diag = Math.hypot(w, h);
  if (diag < 60) return null;
  const close = dist(points[0], points[points.length - 1]);
  if (close / diag > 0.12) return null;
  const aspect = w / Math.max(h, 1e-6);
  if (aspect < 0.75 || aspect > 1.33) return null;

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rs = points.map((p) => Math.hypot(p.x - cx, p.y - cy));
  const r = rs.reduce((a, b) => a + b, 0) / rs.length;
  const variance = rs.reduce((a, b) => a + Math.pow(b - r, 2), 0) / rs.length;
  const std = Math.sqrt(variance);
  if (std / r > 0.18) return null;
  return { cx, cy, r };
}

function recognizeRect(points: Point[]) {
  if (points.length < 12) return null;
  const { minX, minY, maxX, maxY, w, h } = bbox(points);
  const diag = Math.hypot(w, h);
  if (diag < 60) return null;
  const close = dist(points[0], points[points.length - 1]);
  if (close / diag > 0.18) return null;

  const tol = diag * 0.035;
  let near = 0;
  for (const p of points) {
    const dLeft = Math.abs(p.x - minX);
    const dRight = Math.abs(p.x - maxX);
    const dTop = Math.abs(p.y - minY);
    const dBottom = Math.abs(p.y - maxY);
    const m = Math.min(dLeft, dRight, dTop, dBottom);
    if (m <= tol) near += 1;
  }
  if (near / points.length < 0.85) return null;
  if (w < 20 || h < 20) return null;
  return { minX, minY, maxX, maxY };
}

function sampleLine(a: Point, b: Point, step: number) {
  const len = dist(a, b);
  const n = Math.max(2, Math.ceil(len / step));
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return pts;
}

function sampleRect(r: { minX: number; minY: number; maxX: number; maxY: number }, step: number) {
  const { minX, minY, maxX, maxY } = r;
  const top = sampleLine({ x: minX, y: minY }, { x: maxX, y: minY }, step);
  const right = sampleLine({ x: maxX, y: minY }, { x: maxX, y: maxY }, step);
  const bottom = sampleLine({ x: maxX, y: maxY }, { x: minX, y: maxY }, step);
  const left = sampleLine({ x: minX, y: maxY }, { x: minX, y: minY }, step);
  return [...top, ...right.slice(1), ...bottom.slice(1), ...left.slice(1)];
}

function sampleCircle(c: { cx: number; cy: number; r: number }, step: number) {
  const circumference = 2 * Math.PI * c.r;
  const n = Math.max(16, Math.ceil(circumference / step));
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push({ x: c.cx + Math.cos(t) * c.r, y: c.cy + Math.sin(t) * c.r });
  }
  pts.push(pts[0]);
  return pts;
}

function circlePath(c: { cx: number; cy: number; r: number }) {
  const { cx, cy, r } = c;
  return `M ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} Z`;
}

function rectPath(r: { minX: number; minY: number; maxX: number; maxY: number }) {
  return `M ${r.minX} ${r.minY} L ${r.maxX} ${r.minY} L ${r.maxX} ${r.maxY} L ${r.minX} ${r.maxY} Z`;
}

export function beautifyStroke(rawPoints: Point[]) {
  if (rawPoints.length < 2) return { points: rawPoints, path: '' };

  // Normalize: resample & simplify for stable recognition & nicer curves.
  const sampled = resample(rawPoints, 6);
  const { w, h } = bbox(sampled);
  const diag = Math.hypot(w, h);
  const simplified = rdp(sampled, Math.max(1.5, diag * 0.01));

  const circle = recognizeCircle(simplified);
  if (circle) {
    const points = sampleCircle(circle, 18);
    return { points, path: circlePath(circle) };
  }

  const rect = recognizeRect(simplified);
  if (rect) {
    const points = sampleRect(rect, 18);
    return { points, path: rectPath(rect) };
  }

  const line = recognizeLine(simplified);
  if (line) {
    const points = sampleLine(line.a, line.b, 18);
    return { points, path: `M ${line.a.x} ${line.a.y} L ${line.b.x} ${line.b.y}` };
  }

  // Freehand: smooth via Catmull-Rom Beziers.
  const smoothPoints = resample(rawPoints, 4);
  const path = catmullRomToBezierPath(smoothPoints);
  return { points: smoothPoints, path };
}
