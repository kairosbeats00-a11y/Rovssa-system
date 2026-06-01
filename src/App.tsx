import { useEffect, useState, useCallback, useRef } from 'react';
import MissionPanel from './MissionPanel';
import RoverMap from './RoverMap';

// ── IP de la Jetson ────────────────────────────────────────────────────────
// Prioridad: var de entorno (build) → localStorage → fallback
const DEFAULT_IP = (import.meta as any).env?.VITE_JETSON_IP || '192.168.1.100';

function getJetsonIP(): string {
  return localStorage.getItem('rovssa_jetson_ip') || DEFAULT_IP;
}

// ── Tipos ──────────────────────────────────────────────────────────────────
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

type RoverMode = 'MANUAL' | 'AUTO' | 'AI';

interface GpsZone {
  lat: number;
  lon: number;
  label: string;
}

interface MissionObjective {
  action: string;
  params: Record<string, unknown>;
}

interface MissionStatus {
  active: boolean;
  current: MissionObjective | null;
  completed: Array<MissionObjective & { result: string }>;
  pending: MissionObjective[];
  status: 'IDLE' | 'RUNNING' | 'PAUSED' | 'DONE' | 'ERROR';
  log: string[];
}

// ── Constantes de control ──────────────────────────────────────────────────
const DRIVE_VX    = 0.7;   // velocidad lineal (0-1)
const DRIVE_OMEGA = 0.6;   // velocidad angular (0-1)

