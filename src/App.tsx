import { useEffect, useState, useCallback, useRef } from 'react';

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
  const [missionPrompt, setMissionPrompt]   = useState('');
  const [zones, setZones]                   = useState<GpsZone[]>([]);
  const [missionStatus, setMissionStatus]   = useState<MissionStatus | null>(null);
  const [isPlanning, setIsPlanning]         = useState(false);
  const [aiApiKey]                          = useState<string>(
    (import.meta as any).env?.VITE_DEEPSEEK_API_KEY ?? ''
  );
  const missionPollRef                      = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // ── Modo AI: marcar zona GPS ──────────────────────────────────────────────
  const markZone = useCallback((label: string) => {
    const lat = telemetry.gps?.fix ? telemetry.gps.lat : 0;
    const lon = telemetry.gps?.fix ? telemetry.gps.lon : 0;
    if (!telemetry.gps?.fix) {
      addLog('⚠️  GPS sin fix — zona marcada en 0,0 (corregir cuando haya señal)');
    }
    setZones(prev => {
      const filtered = prev.filter(z => z.label !== label);
      return [...filtered, { lat, lon, label }];
    });
    addLog(`📍 Zona ${label} marcada — lat:${lat.toFixed(6)} lon:${lon.toFixed(6)}`);
  }, [telemetry, addLog]);

  const removeZone = useCallback((label: string) => {
    setZones(prev => prev.filter(z => z.label !== label));
  }, []);

  // ── Modo AI: polling de estado de misión ─────────────────────────────────
  const startMissionPolling = useCallback(() => {
    if (missionPollRef.current) clearInterval(missionPollRef.current);
    missionPollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`http://${jetsonIP}:8000/mission/status`);
        const data: MissionStatus = await res.json();
        setMissionStatus(data);
        if (data.status === 'DONE' || data.status === 'ERROR') {
          clearInterval(missionPollRef.current!);
          addLog(`Misión ${data.status === 'DONE' ? '✅ completada' : '❌ con error'}`);
        }
      } catch { /* jetson sin respuesta */ }
    }, 1000);
  }, [jetsonIP, addLog]);

  useEffect(() => {
    return () => { if (missionPollRef.current) clearInterval(missionPollRef.current); };
  }, []);

  // ── Modo AI: llamar a Deepseek y enviar misión a Jetson ──────────────────
  const handleLaunchMission = useCallback(async () => {
    if (!missionPrompt.trim()) return;
    if (zones.length === 0) {
      addLog('⚠️  Marcá al menos una zona GPS antes de lanzar');
      return;
    }
    if (!aiApiKey) {
      addLog('❌ API key no configurada — agregá VITE_DEEPSEEK_API_KEY en .env');
      return;
    }

    setIsPlanning(true);
    addLog('🧠 Enviando prompt al planner...');

    // Construir contexto de zonas para el LLM
    const zonesContext = zones.map(z =>
      `${z.label}: lat=${z.lat.toFixed(6)}, lon=${z.lon.toFixed(6)}`
    ).join('\n');

    const systemPrompt = `Eres el planner de un rover autónomo. 
Tu única función es convertir instrucciones en lenguaje natural en una lista de objetivos JSON.
Respondé ÚNICAMENTE con un array JSON válido, sin texto adicional, sin markdown, sin explicaciones.

Zonas GPS disponibles:
${zonesContext}

Acciones disponibles:
- NAVIGATE_TO: {"action":"NAVIGATE_TO","params":{"lat":float,"lon":float,"tolerance_m":float}}
- SEARCH_AND_PICK: {"action":"SEARCH_AND_PICK","params":{"count":int,"target_class":"bottle"}}
- DISCHARGE: {"action":"DISCHARGE","params":{}}
- WAIT: {"action":"WAIT","params":{"seconds":float}}
- STOP: {"action":"STOP","params":{}}

Reglas:
1. Siempre terminar con STOP.
2. Para recolectar objetos: primero NAVIGATE_TO la zona, luego SEARCH_AND_PICK.
3. Para descargar: primero NAVIGATE_TO la zona de descarga, luego DISCHARGE.
4. tolerance_m por defecto 2.0.`;

    try {
      const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${aiApiKey}`,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          max_tokens: 1000,
          temperature: 0,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: missionPrompt },
          ],
        }),
      });

      if (!response.ok) throw new Error(`Deepseek error: ${response.status}`);

      const data = await response.json();
      const raw  = data.choices?.[0]?.message?.content ?? '';

      // Parsear JSON — limpiar posibles backticks si el modelo los agregó
      const clean = raw.replace(/```json|```/g, '').trim();
      const objectives: MissionObjective[] = JSON.parse(clean);

      addLog(`📋 Plan generado: ${objectives.length} objetivos`);
      objectives.forEach((o, i) => addLog(`  ${i+1}. ${o.action}`));

      // Enviar a la Jetson
      const res = await fetch(`http://${jetsonIP}:8000/mission`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ objectives }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? 'Error enviando misión');
      }

      addLog('🚀 Misión enviada a la Jetson — iniciando');
      startMissionPolling();

    } catch (e: any) {
      addLog(`❌ Error: ${e.message}`);
    } finally {
      setIsPlanning(false);
    }
  }, [missionPrompt, zones, jetsonIP, aiApiKey, addLog, startMissionPolling]);

  const handleStopMission = useCallback(async () => {
    try {
      await fetch(`http://${jetsonIP}:8000/mission/stop`, { method: 'POST' });
      addLog('🛑 Misión detenida');
      if (missionPollRef.current) clearInterval(missionPollRef.current);
    } catch { addLog('⚠️  No se pudo detener la misión'); }
  }, [jetsonIP, addLog]);

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

          {/* Control teclado visual */}
          <div className="bg-slate-900 border border-slate-800 p-3 rounded-lg flex-1">
            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">
              Teclado {roverMode !== 'MANUAL' && <span className="text-yellow-600">(solo en MANUAL)</span>}
            </h3>
            <div className="flex flex-col items-center gap-1">
              <div className="flex gap-1">
                <div className={`w-9 h-9 rounded border text-[11px] font-bold flex items-center justify-center transition-colors ${
                  isKeyActive(['w','ArrowUp']) ? 'bg-green-700 text-white border-green-500' : 'bg-slate-950 text-slate-500 border-slate-700'
                }`}>▲</div>
              </div>
              <div className="flex gap-1">
                {[['a','ArrowLeft','◄'],['s','ArrowDown','▼'],['d','ArrowRight','►']].map(([k1, k2, lbl]) => (
                  <div key={k1} className={`w-9 h-9 rounded border text-[11px] font-bold flex items-center justify-center transition-colors ${
                    isKeyActive([k1, k2]) ? 'bg-green-700 text-white border-green-500' : 'bg-slate-950 text-slate-500 border-slate-700'
                  }`}>{lbl}</div>
                ))}
              </div>
              <div className="text-[9px] text-slate-600 mt-1">WASD / flechas · Espacio=stop · E=Estop · R=reset odom</div>
            </div>
          </div>

        </aside>
      </main>

