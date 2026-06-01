import { useState, useCallback, useRef } from 'react';

// ── Tipos ──────────────────────────────────────────────────────────────────

type BlockType =
  | 'IR_A_GPS'
  | 'AVANZAR'
  | 'GIRAR'
  | 'DETENERSE'
  | 'IDENTIFICAR_OBJETO'
  | 'ABRIR_PINZA'
  | 'CERRAR_PINZA'
  | 'ACERCARSE'
  | 'DEPOSITAR'
  | 'BRAZO_HOME';

interface Block {
  id: string;
  type: BlockType;
  params: Record<string, any>;
}

interface GpsZone { label: string; lat: number; lon: number; }

interface MissionStatus {
  active: boolean;
  current: { action: string; params: Record<string, any> } | null;
  completed: Array<{ action: string; result: string }>;
  pending: Array<{ action: string }>;
  status: 'IDLE' | 'RUNNING' | 'PAUSED' | 'DONE' | 'ERROR';
  log: string[];
}

interface Props {
  jetsonIP: string;
  telemetryGps?: { fix: boolean; lat: number; lon: number };
  addLog: (msg: string) => void;
}

// ── Definición de bloques ──────────────────────────────────────────────────

const BLOCK_DEFS: Record<BlockType, {
  label: string;
  color: string;
  icon: string;
  category: 'move' | 'arm';
  defaultParams: Record<string, any>;
}> = {
  IR_A_GPS:          { label: 'IR A',           color: 'blue',   icon: '📍', category: 'move', defaultParams: { lat: 0, lon: 0, tolerance_m: 2.0 } },
  AVANZAR:           { label: 'AVANZAR',         color: 'green',  icon: '⬆', category: 'move', defaultParams: { metros: 1.0 } },
  GIRAR:             { label: 'GIRAR',           color: 'yellow', icon: '↺',  category: 'move', defaultParams: { grados: 90, direccion: 'derecha' } },
  DETENERSE:         { label: 'DETENER',         color: 'red',    icon: '⬛', category: 'move', defaultParams: {} },
  IDENTIFICAR_OBJETO:{ label: 'IDENTIFICAR',     color: 'purple', icon: '🔍', category: 'move', defaultParams: { clase: 'bottle', timeout_s: 30 } },
  ABRIR_PINZA:       { label: 'ABRIR PINZA',     color: 'cyan',   icon: '✋', category: 'arm',  defaultParams: {} },
  CERRAR_PINZA:      { label: 'CERRAR PINZA',    color: 'cyan',   icon: '✊', category: 'arm',  defaultParams: {} },
  ACERCARSE:         { label: 'ACERCARSE',       color: 'orange', icon: '→',  category: 'arm',  defaultParams: { distancia_cm: 15, velocidad: 0.2 } },
  DEPOSITAR:         { label: 'DEPOSITAR',       color: 'teal',   icon: '📦', category: 'arm',  defaultParams: {} },
  BRAZO_HOME:        { label: 'BRAZO HOME',      color: 'slate',  icon: '🏠', category: 'arm',  defaultParams: {} },
};

const COLOR_MAP: Record<string, string> = {
  blue:   'border-blue-700 bg-blue-950/40 text-blue-300',
  green:  'border-green-700 bg-green-950/40 text-green-300',
  yellow: 'border-yellow-700 bg-yellow-950/40 text-yellow-300',
  red:    'border-red-700 bg-red-950/40 text-red-300',
  purple: 'border-purple-700 bg-purple-950/40 text-purple-300',
  cyan:   'border-cyan-700 bg-cyan-950/40 text-cyan-300',
  orange: 'border-orange-700 bg-orange-950/40 text-orange-300',
  teal:   'border-teal-700 bg-teal-950/40 text-teal-300',
  slate:  'border-slate-600 bg-slate-800/40 text-slate-300',
};

