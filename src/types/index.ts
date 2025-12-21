export type NodeType = 'task' | 'idea';

export interface NodeData {
  id: string;
  title: string;
  content: string;
  type: NodeType;
  x: number;
  y: number;
  createdAt?: number; // epoch ms
  updatedAt?: number; // epoch ms
  // Visual state
  clarity: number; // 0-1
  energy: number; // 0-100 (base energy)
  // Task specific
  startDate?: string;
  endDate?: string;
  status?: 'queued' | 'in_progress' | 'done';
  progress?: number;
}

export interface EdgeData {
  id: string;
  source: string;
  target: string;
  type: 'default' | 'connection';
  createdAt?: number; // epoch ms
  updatedAt?: number; // epoch ms
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
