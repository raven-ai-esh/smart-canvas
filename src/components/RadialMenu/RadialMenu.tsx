import React from 'react';
import { PenTool, Eraser, Highlighter } from 'lucide-react';
import { useStore } from '../../store/useStore';
import type { PenToolType } from '../../types';

interface RadialMenuProps {
    onClose: () => void;
    position: { x: number; y: number };
}

export const RadialMenu: React.FC<RadialMenuProps> = ({ onClose, position }) => {
    const { setPenTool, penTool, penMode, togglePenMode } = useStore();

    const tools: { id: PenToolType; icon: React.ReactNode; label: string }[] = [
        { id: 'pen', icon: <PenTool size={20} />, label: 'Pen' },
        { id: 'highlighter', icon: <Highlighter size={20} />, label: 'Marker' },
        { id: 'eraser', icon: <Eraser size={20} />, label: 'Eraser' },
    ];

    console.log('[RadialMenu] Rendering at position:', position);

    const styles: React.CSSProperties = {
        position: 'fixed',
        left: position.x,
        top: position.y,
        transform: 'translate(-50%, -100%) translateY(-20px)',
        display: 'flex',
        gap: 12,
        padding: 8,
        background: 'var(--bg-node)',
        borderRadius: 30,
        boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
        border: '2px solid var(--accent-primary)',
        zIndex: 9999,
    };

    const handleSelect = (tool: PenToolType) => {
        setPenTool(tool);
        if (!penMode) togglePenMode();
        onClose();
    };

    return (
        <>
            <div
                style={{
                    position: 'fixed', inset: 0, zIndex: 199
                }}
                onClick={onClose}
            />
            <div style={styles}>
                {tools.map((tool) => (
                    <button
                        key={tool.id}
                        onClick={() => handleSelect(tool.id)}
                        title={tool.label}
                        style={{
                            background: penTool === tool.id ? 'var(--accent-primary)' : 'transparent',
                            border: 'none',
                            borderRadius: '50%',
                            width: 36,
                            height: 36,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: penTool === tool.id ? '#fff' : 'var(--text-primary)',
                            cursor: 'pointer',
                        }}
                    >
                        {tool.icon}
                    </button>
                ))}
            </div>
        </>
    );
};
