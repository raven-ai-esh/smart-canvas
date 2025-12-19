import { Canvas } from './components/Canvas/Canvas';
import { Controls } from './components/Controls/Controls';
import { Presence } from './components/Presence/Presence';
import { useSessionSync } from './hooks/useSessionSync';
import { useAuth } from './hooks/useAuth';
import { useStore } from './store/useStore';
import { SnowOverlay } from './components/Snow/SnowOverlay';

function App() {
  useSessionSync();
  useAuth();

  const snowEnabled = useStore((s) => s.snowEnabled);
  const theme = useStore((s) => s.theme);

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Canvas />
      <SnowOverlay enabled={snowEnabled} theme={theme} />
      <Presence />
      <Controls />
    </div>
  );
}

export default App;
