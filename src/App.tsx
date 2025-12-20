import { Canvas } from './components/Canvas/Canvas';
import { Controls } from './components/Controls/Controls';
import { Presence } from './components/Presence/Presence';
import { SessionBar } from './components/SessionBar/SessionBar';
import { useSessionSync } from './hooks/useSessionSync';
import { useAuth } from './hooks/useAuth';

function App() {
  useSessionSync();
  useAuth();

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Canvas />
      <SessionBar />
      <Presence />
      <Controls />
    </div>
  );
}

export default App;