const BADGE_MAP: Record<string, string> = {
  blue:   'bg-blue-900/60 text-blue-300 border-blue-700',
  green:  'bg-green-900/60 text-green-300 border-green-700',
  yellow: 'bg-yellow-900/60 text-yellow-300 border-yellow-700',
  red:    'bg-red-900/60 text-red-300 border-red-700',
  purple: 'bg-purple-900/60 text-purple-300 border-purple-700',
  cyan:   'bg-cyan-900/60 text-cyan-300 border-cyan-700',
  orange: 'bg-orange-900/60 text-orange-300 border-orange-700',
  teal:   'bg-teal-900/60 text-teal-300 border-teal-700',
  slate:  'bg-slate-800 text-slate-300 border-slate-600',
};

// ── Convertir bloques a objetivos JSON para la Jetson ──────────────────────

function blocksToObjectives(blocks: Block[]) {
  return blocks.map(b => {
    switch (b.type) {
      case 'IR_A_GPS':
        return { action: 'NAVIGATE_TO', params: { lat: b.params.lat, lon: b.params.lon, tolerance_m: b.params.tolerance_m } };
      case 'AVANZAR':
        return { action: 'AVANZAR', params: { metros: b.params.metros } };
      case 'GIRAR':
        return { action: 'GIRAR', params: { grados: b.params.grados, direccion: b.params.direccion } };
      case 'DETENERSE':
        return { action: 'STOP', params: {} };
      case 'IDENTIFICAR_OBJETO':
        return { action: 'IDENTIFY_OBJECT', params: { clase: b.params.clase, timeout_s: b.params.timeout_s } };
      case 'ABRIR_PINZA':
        return { action: 'OPEN_GRIPPER', params: {} };
      case 'CERRAR_PINZA':
        return { action: 'CLOSE_GRIPPER', params: {} };
      case 'ACERCARSE':
        return { action: 'APPROACH', params: { distancia_cm: b.params.distancia_cm, velocidad: b.params.velocidad } };
      case 'DEPOSITAR':
        return { action: 'DISCHARGE', params: {} };
      case 'BRAZO_HOME':
        return { action: 'ARM_HOME', params: {} };
      default:
        return { action: b.type, params: b.params };
    }
  });
}

// ── Componente de parámetros por tipo ──────────────────────────────────────

