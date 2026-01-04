export type NodeType = 'task' | 'idea';

export interface LayerData {
  id: string;
  name: string;
  visible: boolean;
  createdAt?: number; // epoch ms
  updatedAt?: number; // epoch ms
}

export interface Attachment {
  id: string;
  kind: 'image' | 'file';
  name: string;
  size: number;
  mime: string;
  url?: string;
  dataUrl?: string;
}

export interface NodeData {
  id: string;
  title: string;
  content: string;
  type: NodeType;
  layerId?: string;
  zIndex?: number;
  x: number;
  y: number;
  createdAt?: number; // epoch ms
  updatedAt?: number; // epoch ms
  authorId?: string | null;
  authorName?: string | null;
  // Visual state
  clarity: number; // 0-1
  energy: number; // 0-100 (base energy)
  // Task specific
  startDate?: string;
  endDate?: string;
  status?: 'queued' | 'in_progress' | 'done';
  progress?: number;
  childProgress?: boolean;
  ganttY?: number;
  attachments?: Attachment[];
  mentions?: MentionToken[];
}

export interface EdgeData {
  id: string;
  source: string;
  target: string;
  type: 'default' | 'connection';
  energyEnabled?: boolean;
  sourceAnchor?: { x: number; y: number };
  targetAnchor?: { x: number; y: number };
  curveOffset?: { x: number; y: number };
  controlPoints?: EdgeControlPoint[];
  createdAt?: number; // epoch ms
  updatedAt?: number; // epoch ms
  authorId?: string | null;
  authorName?: string | null;
}

export interface EdgeControlPoint {
  id: string;
  t: number; // 0-1 along base curve
  offset: { x: number; y: number };
}

export type PenToolType = 'pen' | 'eraser' | 'highlighter';

export interface Drawing {
  id: string;
  layerId?: string;
  points: { x: number; y: number }[];
  path?: string; // beautified SVG path
  color: string;
  width: number;
  opacity: number;
  tool: PenToolType;
  createdAt?: number; // epoch ms
  updatedAt?: number; // epoch ms
  authorId?: string | null;
  authorName?: string | null;
}

export interface TextBox {
  id: string;
  layerId?: string;
  zIndex?: number;
  x: number; // world
  y: number; // world
  width: number; // world
  height: number; // world
  text: string;
  kind?: 'text' | 'image' | 'file';
  src?: string;
  fileName?: string;
  fileMime?: string;
  fileSize?: number;
  createdAt?: number; // epoch ms
  updatedAt?: number; // epoch ms
  authorId?: string | null;
  authorName?: string | null;
}

export interface Comment {
  id: string;
  targetKind: 'canvas' | 'node' | 'edge' | 'textBox';
  targetId?: string | null;
  parentId?: string | null;
  layerId?: string;
  zIndex?: number;
  x?: number; // world (for canvas comments)
  y?: number; // world (for canvas comments)
  text: string;
  attachments?: Attachment[];
  createdAt?: number; // epoch ms
  updatedAt?: number; // epoch ms
  authorId?: string | null;
  authorName?: string | null;
  avatarUrl?: string | null;
  avatarAnimal?: number | null;
  avatarColor?: number | null;
}

export interface Tombstones {
  nodes: Record<string, number>;
  edges: Record<string, number>;
  drawings: Record<string, number>;
  textBoxes: Record<string, number>;
  comments: Record<string, number>;
  layers: Record<string, number>;
}

export interface CanvasState {
  x: number;
  y: number;
  scale: number;
}

export interface MentionToken {
  id: string;
  label: string;
}

export interface SessionSaver {
  id: string;
  name: string;
  email: string;
  avatarSeed: string;
  avatarUrl?: string | null;
  avatarAnimal?: number | null;
  avatarColor?: number | null;
  savedAt?: string | null;
}