{/* ── PANEL MODO AI ───────────────────────────────────────────────── */}
      {roverMode === 'AI' && (
        <section className="grid grid-cols-12 gap-4 mb-4">

          {/* Prompt + zonas */}
          <div className="col-span-5 bg-slate-900 border border-purple-900/50 p-4 rounded-lg flex flex-col gap-3">
            <h3 className="text-[10px] font-bold text-purple-400 uppercase tracking-widest">
              🧠 Misión Autónoma
            </h3>

{!aiApiKey && (
              <div className="text-[9px] text-red-400 bg-red-950/40 border border-red-900/50 rounded px-2 py-1.5">
                ⚠️ VITE_DEEPSEEK_API_KEY no configurada — agregá la key en .env y rebuildeá
              </div>
            )}

            {/* Prompts rápidos */}
            <div className="flex flex-wrap gap-1">
              {[
                { label: '4 botellas A→B', prompt: 'Navegá a zona A, buscá 4 botellas y recogelas una por una. Después navegá a zona B y descargá todo.' },
                { label: '2 botellas A→B', prompt: 'Navegá a zona A, buscá 2 botellas y recogelas. Después navegá a zona B y descargá.' },
                { label: 'Solo descargar', prompt: 'Navegá a zona B y descargá el contenido del compartimento.' },
              ].map(({ label, prompt }) => (
                <button key={label} onClick={() => setMissionPrompt(prompt)}
                  className="text-[9px] px-2 py-1 rounded border border-purple-900/50 text-purple-500 hover:text-purple-300 hover:border-purple-700 bg-slate-950 transition-colors uppercase tracking-wider">
                  {label}
                </button>
              ))}
            </div>
            <textarea
              value={missionPrompt}
              onChange={e => setMissionPrompt(e.target.value)}
              placeholder="Ej: buscá 4 botellas en zona A y descargalas en zona B"
              rows={3}
              className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-purple-600 resize-none font-mono"
            />

            {/* Zonas GPS */}
            <div className="flex gap-2">
              {['A','B','C'].map(label => {
                const zone = zones.find(z => z.label === label);
                return (
                  <div key={label} className="flex-1">
                    <button
                      onClick={() => zone ? removeZone(label) : markZone(label)}
                      className={`w-full py-1.5 text-[10px] font-bold rounded uppercase tracking-wider transition-colors border ${
                        zone
                          ? 'bg-green-900/40 text-green-400 border-green-700'
                          : 'bg-slate-950 text-slate-500 border-slate-700 hover:border-purple-700 hover:text-purple-400'
                      }`}>
                      {zone ? `✓ Zona ${label}` : `+ Zona ${label}`}
                    </button>
                    {zone && (
                      <p className="text-[8px] text-slate-600 text-center mt-0.5 font-mono">
                        {zone.lat.toFixed(5)}, {zone.lon.toFixed(5)}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Botones acción */}
            <div className="flex gap-2">
              <button
                onClick={handleLaunchMission}
                disabled={isPlanning || !missionPrompt.trim()}
                className="flex-1 py-2 text-[10px] font-black rounded uppercase tracking-wider transition-colors bg-purple-900/50 text-purple-300 border border-purple-700 hover:bg-purple-800/50 disabled:opacity-30 disabled:cursor-not-allowed">
                {isPlanning ? '⏳ Planificando...' : '🚀 Lanzar Misión'}
              </button>
              <button
                onClick={handleStopMission}
                className="py-2 px-4 text-[10px] font-black rounded uppercase tracking-wider bg-red-950/50 text-red-400 border border-red-900 hover:bg-red-900/30 transition-colors">
                ■ Stop
              </button>
            </div>
          </div>

          {/* Estado de misión */}
          <div className="col-span-4 bg-slate-900 border border-purple-900/50 p-4 rounded-lg flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h3 className="text-[10px] font-bold text-purple-400 uppercase tracking-widest">Estado</h3>
              {missionStatus && (
                <span className={`text-[9px] font-bold px-2 py-0.5 rounded uppercase tracking-wider ${
                  missionStatus.status === 'RUNNING' ? 'bg-green-900/50 text-green-400' :
                  missionStatus.status === 'DONE'    ? 'bg-blue-900/50 text-blue-400'  :
                  missionStatus.status === 'ERROR'   ? 'bg-red-900/50 text-red-400'    :
                  missionStatus.status === 'PAUSED'  ? 'bg-yellow-900/50 text-yellow-400' :
                  'bg-slate-800 text-slate-500'
                }`}>{missionStatus.status}</span>
              )}
            </div>

            {missionStatus ? (
              <>
                {/* Objetivo actual */}
                {missionStatus.current && (
                  <div className="bg-slate-950 border border-purple-900/30 rounded px-3 py-2">
                    <p className="text-[9px] text-slate-500 uppercase tracking-widest mb-0.5">Ejecutando</p>
                    <p className="text-xs text-purple-300 font-bold">{missionStatus.current.action}</p>
                  </div>
                )}

                {/* Barra de progreso */}
                {(() => {
                  const total = missionStatus.completed.length + missionStatus.pending.length + (missionStatus.current ? 1 : 0);
                  const done  = missionStatus.completed.length;
                  const pct   = total > 0 ? Math.round((done / total) * 100) : 0;
                  return (
                    <div>
                      <div className="flex justify-between text-[9px] text-slate-500 mb-1">
                        <span>{done}/{total} objetivos</span>
                        <span>{pct}%</span>
                      </div>
                      <div className="w-full bg-slate-950 h-1.5 rounded-full overflow-hidden border border-slate-800">
                        <div className="h-full bg-purple-600 transition-all duration-500"
                             style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })()}

                {/* Completados */}
                <div className="flex flex-col gap-1 overflow-y-auto max-h-24">
                  {missionStatus.completed.map((o, i) => (
                    <div key={i} className="flex items-center gap-2 text-[9px]">
                      <span className={o.result === 'OK' ? 'text-green-500' : 'text-red-500'}>
                        {o.result === 'OK' ? '✓' : '✗'}
                      </span>
                      <span className="text-slate-500">{o.action}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-[10px] text-slate-600 italic">Sin misión activa</p>
            )}
          </div>

          {/* Log de misión */}
          <div className="col-span-3 bg-slate-900 border border-purple-900/50 p-4 rounded-lg flex flex-col">
            <h3 className="text-[10px] font-bold text-purple-400 uppercase tracking-widest mb-2">Log IA</h3>
            <div className="flex-1 overflow-y-auto text-[9px] leading-relaxed space-y-0.5 font-mono max-h-40">
              {(missionStatus?.log ?? []).map((line, i) => (
                <p key={i} className={
                  line.includes('✅') || line.includes('completad') ? 'text-green-400' :
                  line.includes('❌') || line.includes('Error')     ? 'text-red-400'   :
                  line.includes('⚠️')                               ? 'text-yellow-400':
                  line.includes('🚀') || line.includes('▶')         ? 'text-purple-400':
                  'text-slate-500'
                }>{line}</p>
              ))}
            </div>
          </div>

        </section>
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
        <div className="col-span-4 bg-slate-900 border border-slate-800 p-4 rounded-lg flex flex-col">
          <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">Terminal del Sistema</h3>
          <div className="flex-1 overflow-y-auto text-[10px] leading-relaxed space-y-1 font-mono max-h-32">
            {logs.map((log, i) => (
              <p key={i} className={
                log.includes('E-STOP') ? 'text-red-400' :
                log.includes('✅') || log.includes('conectado') ? 'text-green-400' :
                log.includes('⚠️') || log.includes('Modo') ? 'text-yellow-400' :
                'text-slate-500'
              }>{log}</p>
            ))}
          </div>
          {/* RC Channels mini display */}
          {picoTelemetry.ch && picoTelemetry.mode === 'RC' && (
            <div className="mt-2 pt-2 border-t border-slate-800">
              <div className="text-[9px] text-orange-500 mb-1 uppercase tracking-widest">RC Channels (µs)</div>
              <div className="grid grid-cols-6 gap-1">
                {picoTelemetry.ch.slice(0, 6).map((v, i) => (
                  <div key={i} className="text-center">
                    <div className="text-[8px] text-slate-600">CH{i+1}</div>
                    <div className="text-[9px] text-orange-300 font-bold">{v}</div>
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