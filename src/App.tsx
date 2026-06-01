import { useEffect, useState, useCallback, useRef } from 'react';
import MissionPanel from './MissionPanel';
import RoverMap from './RoverMap';

const DEFAULT_IP = (import.meta as any).env?.VITE_JETSON_IP || '192.168.1.100';
function getJetsonIP(): string {
  return localStorage.getItem('rovssa_jetson_ip') || DEFAULT_IP;
}

interface TelemetryData {
  pitch: number;
  roll: number;
  yaw: number;
  distancia_frontal: number;
  distancia_izquierda: number;
  distancia_derecha: number;
  gps?: {
    fix: boolean;
    lat: number;
    lon: number;
    alt: number;
    sats: number;
    speed_ms: number;
  };
}

interface PicoTelemetry {
  arm: {
    enc_FL?: number;
    enc_FR?: number;
    enc_RL?: number;
    enc_RR?: number;
    pico_connected?: boolean;
  };
  odom: { x: number; y: number; theta: number };
  mode: string;
  ch?: number[];
}

type RoverMode = 'MANUAL' | 'AI';

const DRIVE_VX    = 0.7;
const DRIVE_OMEGA = 0.6;

function App() {
  const [jetsonIP, setJetsonIP]         = useState<string>(getJetsonIP());
  const [showSettings, setShowSettings] = useState(false);
  const [ipInput, setIpInput]           = useState<string>(getJetsonIP());

  const [telemetry, setTelemetry] = useState<TelemetryData>({
    pitch: 0, roll: 0, yaw: 0,
    distancia_frontal: 5.0,
    distancia_izquierda: 5.0,
    distancia_derecha: 5.0,
  });

  const [picoTelemetry, setPicoTelemetry] = useState<PicoTelemetry>({
    arm: {},
    odom: { x: 0, y: 0, theta: 0 },
    mode: 'GCS',
    ch: [1500, 1500, 1500, 1500, 1500, 1500],
  });

  const [isConnected, setIsConnected]         = useState(false);
  const [isPicoConnected, setIsPicoConnected] = useState(false);
  const [roverMode, setRoverMode]             = useState<RoverMode>('MANUAL');
  const [isEStopActive, setIsEStopActive]     = useState(false);
  const [armCamError, setArmCamError]         = useState(false);

  const keysRef      = useRef<Set<string>>(new Set());
  const driveLoopRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [activeKeys, setActiveKeys] = useState<Set<string>>(new Set());

  const [logs, setLogs] = useState<string[]>([
    `[BOOT] ROVSSA Control System iniciado`,
    `[CFG]  Jetson IP: ${getJetsonIP()}`,
  ]);
  const addLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString();
    setLogs(prev => [`[${ts}] ${msg}`, ...prev].slice(0, 30));
  }, []);

  useEffect(() => {
    let es: EventSource;
    let retryTimer: ReturnType<typeof setTimeout>;
    const connect = () => {
      es = new EventSource(`http://${jetsonIP}:8000/telemetry`);
      es.onopen    = () => { setIsConnected(true); addLog('Rover SSE conectado'); };
      es.onmessage = (e) => { try { setTelemetry(JSON.parse(e.data)); } catch {} };
      es.onerror   = () => { setIsConnected(false); es.close(); retryTimer = setTimeout(connect, 3000); };
    };
    connect();
    return () => { es?.close(); clearTimeout(retryTimer); };
  }, [jetsonIP, addLog]);

  useEffect(() => {
    let es: EventSource;
    let retryTimer: ReturnType<typeof setTimeout>;
    const connect = () => {
      es = new EventSource(`http://${jetsonIP}:8000/arm_telemetry`);
      es.onopen    = () => setIsPicoConnected(true);
      es.onmessage = (e) => {
        try {
          const data: PicoTelemetry = JSON.parse(e.data);
          setPicoTelemetry(data);
          setIsPicoConnected(!!data.arm?.pico_connected);
        } catch {}
      };
      es.onerror = () => { setIsPicoConnected(false); es.close(); retryTimer = setTimeout(connect, 3000); };
    };
    connect();
    return () => { es?.close(); clearTimeout(retryTimer); };
  }, [jetsonIP]);

  useEffect(() => { setArmCamError(false); }, [jetsonIP]);

  const sendCommand = useCallback(async (cmd: object) => {
    try {
      await fetch(`http://${jetsonIP}:8000/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cmd),
      });
    } catch {}
  }, [jetsonIP]);

  const handleEStop = useCallback(() => {
    const next = !isEStopActive;
    setIsEStopActive(next);
    sendCommand({ cmd: next ? 'estop' : 'estop_release' });
    addLog(next ? '🛑 E-STOP ACTIVADO' : '✅ E-STOP liberado');
  }, [isEStopActive, sendCommand, addLog]);

  const handleModeChange = useCallback((mode: RoverMode) => {
    setRoverMode(mode);
    sendCommand({ cmd: 'set_mode', mode });
    addLog(`Modo → ${mode}`);
  }, [sendCommand, addLog]);

  const computeDriveFromKeys = useCallback(() => {
    const keys = keysRef.current;
    let vx = 0, omega = 0;
    if (keys.has('w') || keys.has('ArrowUp'))    vx    += DRIVE_VX;
    if (keys.has('s') || keys.has('ArrowDown'))  vx    -= DRIVE_VX;
    if (keys.has('a') || keys.has('ArrowLeft'))  omega -= DRIVE_OMEGA;
    if (keys.has('d') || keys.has('ArrowRight')) omega += DRIVE_OMEGA;
    return { vx, omega };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const key = e.key;
      if (['w','a','s','d','ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(key)) e.preventDefault();
      if (key === ' ')                { sendCommand({ cmd: 'stop' }); return; }
      if (key === 'r' || key === 'R') { sendCommand({ cmd: 'reset_odom' }); addLog('Odometría reseteada'); return; }
      if (key === 'e' || key === 'E') { handleEStop(); return; }
      if (!keysRef.current.has(key))  { keysRef.current.add(key); setActiveKeys(new Set(keysRef.current)); }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keysRef.current.delete(e.key);
      setActiveKeys(new Set(keysRef.current));
      const movKeys = ['w','a','s','d','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'];
      if (!movKeys.some(k => keysRef.current.has(k))) {
        if (roverMode === 'MANUAL' && !isEStopActive) sendCommand({ cmd: 'stop' });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup',   onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup',   onKeyUp);
    };
  }, [roverMode, isEStopActive, sendCommand, handleEStop, addLog]);

  useEffect(() => {
    if (driveLoopRef.current) clearInterval(driveLoopRef.current);
    driveLoopRef.current = setInterval(() => {
      if (roverMode !== 'MANUAL' || isEStopActive) return;
      const { vx, omega } = computeDriveFromKeys();
      if (vx !== 0 || omega !== 0) sendCommand({ cmd: 'drive', vx, omega });
    }, 100);
    return () => { if (driveLoopRef.current) clearInterval(driveLoopRef.current); };
  }, [roverMode, isEStopActive, sendCommand, computeDriveFromKeys]);

  const saveIP = () => {
    localStorage.setItem('rovssa_jetson_ip', ipInput);
    setJetsonIP(ipInput);
    setShowSettings(false);
    addLog(`IP cambiada → ${ipInput}`);
  };

  const distFrontal = telemetry?.distancia_frontal ?? 5.0;
  const distPct     = Math.min((distFrontal / 5.0) * 100, 100);
  const distColor   = distFrontal < 0.5 ? 'bg-red-500' : distFrontal < 1.5 ? 'bg-yellow-400' : 'bg-green-500';
  const encFL = picoTelemetry.arm?.enc_FL ?? 0;
  const encFR = picoTelemetry.arm?.enc_FR ?? 0;
  const encRL = picoTelemetry.arm?.enc_RL ?? 0;
  const encRR = picoTelemetry.arm?.enc_RR ?? 0;
  const isKeyActive = (keys: string[]) => keys.some(k => activeKeys.has(k));

  // Altura compartida: cámaras y mapa GPS usan la misma variable
  // Las cámaras ocupan la fila superior, el GPS ocupa el espacio restante del aside
  // Todo dentro de un grid donde el aside tiene height fija y el GPS llena lo que sobra

  return (
    <div className="bg-slate-950 text-slate-300 font-mono p-3 min-h-screen selection:bg-green-900 selection:text-green-400">

      {/* ── MODAL SETTINGS ── */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center">
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 w-80 shadow-2xl">
            <h2 className="text-sm font-bold text-white uppercase tracking-widest mb-4">⚙ Configuración</h2>
            <label className="text-[10px] text-slate-400 uppercase tracking-widest block mb-1">IP de la Jetson Nano</label>
            <input type="text" value={ipInput} onChange={e => setIpInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && saveIP()} placeholder="192.168.1.100"
              className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-green-600 mb-4" />
            <div className="flex gap-2">
              <button onClick={saveIP} className="flex-1 bg-green-700 hover:bg-green-600 text-white text-xs font-bold py-2 rounded uppercase tracking-wider">Guardar</button>
              <button onClick={() => setShowSettings(false)} className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold py-2 rounded uppercase tracking-wider">Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {/* ── HEADER ── */}
      <header className="flex justify-between items-center border-b border-slate-800 pb-2 mb-3">
        <div className="flex items-center gap-4">
          <h1 className="text-base font-black tracking-tighter text-white">
            ROVSSA <span className="text-green-500">//</span> MISSION CONTROL
          </h1>
          <span className="text-[9px] text-slate-600 uppercase tracking-widest hidden sm:block">
            IAA 2026 · {jetsonIP}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
            <span className={`text-[10px] font-bold ${isConnected ? 'text-green-400' : 'text-red-400'}`}>
              {isConnected ? 'JETSON' : 'SIN SEÑAL'}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${isPicoConnected ? 'bg-yellow-400 animate-pulse' : 'bg-red-500'}`} />
            <span className={`text-[10px] font-bold ${isPicoConnected ? 'text-yellow-400' : 'text-red-400'}`}>PICO</span>
          </div>
          <span className={`text-[10px] font-bold ${picoTelemetry.mode === 'RC' ? 'text-orange-400' : 'text-blue-400'}`}>
            {picoTelemetry.mode}
          </span>
          <div className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${telemetry.gps?.fix ? 'bg-blue-400 animate-pulse' : 'bg-slate-600'}`} />
            <span className={`text-[10px] font-bold ${telemetry.gps?.fix ? 'text-blue-400' : 'text-slate-600'}`}>
              {telemetry.gps?.fix ? `GPS ${telemetry.gps.sats}sat` : 'GPS –'}
            </span>
          </div>
          <button onClick={() => setShowSettings(true)} className="text-slate-500 hover:text-white transition-colors px-1">⚙</button>
        </div>
      </header>

      {/* ── LAYOUT PRINCIPAL ──
          Grid 12 col:
            CAM-01 (4col) | CAM-02 (4col) | aside-control+GPS (4col)
          El aside usa flex-col: widgets de control arriba, GPS mapa llena el resto con flex-1
      ── */}
      <div className="grid grid-cols-12 gap-3 mb-3" style={{ height: '72vh' }}>

        {/* CAM-01 CSI — ocupa toda la altura del grid */}
        <div className="col-span-4 bg-black rounded-lg border border-slate-800 overflow-hidden relative h-full">
          <div className="absolute top-2 left-2 z-10 bg-black/60 px-2 py-0.5 rounded text-[9px] text-green-500 border border-green-900 uppercase tracking-widest">
            CAM-01 · CSI
          </div>
          {isEStopActive && (
            <div className="absolute inset-0 z-20 bg-red-900/40 flex items-center justify-center">
              <span className="text-red-400 font-black text-lg tracking-widest animate-pulse">⛔ E-STOP</span>
            </div>
          )}
          <img
            src={`http://${jetsonIP}:8000/video_feed`}
            alt="FPV"
            className={`w-full h-full object-cover ${isEStopActive ? 'grayscale' : ''}`}
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        </div>

        {/* CAM-02 USB Brazo — ocupa toda la altura del grid */}
        <div className="col-span-4 bg-black rounded-lg border border-slate-800 overflow-hidden relative h-full">
          <div className="absolute top-2 left-2 z-10 bg-black/60 px-2 py-0.5 rounded text-[9px] text-cyan-400 border border-cyan-900 uppercase tracking-widest">
            CAM-02 · BRAZO
          </div>
          {isEStopActive && (
            <div className="absolute inset-0 z-20 bg-red-900/40 flex items-center justify-center">
              <span className="text-red-400 font-black text-sm tracking-widest animate-pulse">⛔ E-STOP</span>
            </div>
          )}
          {!armCamError ? (
            <img
              src={`http://${jetsonIP}:8000/camera_usb`}
              alt="Brazo USB"
              className={`w-full h-full object-contain ${isEStopActive ? 'grayscale' : ''}`}
              onError={() => setArmCamError(true)}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-2 text-slate-600">
              <svg className="w-8 h-8 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
              </svg>
              <span className="text-[9px] uppercase opacity-50">Sin señal</span>
              <button onClick={() => setArmCamError(false)}
                className="text-[9px] text-cyan-700 hover:text-cyan-500 border border-cyan-900 hover:border-cyan-700 px-2 py-0.5 rounded transition-colors uppercase">
                Reintentar
              </button>
            </div>
          )}
        </div>

        {/* ── Aside: Control + GPS mapa (4 col, misma altura que cámaras) ── */}
        <aside className="col-span-4 flex flex-col gap-2 h-full min-h-0">

          {/* Control de modo */}
          <div className="bg-slate-900 border border-slate-800 p-3 rounded-lg flex-shrink-0">
            <div className="flex gap-2 mb-2">
              {(['MANUAL', 'AI'] as RoverMode[]).map((mode) => (
                <button key={mode} onClick={() => handleModeChange(mode)}
                  className={`flex-1 py-1.5 text-[10px] font-bold rounded uppercase tracking-wider transition-colors ${
                    roverMode === mode
                      ? 'bg-green-900/50 text-green-400 border border-green-700'
                      : 'bg-slate-950 text-slate-500 border border-slate-800 hover:bg-slate-800'
                  }`}>
                  {mode}
                </button>
              ))}
            </div>
            <button onClick={handleEStop}
              className={`w-full py-2 rounded text-xs font-black uppercase tracking-widest transition-all ${
                isEStopActive
                  ? 'bg-red-600 text-white animate-pulse'
                  : 'bg-red-950/50 text-red-500 border border-red-900 hover:bg-red-900/30'
              }`}>
              {isEStopActive ? '⛔ DETENIDO — PULSAR PARA LIBERAR' : 'PARADA DE EMERGENCIA [E]'}
            </button>
          </div>

          {/* GPS datos numéricos */}
          <div className="bg-slate-900 border border-slate-800 p-3 rounded-lg flex-shrink-0">
            <h3 className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mb-2">
              GPS — NEO-M8N
              <span className={`ml-2 font-bold ${telemetry.gps?.fix ? 'text-green-400' : 'text-red-400'}`}>
                {telemetry.gps?.fix ? `✓ FIX (${telemetry.gps.sats} sats)` : '✗ SIN FIX'}
              </span>
            </h3>
            <div className="grid grid-cols-4 gap-1 text-center">
              {[
                { label: 'LAT', val: telemetry.gps?.fix ? telemetry.gps.lat.toFixed(5)              : '---' },
                { label: 'LON', val: telemetry.gps?.fix ? telemetry.gps.lon.toFixed(5)              : '---' },
                { label: 'ALT', val: telemetry.gps?.fix ? `${telemetry.gps.alt.toFixed(0)}m`       : '---' },
                { label: 'VEL', val: telemetry.gps?.fix ? `${telemetry.gps.speed_ms.toFixed(1)}m/s`: '---' },
              ].map(({ label, val }) => (
                <div key={label} className="bg-slate-950 border border-slate-800 p-1.5 rounded">
                  <div className="text-[8px] text-slate-600 mb-0.5">{label}</div>
                  <div className={`font-bold text-[10px] ${telemetry.gps?.fix ? 'text-slate-200' : 'text-slate-600'}`}>{val}</div>
                </div>
              ))}
            </div>
          </div>

          {/* IMU */}
          <div className="bg-slate-900 border border-slate-800 p-3 rounded-lg flex-shrink-0">
            <h3 className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mb-2">IMU — BNO085</h3>
            <div className="grid grid-cols-3 gap-1.5 text-center">
              {[
                { label: 'PITCH', val: telemetry?.pitch ?? 0 },
                { label: 'ROLL',  val: telemetry?.roll  ?? 0 },
                { label: 'YAW',   val: telemetry?.yaw   ?? 0 },
              ].map(({ label, val }) => (
                <div key={label} className="bg-slate-950 border border-slate-800 p-1.5 rounded">
                  <div className="text-[8px] text-slate-600 mb-0.5">{label}</div>
                  <div className={`font-bold text-xs ${Math.abs(val) > 30 ? 'text-yellow-400' : 'text-slate-200'}`}>
                    {val.toFixed(1)}°
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Sonar */}
          <div className="bg-slate-900 border border-slate-800 p-3 rounded-lg flex-shrink-0">
            <h3 className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mb-2">SONAR — HC-SR04</h3>
            <div className="grid grid-cols-3 gap-1.5 text-center mb-2">
              {[
                { label: 'IZQ',   val: telemetry?.distancia_izquierda ?? 0 },
                { label: 'FRONT', val: telemetry?.distancia_frontal   ?? 0 },
                { label: 'DER',   val: telemetry?.distancia_derecha   ?? 0 },
              ].map(({ label, val }) => (
                <div key={label} className={`bg-slate-950 border p-1.5 rounded ${val < 0.5 ? 'border-red-800' : val < 1.5 ? 'border-yellow-800' : 'border-slate-800'}`}>
                  <div className="text-[8px] text-slate-600 mb-0.5">{label}</div>
                  <div className={`font-bold text-xs ${val < 0.5 ? 'text-red-400' : val < 1.5 ? 'text-yellow-400' : 'text-slate-200'}`}>
                    {val.toFixed(2)}m
                  </div>
                </div>
              ))}
            </div>
            <div className="w-full bg-slate-950 h-1.5 rounded-full overflow-hidden border border-slate-800">
              <div className={`h-full transition-all duration-150 ${distColor}`} style={{ width: `${distPct}%` }} />
            </div>
          </div>

          {/* Teclado — solo MANUAL */}
          {roverMode === 'MANUAL' && (
            <div className="bg-slate-900 border border-slate-800 p-3 rounded-lg flex-shrink-0">
              <h3 className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mb-2">Teclado</h3>
              <div className="flex flex-col items-center gap-1">
                <div className="flex gap-1">
                  <div className={`w-8 h-8 rounded border text-[10px] font-bold flex items-center justify-center transition-colors ${
                    isKeyActive(['w','ArrowUp']) ? 'bg-green-700 text-white border-green-500' : 'bg-slate-950 text-slate-500 border-slate-700'
                  }`}>▲</div>
                </div>
                <div className="flex gap-1">
                  {[['a','ArrowLeft','◄'],['s','ArrowDown','▼'],['d','ArrowRight','►']].map(([k1,k2,lbl]) => (
                    <div key={k1} className={`w-8 h-8 rounded border text-[10px] font-bold flex items-center justify-center transition-colors ${
                      isKeyActive([k1, k2]) ? 'bg-green-700 text-white border-green-500' : 'bg-slate-950 text-slate-500 border-slate-700'
                    }`}>{lbl}</div>
                  ))}
                </div>
                <div className="text-[8px] text-slate-700 mt-1">WASD · Espacio=stop · E=Estop · R=reset</div>
              </div>
            </div>
          )}

          {/* GPS MAPA — flex-1 llena todo el espacio restante del aside */}
          <div className="flex-1 min-h-0 bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
            <RoverMap
              lat={telemetry.gps?.lat ?? 0}
              lon={telemetry.gps?.lon ?? 0}
              yaw={telemetry.yaw ?? 0}
              fix={telemetry.gps?.fix ?? false}
              sats={telemetry.gps?.sats ?? 0}
            />
          </div>

        </aside>
      </div>

      {/* ── PANEL MODO AI ── */}
      {roverMode === 'AI' && (
        <div className="relative z-10 mb-3">
          <MissionPanel
            jetsonIP={jetsonIP}
            telemetryGps={telemetry.gps}
            addLog={addLog}
          />
        </div>
      )}

      {/* ── ENCODERS + ODOMETRÍA + TERMINAL ── */}
      <section className="grid grid-cols-12 gap-3">

        {/* Encoders */}
        <div className="col-span-4 bg-slate-900 border border-slate-800 p-3 rounded-lg">
          <h3 className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mb-2">
            Encoders — Pico RP2040 · {picoTelemetry.mode}
          </h3>
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: 'FL', val: encFL },
              { label: 'FR', val: encFR },
              { label: 'RL', val: encRL },
              { label: 'RR', val: encRR },
            ].map(({ label, val }) => {
              const pct = Math.min(Math.abs(val % 13440) / 13440 * 100, 100);
              return (
                <div key={label}>
                  <div className="flex justify-between text-[8px] mb-0.5">
                    <span className="text-slate-500 uppercase">{label}</span>
                    <span className="text-yellow-300 font-bold">{val}</span>
                  </div>
                  <div className="w-full bg-slate-950 h-1 rounded-full overflow-hidden border border-slate-800">
                    <div className="h-full bg-yellow-500 transition-all duration-100" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Odometría */}
        <div className="col-span-4 bg-slate-900 border border-slate-800 p-3 rounded-lg">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Odometría</h3>
            <button onClick={() => sendCommand({ cmd: 'reset_odom' })}
              className="text-[8px] text-slate-500 hover:text-white border border-slate-700 hover:border-slate-500 px-2 py-0.5 rounded transition-colors uppercase">
              Reset [R]
            </button>
          </div>
          <div className="grid grid-cols-3 gap-1.5 text-center mb-2">
            {[
              { label: 'X', val: `${(picoTelemetry.odom?.x ?? 0).toFixed(2)}m` },
              { label: 'Y', val: `${(picoTelemetry.odom?.y ?? 0).toFixed(2)}m` },
              { label: 'θ', val: `${(picoTelemetry.odom?.theta ?? 0).toFixed(1)}°` },
            ].map(({ label, val }) => (
              <div key={label} className="bg-slate-950 border border-slate-800 p-1.5 rounded">
                <div className="text-[8px] text-slate-600 mb-0.5">{label}</div>
                <div className="font-bold text-slate-200 text-[10px]">{val}</div>
              </div>
            ))}
          </div>
          <div className="flex justify-center">
            <div className="relative w-12 h-12">
              <div className="absolute inset-0 rounded-full border border-slate-700 bg-slate-950" />
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-0.5 h-5 bg-green-500 origin-bottom rounded"
                  style={{ transform: `rotate(${picoTelemetry.odom?.theta ?? 0}deg)`, transformOrigin: '50% 100%' }} />
              </div>
              <div className="absolute top-0.5 left-1/2 -translate-x-1/2 text-[7px] text-slate-600">N</div>
            </div>
          </div>
        </div>

        {/* Terminal */}
        <div className="col-span-4 bg-slate-900 border border-slate-800 p-3 rounded-lg flex flex-col">
          <h3 className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mb-2">Terminal</h3>
          <div className="flex-1 overflow-y-auto text-[9px] leading-relaxed space-y-0.5 font-mono max-h-28">
            {logs.map((log, i) => (
              <p key={i} className={
                log.includes('E-STOP')                           ? 'text-red-400'    :
                log.includes('✅') || log.includes('conectado') ? 'text-green-400'  :
                log.includes('⚠️') || log.includes('Modo')      ? 'text-yellow-400' :
                'text-slate-500'
              }>{log}</p>
            ))}
          </div>
          {picoTelemetry.ch && picoTelemetry.mode === 'RC' && (
            <div className="mt-2 pt-2 border-t border-slate-800">
              <div className="text-[8px] text-orange-500 mb-1 uppercase">RC Channels (µs)</div>
              <div className="grid grid-cols-6 gap-1">
                {picoTelemetry.ch.slice(0, 6).map((v, i) => (
                  <div key={i} className="text-center">
                    <div className="text-[7px] text-slate-600">CH{i+1}</div>
                    <div className="text-[8px] text-orange-300 font-bold">{v}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

      </section>
    </div>
  );
}

export default App;