function App() {
  const [jetsonIP, setJetsonIP] = useState<string>(getJetsonIP());
  const [showSettings, setShowSettings] = useState(false);
  const [ipInput, setIpInput] = useState<string>(getJetsonIP());

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

  // Estado de la cámara USB del brazo
  const [armCamError, setArmCamError] = useState(false);

  // ── Estado modo AI ────────────────────────────────────────────────────────
  // (gestionado por MissionPanel)

  // Keys actualmente presionadas para control de teclado
  const keysRef      = useRef<Set<string>>(new Set());
  const driveLoopRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [activeKeys, setActiveKeys] = useState<Set<string>>(new Set());

  // Log del terminal
  const [logs, setLogs] = useState<string[]>([
    `[BOOT] ROVSSA Control System iniciado`,
    `[CFG]  Jetson IP: ${getJetsonIP()}`,
  ]);
  const addLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString();
    setLogs(prev => [`[${ts}] ${msg}`, ...prev].slice(0, 30));
  }, []);

  // ── SSE telemetría rover ─────────────────────────────────────────────────
  useEffect(() => {
    let es: EventSource;
    let retryTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      es = new EventSource(`http://${jetsonIP}:8000/telemetry`);
      es.onopen = () => {
        setIsConnected(true);
        addLog('Rover SSE :8000 conectado');
      };
      es.onmessage = (event) => {
        try { setTelemetry(JSON.parse(event.data)); } catch {}
      };
      es.onerror = () => {
        setIsConnected(false);
        es.close();
        retryTimer = setTimeout(connect, 3000);
      };
    };

    connect();
    return () => { es?.close(); clearTimeout(retryTimer); };
  }, [jetsonIP, addLog]);

  // ── SSE telemetría Pico ──────────────────────────────────────────────────
  useEffect(() => {
    let es: EventSource;
    let retryTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      es = new EventSource(`http://${jetsonIP}:8000/arm_telemetry`);
      es.onopen = () => setIsPicoConnected(true);
      es.onmessage = (event) => {
        try {
          const data: PicoTelemetry = JSON.parse(event.data);
          setPicoTelemetry(data);
          setIsPicoConnected(!!data.arm?.pico_connected);
        } catch {}
      };
      es.onerror = () => {
        setIsPicoConnected(false);
        es.close();
        retryTimer = setTimeout(connect, 3000);
      };
    };

    connect();
    return () => { es?.close(); clearTimeout(retryTimer); };
  }, [jetsonIP]);

  // Resetear error de cámara brazo cuando cambia la IP
  useEffect(() => {
    setArmCamError(false);
  }, [jetsonIP]);

  // ── Enviar comando HTTP al servidor ─────────────────────────────────────
  const sendCommand = useCallback(async (cmd: object) => {
    try {
      await fetch(`http://${jetsonIP}:8000/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cmd),
      });
    } catch { /* silencio si Jetson no responde */ }
  }, [jetsonIP]);

  // ── E-Stop ───────────────────────────────────────────────────────────────
  const handleEStop = useCallback(() => {
    const next = !isEStopActive;
    setIsEStopActive(next);
    sendCommand({ cmd: next ? 'estop' : 'estop_release' });
    addLog(next ? '🛑 E-STOP ACTIVADO' : '✅ E-STOP liberado');
  }, [isEStopActive, sendCommand, addLog]);

  // ── Cambio de modo ───────────────────────────────────────────────────────
  const handleModeChange = useCallback((mode: RoverMode) => {
    setRoverMode(mode);
    sendCommand({ cmd: 'set_mode', mode });
    addLog(`Modo → ${mode}`);
  }, [sendCommand, addLog]);

  // ── Control por teclado ──────────────────────────────────────────────────
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
      if (e.target instanceof HTMLInputElement) return;

      const key = e.key;
      if (['w','a','s','d','ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(key)) {
        if (e.target instanceof HTMLTextAreaElement) return;
        e.preventDefault();
      }

      if (key === ' ') {
        sendCommand({ cmd: 'stop' });
        return;
      }
      if (key === 'r' || key === 'R') {
        sendCommand({ cmd: 'reset_odom' });
        addLog('Odometría reseteada');
        return;
      }
      if (key === 'e' || key === 'E') {
        handleEStop();
        return;
      }

      if (!keysRef.current.has(key)) {
        keysRef.current.add(key);
        setActiveKeys(new Set(keysRef.current));
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      keysRef.current.delete(e.key);
      setActiveKeys(new Set(keysRef.current));
      const movKeys = ['w','a','s','d','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'];
      if (!movKeys.some(k => keysRef.current.has(k))) {
        if (roverMode === 'MANUAL' && !isEStopActive) {
          sendCommand({ cmd: 'stop' });
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup',   onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup',   onKeyUp);
    };
  }, [roverMode, isEStopActive, sendCommand, handleEStop, addLog]);

  // Loop de drive a 10 Hz mientras hay teclas presionadas
  useEffect(() => {
    if (driveLoopRef.current) clearInterval(driveLoopRef.current);
    driveLoopRef.current = setInterval(() => {
      if (roverMode !== 'MANUAL' || isEStopActive) return;
      const { vx, omega } = computeDriveFromKeys();
      if (vx !== 0 || omega !== 0) {
        sendCommand({ cmd: 'drive', vx, omega });
      }
    }, 100);
    return () => { if (driveLoopRef.current) clearInterval(driveLoopRef.current); };
  }, [roverMode, isEStopActive, sendCommand, computeDriveFromKeys]);

  // ── Guardar IP ──────────────────────────────────────────────────────────

  // (markZone y removeZone movidos a MissionPanel)

   // (startMissionPolling movido a MissionPanel)

  // (handleLaunchMission y handleStopMission movidos a MissionPanel)

  const saveIP = () => {
    localStorage.setItem('rovssa_jetson_ip', ipInput);
    setJetsonIP(ipInput);
    setShowSettings(false);
    addLog(`IP cambiada → ${ipInput}`);
  };

  // ── Helpers visuales ────────────────────────────────────────────────────
  const distFrontal = telemetry?.distancia_frontal ?? 5.0;
  const distPct     = Math.min((distFrontal / 5.0) * 100, 100);
  const distColor   = distFrontal < 0.5 ? 'bg-red-500' : distFrontal < 1.5 ? 'bg-yellow-400' : 'bg-green-500';

  const encFL = picoTelemetry.arm?.enc_FL ?? 0;
  const encFR = picoTelemetry.arm?.enc_FR ?? 0;
  const encRL = picoTelemetry.arm?.enc_RL ?? 0;
  const encRR = picoTelemetry.arm?.enc_RR ?? 0;

  const isKeyActive = (keys: string[]) => keys.some(k => activeKeys.has(k));

  return (
    <div className="min-h-screen bg-slate-950 text-slate-300 font-mono p-4 selection:bg-green-900 selection:text-green-400">

      {/* ── MODAL SETTINGS ──────────────────────────────────────────── */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center">
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 w-80 shadow-2xl">
            <h2 className="text-sm font-bold text-white uppercase tracking-widest mb-4">
              ⚙ Configuración
            </h2>
            <label className="text-[10px] text-slate-400 uppercase tracking-widest block mb-1">
              IP de la Jetson Nano
            </label>
            <input
              type="text"
              value={ipInput}
              onChange={e => setIpInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && saveIP()}
              placeholder="192.168.1.100"
              className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-green-600 mb-4"
            />
            <div className="flex gap-2">
              <button onClick={saveIP}
                className="flex-1 bg-green-700 hover:bg-green-600 text-white text-xs font-bold py-2 rounded uppercase tracking-wider">
                Guardar
              </button>
              <button onClick={() => setShowSettings(false)}
                className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold py-2 rounded uppercase tracking-wider">
                Cancelar
              </button>
            </div>
            <p className="text-[9px] text-slate-600 mt-3 text-center">
              También: VITE_JETSON_IP env var en el build
            </p>
          </div>
        </div>
      )}

      {/* ── HEADER ──────────────────────────────────────────────────── */}
      <header className="flex justify-between items-end border-b border-slate-800 pb-4 mb-4">
        <div>
          <h1 className="text-2xl font-black tracking-tighter text-white">
            ROVSSA <span className="text-green-500">//</span> MISSION CONTROL
          </h1>
          <p className="text-[10px] text-slate-500 font-bold uppercase tracking-[0.2em] mt-1">
            IAA 2026 · Jetson Nano · {jetsonIP}
          </p>
        </div>
        <div className="flex items-center gap-5">
          {/* Estado Jetson SSE */}
          <div className="flex flex-col items-end">
            <span className="text-[10px] text-slate-500 uppercase tracking-widest">Jetson</span>
            <div className="flex items-center gap-2 mt-1">
              <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></span>
              <span className={`text-xs font-bold tracking-widest ${isConnected ? 'text-green-400' : 'text-red-400'}`}>
                {isConnected ? 'EN LÍNEA' : 'SIN SEÑAL'}
              </span>
            </div>
          </div>
          {/* Estado Pico */}
          <div className="flex flex-col items-end">
            <span className="text-[10px] text-slate-500 uppercase tracking-widest">Pico USB</span>
            <div className="flex items-center gap-2 mt-1">
              <span className={`w-2 h-2 rounded-full ${isPicoConnected ? 'bg-yellow-400 animate-pulse' : 'bg-red-500'}`}></span>
              <span className={`text-xs font-bold tracking-widest ${isPicoConnected ? 'text-yellow-400' : 'text-red-400'}`}>
                {isPicoConnected ? 'CONECTADO' : 'DESCONECT.'}
              </span>
            </div>
          </div>
          {/* Modo RC/GCS del Pico */}
          <div className="flex flex-col items-end">
            <span className="text-[10px] text-slate-500 uppercase tracking-widest">Pico Mode</span>
            <span className={`text-xs font-bold tracking-widest mt-1 ${picoTelemetry.mode === 'RC' ? 'text-orange-400' : 'text-blue-400'}`}>
              {picoTelemetry.mode}
            </span>
          </div>
          {/* Gear */}
          <button onClick={() => setShowSettings(true)}
            className="text-slate-500 hover:text-white transition-colors text-lg px-2">
            ⚙
          </button>
        </div>
      </header>

      {/* ── MAIN GRID ───────────────────────────────────────────────── */}
      {/*
          Layout: [CAM CSI 5col] [CAM USB brazo 3col] [SIDEBAR 4col]
          Total = 12 columnas, igual que antes.
      */}
      <main className="grid grid-cols-12 gap-4 h-[52vh] mb-4">

        {/* VIDEO FPV — CÁMARA CSI PRINCIPAL (sin tocar) */}
        <section className="col-span-5 bg-black rounded-lg border border-slate-800 overflow-hidden relative flex flex-col">
          <div className="absolute top-4 left-4 z-10 bg-black/60 px-2 py-1 rounded text-[10px] text-green-500 border border-green-900 uppercase tracking-widest backdrop-blur-sm">
            Cam-01 / FPV Principal · CSI
          </div>
          {isEStopActive && (
            <div className="absolute inset-0 z-20 bg-red-900/40 flex items-center justify-center">
              <span className="text-red-400 font-black text-2xl tracking-widest animate-pulse">
                ⛔ E-STOP
              </span>
            </div>
          )}
          <img
            src={`http://${jetsonIP}:8000/video_feed`}
            alt="Rover FPV"
            className={`w-full h-full object-cover ${isEStopActive ? 'grayscale' : ''}`}
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        </section>

        {/* VIDEO BRAZO — CÁMARA USB (nueva) */}
        <section className="col-span-3 bg-black rounded-lg border border-slate-800 overflow-hidden relative flex flex-col">
          <div className="absolute top-4 left-4 z-10 bg-black/60 px-2 py-1 rounded text-[10px] text-cyan-400 border border-cyan-900 uppercase tracking-widest backdrop-blur-sm">
            Cam-02 / Brazo · USB
          </div>

          {/* Overlay E-STOP */}
          {isEStopActive && (
            <div className="absolute inset-0 z-20 bg-red-900/40 flex items-center justify-center">
              <span className="text-red-400 font-black text-lg tracking-widest animate-pulse">
                ⛔ E-STOP
              </span>
            </div>
          )}

          {/* Imagen del brazo — si falla muestra placeholder */}
          {!armCamError ? (
            <img
              src={`http://${jetsonIP}:8000/camera_usb`}
              alt="Cámara Brazo USB"
              className={`w-full h-full object-cover ${isEStopActive ? 'grayscale' : ''}`}
              onError={() => setArmCamError(true)}
            />
          ) : (
            /* Placeholder cuando la cámara USB no está disponible */
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-slate-600">
              <svg className="w-10 h-10 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
              </svg>
              <span className="text-[10px] uppercase tracking-widest opacity-50">Sin señal</span>
              <span className="text-[9px] text-slate-700">/dev/video1</span>
              <button
                onClick={() => setArmCamError(false)}
                className="text-[9px] text-cyan-700 hover:text-cyan-500 border border-cyan-900 hover:border-cyan-700 px-2 py-1 rounded transition-colors uppercase tracking-wider mt-1">
                Reintentar
              </button>
            </div>
          )}
        </section>

        {/* SIDEBAR — idéntico al original */}
        <aside className="col-span-4 flex flex-col gap-3">

          {/* Control de Operaciones */}
          <div className="bg-slate-900 border border-slate-800 p-3 rounded-lg">
            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Control</h3>
            <div className="grid grid-cols-3 gap-2 mb-3">
              {(['MANUAL', 'AUTO', 'AI'] as RoverMode[]).map((mode) => (
                <button key={mode}
                  onClick={() => handleModeChange(mode)}
                  className={`py-2 text-[10px] font-bold rounded uppercase tracking-wider transition-colors ${
                    roverMode === mode
                      ? 'bg-green-900/50 text-green-400 border border-green-700'
                      : 'bg-slate-950 text-slate-500 border border-slate-800 hover:bg-slate-800'
                  }`}>
                  {mode}
                </button>
              ))}
            </div>
            <button onClick={handleEStop}
              className={`w-full py-2.5 rounded text-sm font-black uppercase tracking-widest transition-all ${
                isEStopActive
                  ? 'bg-red-600 text-white animate-pulse'
                  : 'bg-red-950/50 text-red-500 border border-red-900 hover:bg-red-900/30'
              }`}>
              {isEStopActive ? '⛔ DETENIDO — PULSAR PARA LIBERAR' : 'PARADA DE EMERGENCIA [E]'}
            </button>
          </div>

{/* GPS */}
          <div className="bg-slate-900 border border-slate-800 p-3 rounded-lg">
            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">
              GPS — NEO-M8N
              <span className={`ml-2 text-[9px] font-bold ${telemetry.gps?.fix ? 'text-green-400' : 'text-red-400'}`}>
                {telemetry.gps?.fix ? `✓ FIX (${telemetry.gps.sats} sats)` : '✗ SIN FIX'}
              </span>
            </h3>
            <div className="grid grid-cols-2 gap-2 text-center">
              {[
                { label: 'LAT',  val: telemetry.gps?.fix ? telemetry.gps.lat.toFixed(6)  : '---' },
                { label: 'LON',  val: telemetry.gps?.fix ? telemetry.gps.lon.toFixed(6)  : '---' },
                { label: 'ALT',  val: telemetry.gps?.fix ? `${telemetry.gps.alt.toFixed(1)}m` : '---' },
                { label: 'VEL',  val: telemetry.gps?.fix ? `${telemetry.gps.speed_ms.toFixed(1)}m/s` : '---' },
              ].map(({ label, val }) => (
                <div key={label} className="bg-slate-950 border border-slate-800 p-2 rounded">
                  <div className="text-[9px] text-slate-500 mb-1">{label}</div>
                  <div className={`font-bold text-xs ${telemetry.gps?.fix ? 'text-slate-200' : 'text-slate-600'}`}>
                    {val}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* IMU */}
          <div className="bg-slate-900 border border-slate-800 p-3 rounded-lg">
            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">IMU — MPU6050</h3>
            <div className="grid grid-cols-3 gap-2 text-center">
              {[
                { label: 'PITCH', val: telemetry?.pitch ?? 0 },
                { label: 'ROLL',  val: telemetry?.roll  ?? 0 },
                { label: 'YAW',   val: telemetry?.yaw   ?? 0 },
              ].map(({ label, val }) => (
                <div key={label} className="bg-slate-950 border border-slate-800 p-2 rounded">
                  <div className="text-[9px] text-slate-500 mb-1">{label}</div>
                  <div className={`font-bold text-sm ${Math.abs(val) > 30 ? 'text-yellow-400' : 'text-slate-200'}`}>
                    {val.toFixed(1)}°
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Radar Perimetral */}
          <div className="bg-slate-900 border border-slate-800 p-3 rounded-lg">
            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Radar Perimetral — HC-SR04</h3>
            <div className="grid grid-cols-3 gap-2 text-center mb-3">
              {[
                { label: 'IZQ',   val: telemetry?.distancia_izquierda ?? 0 },
                { label: 'FRONT', val: telemetry?.distancia_frontal   ?? 0 },
                { label: 'DER',   val: telemetry?.distancia_derecha   ?? 0 },
              ].map(({ label, val }) => (
                <div key={label} className={`bg-slate-950 border p-2 rounded ${val < 0.5 ? 'border-red-800' : val < 1.5 ? 'border-yellow-800' : 'border-slate-800'}`}>
                  <div className="text-[9px] text-slate-500 mb-1">{label}</div>
                  <div className={`font-bold text-sm ${val < 0.5 ? 'text-red-400' : val < 1.5 ? 'text-yellow-400' : 'text-slate-200'}`}>
                    {val.toFixed(2)}m
                  </div>
                </div>
              ))}
            </div>
            <div className="w-full bg-slate-950 h-2 rounded-full overflow-hidden border border-slate-800">
              <div className={`h-full transition-all duration-150 ${distColor}`}
                   style={{ width: `${distPct}%` }}></div>
            </div>
          </div>

          {/* Mapa GPS en tiempo real */}
          <div className="bg-slate-900 border border-slate-800 rounded-lg flex-1 overflow-hidden flex flex-col" style={{ minHeight: '220px' }}>
            <RoverMap
              lat={telemetry.gps?.lat ?? 0}
              lon={telemetry.gps?.lon ?? 0}
              yaw={telemetry.yaw ?? 0}
              fix={telemetry.gps?.fix ?? false}
              sats={telemetry.gps?.sats ?? 0}
            />
          </div>

        </aside>
      </main>

{/* ── PANEL MODO AI ───────────────────────────────────────────────── */}
      {roverMode === 'AI' && (
        <MissionPanel
          jetsonIP={jetsonIP}
          telemetryGps={telemetry.gps}
          addLog={addLog}
        />
      )}

      {/* ── SECCIÓN PICO + ENCODERS + ODOMETRÍA ─────────────────────── */}
      <section className="grid grid-cols-12 gap-4">

        {/* Encoders */}
        <div className="col-span-5 bg-slate-900 border border-slate-800 p-4 rounded-lg">
          <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">
            Encoders — Pico RP2040 · {picoTelemetry.mode}
          </h3>
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: 'FL (Front-Left)',  val: encFL },
              { label: 'FR (Front-Right)', val: encFR },
              { label: 'RL (Rear-Left)',   val: encRL },
              { label: 'RR (Rear-Right)',  val: encRR },
            ].map(({ label, val }) => {
              const pct = Math.min(Math.abs(val % 13440) / 13440 * 100, 100);
              return (
                <div key={label}>
                  <div className="flex justify-between text-[9px] mb-1">
                    <span className="text-slate-500 uppercase">{label}</span>
                    <span className="text-yellow-300 font-bold">{val}</span>
                  </div>
                  <div className="w-full bg-slate-950 h-1.5 rounded-full overflow-hidden border border-slate-800">
                    <div className="h-full bg-yellow-500 transition-all duration-100"
                         style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Odometría */}
        <div className="col-span-3 bg-slate-900 border border-slate-800 p-4 rounded-lg">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Odometría Dead-Reckoning</h3>
            <button onClick={() => sendCommand({ cmd: 'reset_odom' })}
              className="text-[9px] text-slate-500 hover:text-white border border-slate-700 hover:border-slate-500 px-2 py-1 rounded transition-colors uppercase tracking-wider">
              Reset [R]
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="bg-slate-950 border border-slate-800 p-2 rounded">
              <div className="text-[9px] text-slate-500 mb-1">X</div>
              <div className="font-bold text-slate-200 text-xs">{(picoTelemetry.odom?.x ?? 0).toFixed(2)}m</div>
            </div>
            <div className="bg-slate-950 border border-slate-800 p-2 rounded">
              <div className="text-[9px] text-slate-500 mb-1">Y</div>
              <div className="font-bold text-slate-200 text-xs">{(picoTelemetry.odom?.y ?? 0).toFixed(2)}m</div>
            </div>
            <div className="bg-slate-950 border border-slate-800 p-2 rounded">
              <div className="text-[9px] text-slate-500 mb-1">θ</div>
              <div className="font-bold text-slate-200 text-xs">{(picoTelemetry.odom?.theta ?? 0).toFixed(1)}°</div>
            </div>
          </div>
          {/* Mini brújula visual */}
          <div className="flex items-center justify-center mt-3">
            <div className="relative w-16 h-16">
              <div className="absolute inset-0 rounded-full border border-slate-700 bg-slate-950"></div>
              <div className="absolute inset-0 flex items-center justify-center">
                <div
                  className="w-0.5 h-7 bg-green-500 origin-bottom rounded"
                  style={{ transform: `rotate(${picoTelemetry.odom?.theta ?? 0}deg)`, transformOrigin: '50% 100%' }}
                ></div>
              </div>
              <div className="absolute top-0.5 left-1/2 -translate-x-1/2 text-[8px] text-slate-500">N</div>
            </div>
          </div>
        </div>

        {/* Terminal */}
        {/* Mapa GPS grande */}
        <div className="col-span-4 bg-slate-900 border border-slate-800 rounded-lg overflow-hidden flex flex-col" style={{ minHeight: '200px' }}>
          <RoverMap
            lat={telemetry.gps?.lat ?? 0}
            lon={telemetry.gps?.lon ?? 0}
            yaw={telemetry.yaw ?? 0}
            fix={telemetry.gps?.fix ?? false}
            sats={telemetry.gps?.sats ?? 0}
          />
        </div>

      </section>
    </div>
  );
}

export default App;