function BlockParams({
  block, onChange, zones, onOpenMap,
}: {
  block: Block;
  onChange: (params: Record<string, any>) => void;
  zones: GpsZone[];
  onOpenMap: (blockId: string) => void;
}) {
  const p = block.params;
  const inp = "bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-purple-600 w-full font-mono";
  const lbl = "text-[9px] text-slate-500 uppercase tracking-widest block mb-0.5";

  switch (block.type) {
    case 'IR_A_GPS':
      return (
        <div className="flex flex-col gap-2 mt-2">
          <div className="flex gap-2">
            <div className="flex-1">
              <span className={lbl}>LAT</span>
              <input className={inp} type="number" step="0.000001" value={p.lat}
                onChange={e => onChange({ ...p, lat: parseFloat(e.target.value) || 0 })} />
            </div>
            <div className="flex-1">
              <span className={lbl}>LON</span>
              <input className={inp} type="number" step="0.000001" value={p.lon}
                onChange={e => onChange({ ...p, lon: parseFloat(e.target.value) || 0 })} />
            </div>
            <div className="w-16">
              <span className={lbl}>TOL (m)</span>
              <input className={inp} type="number" step="0.5" value={p.tolerance_m}
                onChange={e => onChange({ ...p, tolerance_m: parseFloat(e.target.value) || 2 })} />
            </div>
          </div>
          <div className="flex gap-1.5 flex-wrap">
            <button
              onClick={() => onOpenMap(block.id)}
              className="text-[9px] px-2 py-1 rounded border border-blue-800 text-blue-400 hover:bg-blue-900/30 transition-colors uppercase tracking-wider">
              🗺 Seleccionar en mapa
            </button>
            {zones.map(z => (
              <button key={z.label}
                onClick={() => onChange({ ...p, lat: z.lat, lon: z.lon })}
                className="text-[9px] px-2 py-1 rounded border border-slate-700 text-slate-400 hover:border-blue-700 hover:text-blue-400 transition-colors uppercase tracking-wider">
                Zona {z.label}
              </button>
            ))}
          </div>
        </div>
      );

    case 'AVANZAR':
      return (
        <div className="mt-2">
          <span className={lbl}>METROS</span>
          <input className={inp} type="number" step="0.5" min="0.1" value={p.metros}
            onChange={e => onChange({ ...p, metros: parseFloat(e.target.value) || 1 })} />
        </div>
      );

    case 'GIRAR':
      return (
        <div className="flex gap-2 mt-2">
          <div className="flex-1">
            <span className={lbl}>GRADOS</span>
            <input className={inp} type="number" step="15" min="1" max="360" value={p.grados}
              onChange={e => onChange({ ...p, grados: parseFloat(e.target.value) || 90 })} />
          </div>
          <div className="flex-1">
            <span className={lbl}>DIRECCIÓN</span>
            <select className={inp} value={p.direccion}
              onChange={e => onChange({ ...p, direccion: e.target.value })}>
              <option value="derecha">Derecha ↻</option>
              <option value="izquierda">Izquierda ↺</option>
            </select>
          </div>
        </div>
      );

    case 'IDENTIFICAR_OBJETO':
      return (
        <div className="flex gap-2 mt-2">
          <div className="flex-1">
            <span className={lbl}>OBJETO (clase YOLO)</span>
            <input className={inp} type="text" value={p.clase}
              placeholder="bottle, cup, sports ball..."
              onChange={e => onChange({ ...p, clase: e.target.value })} />
          </div>
          <div className="w-20">
            <span className={lbl}>TIMEOUT (s)</span>
            <input className={inp} type="number" min="5" max="120" value={p.timeout_s}
              onChange={e => onChange({ ...p, timeout_s: parseInt(e.target.value) || 30 })} />
          </div>
        </div>
      );

    case 'ACERCARSE':
      return (
        <div className="flex gap-2 mt-2">
          <div className="flex-1">
            <span className={lbl}>DISTANCIA (cm)</span>
            <input className={inp} type="number" step="5" min="5" max="100" value={p.distancia_cm}
              onChange={e => onChange({ ...p, distancia_cm: parseFloat(e.target.value) || 15 })} />
          </div>
          <div className="flex-1">
            <span className={lbl}>VELOCIDAD (0-1)</span>
            <input className={inp} type="number" step="0.05" min="0.05" max="0.8" value={p.velocidad}
              onChange={e => onChange({ ...p, velocidad: parseFloat(e.target.value) || 0.2 })} />
          </div>
        </div>
      );

    default:
      return null;
  }
}

// ── Modal: Selector de coordenadas con mapa OSM ────────────────────────────

