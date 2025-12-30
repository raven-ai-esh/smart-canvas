import { Canvas } from './components/Canvas/Canvas';
import { Controls } from './components/Controls/Controls';
import { Presence } from './components/Presence/Presence';
import { SessionBar } from './components/SessionBar/SessionBar';
import { AgentWidget } from './components/AgentWidget/AgentWidget';
import { LayersPanel } from './components/Layers/LayersPanel';
import { useEffect } from 'react';
import { useSessionSync } from './hooks/useSessionSync';
import { useAuth } from './hooks/useAuth';
import { useStore } from './store/useStore';

function App() {
  useSessionSync();
  useAuth();
  const sessionName = useStore((state) => state.sessionName);
  const sessionSaved = useStore((state) => state.sessionSaved);

  useEffect(() => {
    const baseTitle = 'Smart Tracker';
    if (sessionSaved && sessionName) {
      document.title = `${sessionName} — ${baseTitle}`;
    } else {
      document.title = baseTitle;
    }
  }, [sessionName, sessionSaved]);

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Canvas />
      <SessionBar />
      <Presence />
      <LayersPanel />
      <Controls />
      <AgentWidget />
    </div>
  );
}

export default App;
