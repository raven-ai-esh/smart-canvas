export type NodeType = 'task' | 'idea';

export interface Attachment {
  id: string;
  kind: 'image' | 'file';
  name: string;
  size: number;
  mime: string;
  dataUrl: string;
}

export interface NodeData {
  id: string;
  title: string;
  content: string;
  type: NodeType;
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
  attachments?: Attachment[];
}

export interface EdgeData {
  id: string;
  source: string;
  target: string;
  type: 'default' | 'connection';
  energyEnabled?: boolean;
  createdAt?: number; // epoch ms
  updatedAt?: number; // epoch ms
  authorId?: string | null;
  authorName?: string | null;
}

export type PenToolType = 'pen' | 'eraser' | 'highlighter';

export interface Drawing {
  id: string;
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
  x: number; // world
  y: number; // world
  width: number; // world
  height: number; // world
  text: string;
  kind?: 'text' | 'image';
  src?: string;
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
}

export interface CanvasState {
  x: number;
  y: number;
  scale: number;
}