function MapModal({ onSelect, onClose }: {
  onSelect: (lat: number, lon: number) => void;
  onClose: () => void;
}) {
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [searchText, setSearchText] = useState('');
  const [mapCenter, setMapCenter] = useState({ lat: -24.7821, lon: -65.4232, zoom: 13 }); // Salta default

  // Usando iframe de OpenStreetMap para mostrar el mapa
  // El usuario puede buscar una dirección y copiar coordenadas, o usar el picker manual
  const mapUrl = `https://www.openstreetmap.org/export/embed.html?bbox=${mapCenter.lon - 0.02},${mapCenter.lat - 0.02},${mapCenter.lon + 0.02},${mapCenter.lat + 0.02}&layer=mapnik&marker=${mapCenter.lat},${mapCenter.lon}`;

  const handleSearch = async () => {
    if (!searchText.trim()) return;
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(searchText)}&format=json&limit=1`);
      const data = await res.json();
      if (data[0]) {
        const lat = parseFloat(data[0].lat);
        const lon = parseFloat(data[0].lon);
        setMapCenter({ lat, lon, zoom: 16 });
        setCoords({ lat, lon });
      }
    } catch {}
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-2xl shadow-2xl flex flex-col gap-3 p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-white uppercase tracking-widest">🗺 Seleccionar coordenada</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-white text-lg">✕</button>
        </div>

        {/* Búsqueda */}
        <div className="flex gap-2">
          <input
            className="flex-1 bg-slate-950 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-600 font-mono"
            placeholder="Buscar dirección o lugar..."
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
          />
          <button onClick={handleSearch}
            className="px-3 py-2 bg-blue-900/50 border border-blue-700 text-blue-300 text-xs rounded hover:bg-blue-800/50 transition-colors uppercase tracking-wider">
            Buscar
          </button>
        </div>

        {/* Mapa iframe */}
        <div className="relative rounded overflow-hidden border border-slate-700" style={{ height: 300 }}>
          <iframe
            title="mapa"
            src={mapUrl}
            className="w-full h-full"
            style={{ border: 0 }}
          />
          <div className="absolute bottom-2 right-2 bg-black/70 text-[9px] text-slate-400 px-2 py-1 rounded">
            El mapa es de referencia — ingresá coords abajo
          </div>
        </div>

        {/* Ingreso manual de coordenadas */}
        <div className="flex gap-2">
          <div className="flex-1">
            <span className="text-[9px] text-slate-500 uppercase tracking-widest block mb-1">LATITUD</span>
            <input
              className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-600 font-mono"
              type="number" step="0.000001"
              value={coords?.lat ?? mapCenter.lat}
              onChange={e => setCoords({ lat: parseFloat(e.target.value) || 0, lon: coords?.lon ?? mapCenter.lon })}
            />
          </div>
          <div className="flex-1">
            <span className="text-[9px] text-slate-500 uppercase tracking-widest block mb-1">LONGITUD</span>
            <input
              className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-600 font-mono"
              type="number" step="0.000001"
              value={coords?.lon ?? mapCenter.lon}
              onChange={e => setCoords({ lat: coords?.lat ?? mapCenter.lat, lon: parseFloat(e.target.value) || 0 })}
            />
          </div>
          <div className="flex items-end">
            <button
              onClick={() => coords && onSelect(coords.lat, coords.lon)}
              disabled={!coords}
              className="px-4 py-2 bg-green-800/60 border border-green-700 text-green-300 text-xs font-bold rounded hover:bg-green-700/60 transition-colors uppercase tracking-wider disabled:opacity-30">
              ✓ Usar
            </button>
          </div>
        </div>

        <p className="text-[9px] text-slate-600 text-center">
          Tip: Abrí Google Maps → click derecho en el punto → copia las coordenadas y pegá acá
        </p>
      </div>
    </div>
  );
}

// ── Modal: Ver JSON ────────────────────────────────────────────────────────

function JsonModal({ blocks, onClose }: { blocks: Block[]; onClose: () => void }) {
  const objectives = blocksToObjectives(blocks);
  const json = JSON.stringify(objectives, null, 2);
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(json);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-lg shadow-2xl flex flex-col gap-3 p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-white uppercase tracking-widest">
            JSON → Jetson <span className="text-slate-500 font-normal text-xs ml-2">({objectives.length} objetivos)</span>
          </h3>
          <div className="flex gap-2">
            <button onClick={copy}
              className={`text-xs px-3 py-1 rounded border transition-colors uppercase tracking-wider ${copied ? 'border-green-600 text-green-400' : 'border-slate-600 text-slate-400 hover:border-slate-400'}`}>
              {copied ? '✓ Copiado' : 'Copiar'}
            </button>
            <button onClick={onClose} className="text-slate-500 hover:text-white text-lg">✕</button>
          </div>
        </div>
        <pre className="bg-slate-950 border border-slate-800 rounded p-3 text-[11px] text-green-300 font-mono overflow-auto max-h-96 leading-relaxed">
          {json}
        </pre>
        <p className="text-[9px] text-slate-600">
          Este JSON se manda a <span className="text-slate-400 font-mono">POST /mission</span> al ejecutar la misión.
        </p>
      </div>
    </div>
  );
}

// ── Bloque individual en la lista ──────────────────────────────────────────

function BlockItem({
  block, index, total, onUpdate, onDelete, onMoveUp, onMoveDown,
  runningIndex, zones, onOpenMap,
}: {
  block: Block;
  index: number;
  total: number;
  onUpdate: (id: string, params: Record<string, any>) => void;
  onDelete: (id: string) => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
  runningIndex: number;
  zones: GpsZone[];
  onOpenMap: (blockId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const def = BLOCK_DEFS[block.type];
  const colorClass = COLOR_MAP[def.color];
  const badgeClass = BADGE_MAP[def.color];

  const isRunning  = index === runningIndex;
  const isDone     = index < runningIndex;
  const isPending  = index > runningIndex;

  return (
    <div className={`rounded-lg border transition-all duration-150 ${
      isRunning ? `${colorClass} shadow-lg shadow-${def.color}-900/20` :
      isDone    ? 'border-slate-800 bg-slate-900/30 opacity-60' :
                  'border-slate-800 bg-slate-900/50'
    }`}>
      <div className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none"
        onClick={() => setExpanded(e => !e)}>

        {/* Step number */}
        <div className={`w-5 h-5 rounded-full text-[9px] font-bold flex items-center justify-center flex-shrink-0 border ${
          isRunning ? `${badgeClass} animate-pulse` :
          isDone    ? 'bg-green-950 text-green-500 border-green-800' :
                      'bg-slate-900 text-slate-600 border-slate-700'
        }`}>
          {isDone ? '✓' : index + 1}
        </div>

        {/* Icon + Label */}
        <span className="text-base leading-none">{def.icon}</span>
        <span className={`text-xs font-bold uppercase tracking-widest flex-1 ${
          isRunning ? `text-${def.color}-300` : isDone ? 'text-slate-500' : 'text-slate-300'
        }`}>
          {def.label}
        </span>

        {/* Param summary */}
        <span className="text-[9px] text-slate-600 font-mono truncate max-w-32">
          {Object.entries(block.params)
            .filter(([k]) => k !== 'tolerance_m')
            .map(([k, v]) => `${v}`)
            .join(' · ')}
        </span>

        {/* Controls */}
        <div className="flex gap-0.5 flex-shrink-0" onClick={e => e.stopPropagation()}>
          <button onClick={() => onMoveUp(block.id)} disabled={index === 0}
            className="w-5 h-5 text-[10px] flex items-center justify-center text-slate-600 hover:text-slate-300 disabled:opacity-20 transition-colors">▲</button>
          <button onClick={() => onMoveDown(block.id)} disabled={index === total - 1}
            className="w-5 h-5 text-[10px] flex items-center justify-center text-slate-600 hover:text-slate-300 disabled:opacity-20 transition-colors">▼</button>
          <button onClick={() => onDelete(block.id)}
            className="w-5 h-5 text-[10px] flex items-center justify-center text-slate-600 hover:text-red-400 transition-colors ml-1">✕</button>
        </div>

        <span className="text-[9px] text-slate-700">{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div className="px-3 pb-3 border-t border-slate-800/60 pt-2">
          <BlockParams
            block={block}
            onChange={p => onUpdate(block.id, p)}
            zones={zones}
            onOpenMap={onOpenMap}
          />
        </div>
      )}
    </div>
  );
}

// ── Panel de misión principal ──────────────────────────────────────────────

export default function MissionPanel({ jetsonIP, telemetryGps, addLog }: Props) {
  const [blocks, setBlocks]               = useState<Block[]>([]);
  const [zones, setZones]                 = useState<GpsZone[]>([]);
  const [missionStatus, setMissionStatus] = useState<MissionStatus | null>(null);
  const [isRunning, setIsRunning]         = useState(false);
  const [showJson, setShowJson]           = useState(false);
  const [mapForBlock, setMapForBlock]     = useState<string | null>(null);
  const [missionName, setMissionName]     = useState('Misión sin nombre');

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Gestión de bloques ──────────────────────────────────────────────────

  const addBlock = useCallback((type: BlockType) => {
    const newBlock: Block = {
      id: `${type}_${Date.now()}`,
      type,
      params: { ...BLOCK_DEFS[type].defaultParams },
    };
    setBlocks(prev => [...prev, newBlock]);
  }, []);

  const updateBlock = useCallback((id: string, params: Record<string, any>) => {
    setBlocks(prev => prev.map(b => b.id === id ? { ...b, params } : b));
  }, []);

  const deleteBlock = useCallback((id: string) => {
    setBlocks(prev => prev.filter(b => b.id !== id));
  }, []);

  const moveBlock = useCallback((id: string, dir: 'up' | 'down') => {
    setBlocks(prev => {
      const idx = prev.findIndex(b => b.id === id);
      if (idx < 0) return prev;
      const next = [...prev];
      const swap = dir === 'up' ? idx - 1 : idx + 1;
      if (swap < 0 || swap >= next.length) return prev;
      [next[idx], next[swap]] = [next[swap], next[idx]];
      return next;
    });
  }, []);

  // ── Zonas GPS ────────────────────────────────────────────────────────────

  const markZone = useCallback((label: string) => {
    const lat = telemetryGps?.fix ? telemetryGps.lat : 0;
    const lon = telemetryGps?.fix ? telemetryGps.lon : 0;
    if (!telemetryGps?.fix) addLog('⚠️  GPS sin fix — zona marcada en 0,0');
    setZones(prev => [...prev.filter(z => z.label !== label), { label, lat, lon }]);
    addLog(`📍 Zona ${label} marcada — ${lat.toFixed(6)}, ${lon.toFixed(6)}`);
  }, [telemetryGps, addLog]);

  // ── Map modal callback ───────────────────────────────────────────────────

  const handleMapSelect = useCallback((lat: number, lon: number) => {
    if (!mapForBlock) return;
    updateBlock(mapForBlock, {
      ...blocks.find(b => b.id === mapForBlock)?.params,
      lat, lon,
    });
    setMapForBlock(null);
  }, [mapForBlock, blocks, updateBlock]);

  // ── Ejecutar misión ──────────────────────────────────────────────────────

  const runningIndex = (() => {
    if (!missionStatus || !isRunning) return -1;
    return missionStatus.completed.length;
  })();

  const startMission = useCallback(async () => {
    if (blocks.length === 0) { addLog('⚠️  Agregá al menos un bloque'); return; }
    const objectives = blocksToObjectives(blocks);
    try {
      const res = await fetch(`http://${jetsonIP}:8000/mission`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ objectives }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error ?? 'Error'); }
      setIsRunning(true);
      addLog(`🚀 Misión "${missionName}" enviada — ${objectives.length} objetivos`);

      pollRef.current = setInterval(async () => {
        try {
          const r = await fetch(`http://${jetsonIP}:8000/mission/status`);
          const data: MissionStatus = await r.json();
          setMissionStatus(data);
          if (data.status === 'DONE' || data.status === 'ERROR') {
            clearInterval(pollRef.current!);
            setIsRunning(false);
            addLog(`Misión ${data.status === 'DONE' ? '✅ completada' : '❌ error'}`);
          }
        } catch {}
      }, 800);
    } catch (e: any) {
      addLog(`❌ Error: ${e.message}`);
    }
  }, [blocks, jetsonIP, missionName, addLog]);

  const stopMission = useCallback(async () => {
    try {
      await fetch(`http://${jetsonIP}:8000/mission/stop`, { method: 'POST' });
      clearInterval(pollRef.current!);
      setIsRunning(false);
      addLog('🛑 Misión detenida');
    } catch {}
  }, [jetsonIP, addLog]);

  const clearMission = () => {
    setBlocks([]);
    setMissionStatus(null);
    setIsRunning(false);
    clearInterval(pollRef.current!);
  };

  // ── Render ───────────────────────────────────────────────────────────────

  const moveCategories: BlockType[] = ['IR_A_GPS', 'AVANZAR', 'GIRAR', 'DETENERSE', 'IDENTIFICAR_OBJETO'];
  const armCategories: BlockType[]  = ['ABRIR_PINZA', 'CERRAR_PINZA', 'ACERCARSE', 'DEPOSITAR', 'BRAZO_HOME'];

  return (
    <>
      {/* ── Modals ── */}
      {mapForBlock && (
        <MapModal
          onSelect={handleMapSelect}
          onClose={() => setMapForBlock(null)}
        />
      )}
      {showJson && (
        <JsonModal blocks={blocks} onClose={() => setShowJson(false)} />
      )}

      {/* ── Panel principal ── */}
      <section className="grid grid-cols-12 gap-4 mb-4">

        {/* ── COLUMNA IZQUIERDA: Constructor de misión ── */}
        <div className="col-span-5 bg-slate-900 border border-purple-900/40 rounded-xl flex flex-col gap-0 overflow-hidden">

          {/* Header */}
          <div className="px-4 py-3 border-b border-slate-800 flex items-center gap-3">
            <span className="text-purple-400 text-base">⚡</span>
            <input
              className="flex-1 bg-transparent text-sm font-bold text-white focus:outline-none placeholder-slate-600"
              value={missionName}
              onChange={e => setMissionName(e.target.value)}
              placeholder="Nombre de la misión..."
            />
            <div className="flex gap-1.5">
              <button
                onClick={() => setShowJson(true)}
                disabled={blocks.length === 0}
                className="text-[9px] px-2 py-1 rounded border border-slate-700 text-slate-400 hover:border-slate-500 hover:text-white transition-colors uppercase tracking-wider disabled:opacity-30">
                {'</>'}JSON
              </button>
              <button
                onClick={clearMission}
                disabled={blocks.length === 0}
                className="text-[9px] px-2 py-1 rounded border border-red-900 text-red-500 hover:bg-red-950/30 transition-colors uppercase tracking-wider disabled:opacity-30">
                Limpiar
              </button>
            </div>
          </div>

          {/* Paleta de bloques */}
          <div className="px-4 py-3 border-b border-slate-800 flex flex-col gap-2">
            <div className="flex flex-col gap-1.5">
              <span className="text-[9px] text-slate-600 uppercase tracking-widest">Movimiento</span>
              <div className="flex flex-wrap gap-1">
                {moveCategories.map(type => {
                  const def = BLOCK_DEFS[type];
                  return (
                    <button key={type} onClick={() => addBlock(type)}
                      className={`text-[9px] px-2 py-1 rounded border font-bold uppercase tracking-wider transition-all hover:scale-105 active:scale-95 ${BADGE_MAP[def.color]}`}>
                      {def.icon} {def.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-[9px] text-slate-600 uppercase tracking-widest">Brazo / Pinza</span>
              <div className="flex flex-wrap gap-1">
                {armCategories.map(type => {
                  const def = BLOCK_DEFS[type];
                  return (
                    <button key={type} onClick={() => addBlock(type)}
                      className={`text-[9px] px-2 py-1 rounded border font-bold uppercase tracking-wider transition-all hover:scale-105 active:scale-95 ${BADGE_MAP[def.color]}`}>
                      {def.icon} {def.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Lista de bloques */}
          <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-1.5 min-h-0" style={{ maxHeight: 320 }}>
            {blocks.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-2 text-slate-700 py-8">
                <span className="text-3xl opacity-30">⚡</span>
                <span className="text-[10px] uppercase tracking-widest">Pulsá un bloque para agregar</span>
              </div>
            ) : (
              blocks.map((block, i) => (
                <BlockItem
                  key={block.id}
                  block={block}
                  index={i}
                  total={blocks.length}
                  onUpdate={updateBlock}
                  onDelete={deleteBlock}
                  onMoveUp={id => moveBlock(id, 'up')}
                  onMoveDown={id => moveBlock(id, 'down')}
                  runningIndex={runningIndex}
                  zones={zones}
                  onOpenMap={setMapForBlock}
                />
              ))
            )}
          </div>

          {/* Footer: zonas GPS + ejecutar */}
          <div className="px-4 py-3 border-t border-slate-800 flex flex-col gap-2">
            {/* Zonas GPS */}
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-slate-600 uppercase tracking-widest flex-shrink-0">Zonas GPS</span>
              <div className="flex gap-1 flex-wrap">
                {['A', 'B', 'C'].map(label => {
                  const zone = zones.find(z => z.label === label);
                  return (
                    <button key={label}
                      onClick={() => zone
                        ? setZones(prev => prev.filter(z => z.label !== label))
                        : markZone(label)}
                      className={`text-[9px] px-2 py-0.5 rounded border uppercase tracking-wider transition-colors ${
                        zone
                          ? 'bg-green-900/40 text-green-400 border-green-700'
                          : 'bg-slate-950 text-slate-600 border-slate-700 hover:border-purple-700 hover:text-purple-400'
                      }`}>
                      {zone ? `✓ ${label}` : `+ ${label}`}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Botones ejecutar */}
            <div className="flex gap-2">
              <button
                onClick={isRunning ? stopMission : startMission}
                disabled={blocks.length === 0}
                className={`flex-1 py-2.5 text-xs font-black rounded uppercase tracking-widest transition-all disabled:opacity-30 disabled:cursor-not-allowed ${
                  isRunning
                    ? 'bg-red-600 text-white hover:bg-red-500'
                    : 'bg-purple-700/60 text-purple-200 border border-purple-600 hover:bg-purple-600/60'
                }`}>
                {isRunning ? '■ DETENER MISIÓN' : `▶ EJECUTAR (${blocks.length} pasos)`}
              </button>
            </div>
          </div>
        </div>

        {/* ── COLUMNA CENTRAL: Estado en vivo ── */}
        <div className="col-span-4 bg-slate-900 border border-purple-900/40 rounded-xl flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
            <span className="text-[10px] font-bold text-purple-400 uppercase tracking-widest">Estado de Misión</span>
            {missionStatus && (
              <span className={`text-[9px] font-bold px-2 py-0.5 rounded border uppercase tracking-wider ${
                missionStatus.status === 'RUNNING' ? 'bg-green-900/50 text-green-400 border-green-700 animate-pulse' :
                missionStatus.status === 'DONE'    ? 'bg-blue-900/50 text-blue-400 border-blue-700' :
                missionStatus.status === 'ERROR'   ? 'bg-red-900/50 text-red-400 border-red-700' :
                missionStatus.status === 'PAUSED'  ? 'bg-yellow-900/50 text-yellow-400 border-yellow-700' :
                'bg-slate-800 text-slate-500 border-slate-700'
              }`}>{missionStatus.status}</span>
            )}
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
            {!missionStatus ? (
              <p className="text-[10px] text-slate-700 italic">Sin misión activa</p>
            ) : (
              <>
                {/* Objetivo actual */}
                {missionStatus.current && (
                  <div className="bg-slate-950 border border-purple-900/40 rounded-lg px-3 py-2">
                    <p className="text-[9px] text-slate-500 uppercase tracking-widest mb-1">Ejecutando ahora</p>
                    <p className="text-xs text-purple-300 font-bold">{missionStatus.current.action}</p>
                    <p className="text-[9px] text-slate-600 font-mono mt-0.5">
                      {JSON.stringify(missionStatus.current.params)}
                    </p>
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
                        <div className="h-full bg-purple-600 transition-all duration-500" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })()}

                {/* Lista completados */}
                <div className="flex flex-col gap-1 overflow-y-auto max-h-32">
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
            )}
          </div>
        </div>

        {/* ── COLUMNA DERECHA: Log ── */}
        <div className="col-span-3 bg-slate-900 border border-purple-900/40 rounded-xl flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800">
            <span className="text-[10px] font-bold text-purple-400 uppercase tracking-widest">Log IA</span>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-0.5 font-mono max-h-64">
            {(missionStatus?.log ?? []).slice().reverse().map((line, i) => (
              <p key={i} className={`text-[9px] leading-relaxed ${
                line.includes('✅') || line.includes('completad') ? 'text-green-400' :
                line.includes('❌') || line.includes('Error')     ? 'text-red-400' :
                line.includes('⚠️')                               ? 'text-yellow-400' :
                line.includes('🚀') || line.includes('▶')         ? 'text-purple-400' :
                'text-slate-500'
              }`}>{line}</p>
            ))}
            {(!missionStatus?.log?.length) && (
              <p className="text-[9px] text-slate-700 italic">Sin actividad</p>
            )}
          </div>
        </div>

      </section>
    </>
  );
}