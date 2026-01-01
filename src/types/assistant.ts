export type AssistantSelectionNode = {
  id: string;
  title: string;
  type: 'task' | 'idea';
  status?: 'queued' | 'in_progress' | 'done';
  progress?: number;
  energy?: number;
  layerId?: string;
  link?: string | null;
};

export type AssistantSelectionEdge = {
  id: string;
  source: string;
  target: string;
  sourceTitle?: string;
  targetTitle?: string;
  energyEnabled?: boolean;
};

export type AssistantSelectionTextBox = {
  id: string;
  kind?: 'text' | 'image' | 'file';
  text?: string;
  fileName?: string;
  fileMime?: string;
  fileSize?: number;
  layerId?: string;
};

export type AssistantSelectionComment = {
  id: string;
  text?: string;
  layerId?: string;
  targetKind?: 'canvas' | 'node' | 'edge' | 'textBox';
  targetId?: string | null;
};

export type AssistantSelectionContext = {
  sessionId?: string | null;
  nodes?: AssistantSelectionNode[];
  edges?: AssistantSelectionEdge[];
  textBoxes?: AssistantSelectionTextBox[];
  comments?: AssistantSelectionComment[];
};
