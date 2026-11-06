import { apiFetch } from './api';
import { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// ── Tipos ──────────────────────────────────────────────────────────────────

type BlockType =
  | 'IR_A_GPS'
  | 'AVANZAR'
  | 'GIRAR_DER'
  | 'GIRAR_IZQ'
  | 'BUSCAR_Y_RECOLECTAR'
  | 'DESCARGAR'
  | 'DETENER'
  | 'ESPERAR';

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
  defaultParams: Record<string, any>;
}> = {
  IR_A_GPS:            { label: 'IR A COORDENADA',    color: 'blue',   icon: '📍', defaultParams: { lat: 0, lon: 0, tolerance_m: 2.0 } },
  AVANZAR:             { label: 'AVANZAR',             color: 'green',  icon: '⬆',  defaultParams: { metros: 1.0 } },
  GIRAR_DER:           { label: 'GIRAR DER',           color: 'yellow', icon: '↻',  defaultParams: { grados: 90 } },
  GIRAR_IZQ:           { label: 'GIRAR IZQ',           color: 'yellow', icon: '↺',  defaultParams: { grados: 90 } },
  BUSCAR_Y_RECOLECTAR: { label: 'BUSCAR Y RECOLECTAR', color: 'purple', icon: '🔍', defaultParams: { count: 1, target_class: 'bottle', timeout_s: 300, search_radius_m: 50, explore_speed: 0.4 } },
  DESCARGAR:           { label: 'DESCARGAR',           color: 'teal',   icon: '📦', defaultParams: { modo: 'coordenada', lat: 0, lon: 0, tolerance_m: 1.5, descripcion: '' } },
  DETENER:             { label: 'DETENER',             color: 'red',    icon: '⬛', defaultParams: {} },
  ESPERAR:             { label: 'ESPERAR',             color: 'slate',  icon: '⏱',  defaultParams: { seconds: 3 } },
};

const COLOR_MAP: Record<string, string> = {
  blue:   'border-blue-700   bg-blue-950/40   text-blue-300',
  green:  'border-green-700  bg-green-950/40  text-green-300',
  yellow: 'border-yellow-700 bg-yellow-950/40 text-yellow-300',
  red:    'border-red-700    bg-red-950/40    text-red-300',
  purple: 'border-purple-700 bg-purple-950/40 text-purple-300',
  teal:   'border-teal-700   bg-teal-950/40   text-teal-300',
  slate:  'border-slate-600  bg-slate-800/40  text-slate-300',
};

const BADGE_MAP: Record<string, string> = {
  blue:   'bg-blue-900/60   text-blue-300   border-blue-700',
  green:  'bg-green-900/60  text-green-300  border-green-700',
  yellow: 'bg-yellow-900/60 text-yellow-300 border-yellow-700',
  red:    'bg-red-900/60    text-red-300    border-red-700',
  purple: 'bg-purple-900/60 text-purple-300 border-purple-700',
  teal:   'bg-teal-900/60   text-teal-300   border-teal-700',
  slate:  'bg-slate-800     text-slate-300  border-slate-600',
};

// ── Conversión bloques → JSON para Jetson ──────────────────────────────────

function blocksToObjectives(blocks: Block[]) {
  return blocks.map(b => {
    switch (b.type) {
      case 'IR_A_GPS':
        return { action: 'NAVIGATE_TO', params: { lat: b.params.lat, lon: b.params.lon, tolerance_m: b.params.tolerance_m } };
      case 'AVANZAR':
        return { action: 'NAVIGATE_FORWARD', params: { metros: b.params.metros } };
      case 'GIRAR_DER':
        return { action: 'TURN', params: { grados: b.params.grados, dir: 'right' } };
      case 'GIRAR_IZQ':
        return { action: 'TURN', params: { grados: b.params.grados, dir: 'left' } };
      case 'BUSCAR_Y_RECOLECTAR':
        return { action: 'SEARCH_AND_PICK', params: { count: b.params.count, target_class: b.params.target_class } };
      case 'DESCARGAR':
        return { action: 'DISCHARGE', params: { modo: b.params.modo, lat: b.params.lat, lon: b.params.lon, tolerance_m: b.params.tolerance_m, descripcion: b.params.descripcion } };
      case 'DETENER':
        return { action: 'STOP', params: {} };
      case 'ESPERAR':
        return { action: 'WAIT', params: { seconds: b.params.seconds } };
      default:
        return { action: b.type, params: b.params };
    }
  });
}

// ── Modal Mapa con Leaflet ─────────────────────────────────────────────────

function LeafletPickerModal({ onSelect, onClose, currentGps }: {
  onSelect: (lat: number, lon: number) => void;
  onClose: () => void;
  currentGps?: { fix: boolean; lat: number; lon: number };
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<L.Map | null>(null);
  const markerRef    = useRef<L.Marker | null>(null);

  const defaultLat = currentGps?.fix ? currentGps.lat : -24.7821;
  const defaultLon = currentGps?.fix ? currentGps.lon : -65.4232;

  const [coords, setCoords]     = useState({ lat: defaultLat, lon: defaultLon });
  const [search, setSearch]     = useState('');

  // Inicializar mapa Leaflet
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: [defaultLat, defaultLon],
      zoom: 17,
      zoomControl: true,
      attributionControl: false,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20 }).addTo(map);

    // Marcador inicial
    const marker = L.marker([defaultLat, defaultLon], { draggable: true }).addTo(map);

    // Click en mapa → mover marker y actualizar coords
    map.on('click', (e: L.LeafletMouseEvent) => {
      const { lat, lng } = e.latlng;
      marker.setLatLng([lat, lng]);
      setCoords({ lat: +lat.toFixed(7), lon: +lng.toFixed(7) });
    });

    // Drag del marker → actualizar coords
    marker.on('dragend', () => {
      const { lat, lng } = marker.getLatLng();
      setCoords({ lat: +lat.toFixed(7), lon: +lng.toFixed(7) });
    });

    mapRef.current    = map;
    markerRef.current = marker;

    return () => {
      map.remove();
      mapRef.current    = null;
      markerRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Actualizar marker cuando coords cambian por input manual
  const updateMarker = (lat: number, lon: number) => {
    setCoords({ lat, lon });
    if (markerRef.current && mapRef.current) {
      markerRef.current.setLatLng([lat, lon]);
      mapRef.current.setView([lat, lon], mapRef.current.getZoom(), { animate: true });
    }
  };

  const locateRover = () => {
    if (currentGps?.fix) updateMarker(currentGps.lat, currentGps.lon);
  };

  const handleSearch = async () => {
    if (!search.trim()) return;
    try {
      const res  = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(search)}&format=json&limit=1`);
      const data = await res.json();
      if (data[0]) updateMarker(parseFloat(data[0].lat), parseFloat(data[0].lon));
    } catch {}
  };

  const inp = "bg-slate-950 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-600 font-mono w-full";

  return (
    <div className="fixed inset-0 bg-black/90 backdrop-blur-sm z-[9999] flex items-center justify-center p-3">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ width: '90vw', maxWidth: 900, height: '88vh' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800 flex-shrink-0">
          <h3 className="text-sm font-bold text-white uppercase tracking-widest">🗺 Seleccionar coordenada</h3>
          <button onClick={onClose}
            className="text-slate-400 hover:text-white text-xl font-bold w-8 h-8 flex items-center justify-center rounded hover:bg-slate-800 transition-colors">
            ✕
          </button>
        </div>

        {/* Barra de búsqueda */}
        <div className="flex gap-2 px-5 py-3 border-b border-slate-800 flex-shrink-0">
          <input className="flex-1 bg-slate-950 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-600 font-mono"
            placeholder="Buscar lugar o dirección..."
            value={search} onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()} />
          <button onClick={handleSearch}
            className="px-4 py-2 bg-blue-900/60 border border-blue-700 text-blue-300 text-xs font-bold rounded hover:bg-blue-800/60 transition-colors uppercase tracking-wider">
            Buscar
          </button>
          <button onClick={locateRover} disabled={!currentGps?.fix}
            className={`px-4 py-2 border text-xs font-bold rounded transition-colors uppercase tracking-wider ${
              currentGps?.fix
                ? 'bg-green-900/60 border-green-700 text-green-300 hover:bg-green-800/60'
                : 'bg-slate-800 border-slate-700 text-slate-500 cursor-not-allowed'
            }`}>
            📡 Localizar rover {!currentGps?.fix && '(sin fix)'}
          </button>
        </div>

        {/* Mapa Leaflet */}
        <div className="flex-1 relative min-h-0">
          <div ref={containerRef} className="w-full h-full" />
          {/* Instrucción flotante */}
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-[1000] bg-black/70 border border-slate-700 rounded px-3 py-1 text-[10px] text-slate-300 pointer-events-none">
            Click en el mapa o arrastrá el marcador para seleccionar
          </div>
          {/* Coords actuales sobre el mapa */}
          <div className="absolute bottom-2 left-2 z-[1000] bg-black/80 border border-slate-700 rounded px-3 py-1.5 text-[11px] font-mono text-green-300">
            {coords.lat.toFixed(6)}, {coords.lon.toFixed(6)}
          </div>
        </div>

        {/* Footer: inputs + confirmar */}
        <div className="flex gap-3 px-5 py-3 border-t border-slate-800 flex-shrink-0 items-end">
          <div className="flex-1">
            <span className="text-[9px] text-slate-500 uppercase tracking-widest block mb-1">LATITUD</span>
            <input className={inp} type="number" step="0.000001" value={coords.lat}
              onChange={e => updateMarker(parseFloat(e.target.value) || 0, coords.lon)} />
          </div>
          <div className="flex-1">
            <span className="text-[9px] text-slate-500 uppercase tracking-widest block mb-1">LONGITUD</span>
            <input className={inp} type="number" step="0.000001" value={coords.lon}
              onChange={e => updateMarker(coords.lat, parseFloat(e.target.value) || 0)} />
          </div>
          <button onClick={() => onSelect(coords.lat, coords.lon)}
            className="px-6 py-2 bg-green-700/80 border border-green-600 text-green-200 text-sm font-black rounded hover:bg-green-600/80 transition-colors uppercase tracking-widest">
            ✓ Confirmar
          </button>
        </div>

      </div>
    </div>
  );
}

// ── Modal JSON ─────────────────────────────────────────────────────────────

function JsonModal({ blocks, onClose }: { blocks: Block[]; onClose: () => void }) {
  const objectives = blocksToObjectives(blocks);
  const json = JSON.stringify(objectives, null, 2);
  const [copied, setCopied] = useState(false);

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[9999] flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-lg shadow-2xl flex flex-col gap-3 p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-white uppercase tracking-widest">
            JSON → Jetson <span className="text-slate-500 font-normal text-xs ml-2">({objectives.length} objetivos)</span>
          </h3>
          <div className="flex gap-2">
            <button onClick={() => { navigator.clipboard.writeText(json); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
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
          Este JSON se manda a <span className="text-slate-400 font-mono">POST /mission</span> al ejecutar.
        </p>
      </div>
    </div>
  );
}

// ── Parámetros por bloque ──────────────────────────────────────────────────

function BlockParams({ block, onChange, zones, onOpenMap }: {
  block: Block;
  onChange: (p: Record<string, any>) => void;
  zones: GpsZone[];
  onOpenMap: (id: string) => void;
}) {
  const p   = block.params;
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
              <span className={lbl}>TOL(m)</span>
              <input className={inp} type="number" step="0.5" value={p.tolerance_m}
                onChange={e => onChange({ ...p, tolerance_m: parseFloat(e.target.value) || 2 })} />
            </div>
          </div>
          <div className="flex gap-1.5 flex-wrap">
            <button onClick={() => onOpenMap(block.id)}
              className="text-[9px] px-2 py-1 rounded border border-blue-800 text-blue-400 hover:bg-blue-900/30 transition-colors uppercase tracking-wider">
              🗺 Seleccionar en mapa
            </button>
            {zones.map(z => (
              <button key={z.label} onClick={() => onChange({ ...p, lat: z.lat, lon: z.lon })}
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

    case 'GIRAR_DER':
    case 'GIRAR_IZQ':
      return (
        <div className="mt-2">
          <span className={lbl}>GRADOS</span>
          <input className={inp} type="number" step="15" min="5" max="360" value={p.grados}
            onChange={e => onChange({ ...p, grados: parseFloat(e.target.value) || 90 })} />
        </div>
      );

    case 'BUSCAR_Y_RECOLECTAR':
      return (
        <div className="flex flex-col gap-2 mt-2">
          <div className="flex gap-2">
            <div className="w-16">
              <span className={lbl}>CANTIDAD</span>
              <input className={inp} type="number" min="1" max="10" value={p.count}
                onChange={e => onChange({ ...p, count: parseInt(e.target.value) || 1 })} />
            </div>
            <div className="flex-1">
              <span className={lbl}>OBJETO (YOLO)</span>
              <input className={inp} type="text" value={p.target_class} placeholder="bottle"
                onChange={e => onChange({ ...p, target_class: e.target.value })} />
            </div>
            <div className="w-20">
              <span className={lbl}>TIMEOUT(s)</span>
              <input className={inp} type="number" min="30" max="600" value={p.timeout_s}
                onChange={e => onChange({ ...p, timeout_s: parseInt(e.target.value) || 300 })} />
            </div>
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <span className={lbl}>RADIO EXPLORACIÓN (m)</span>
              <input className={inp} type="number" min="5" max="200" step="5" value={p.search_radius_m ?? 50}
                onChange={e => onChange({ ...p, search_radius_m: parseInt(e.target.value) || 50 })} />
            </div>
            <div className="flex-1">
              <span className={lbl}>VEL. EXPLORACIÓN (0-1)</span>
              <input className={inp} type="number" min="0.1" max="0.8" step="0.05" value={p.explore_speed ?? 0.4}
                onChange={e => onChange({ ...p, explore_speed: parseFloat(e.target.value) || 0.4 })} />
            </div>
          </div>
          <p className="text-[9px] text-slate-600">
            Exploración libre dentro del radio. YOLO interrumpe al detectar el objeto e intercepta.
          </p>
        </div>
      );

    case 'DESCARGAR':
      return (
        <div className="flex flex-col gap-2 mt-2">
          <div>
            <span className={lbl}>MODO DE ENTREGA</span>
            <select className={inp} value={p.modo} onChange={e => onChange({ ...p, modo: e.target.value })}>
              <option value="coordenada">Ir a coordenada GPS</option>
              <option value="yolo">Buscar zona por YOLO</option>
            </select>
          </div>
          {p.modo === 'coordenada' && (
            <div className="flex flex-col gap-2">
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
                  <span className={lbl}>TOL(m)</span>
                  <input className={inp} type="number" step="0.5" value={p.tolerance_m}
                    onChange={e => onChange({ ...p, tolerance_m: parseFloat(e.target.value) || 1.5 })} />
                </div>
              </div>
              <div className="flex gap-1.5 flex-wrap">
                <button onClick={() => onOpenMap(block.id)}
                  className="text-[9px] px-2 py-1 rounded border border-teal-800 text-teal-400 hover:bg-teal-900/30 transition-colors uppercase tracking-wider">
                  🗺 Seleccionar en mapa
                </button>
                {zones.map(z => (
                  <button key={z.label} onClick={() => onChange({ ...p, lat: z.lat, lon: z.lon })}
                    className="text-[9px] px-2 py-1 rounded border border-slate-700 text-slate-400 hover:border-teal-700 hover:text-teal-400 transition-colors uppercase tracking-wider">
                    Zona {z.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {p.modo === 'yolo' && (
            <div>
              <span className={lbl}>CLASE YOLO DE LA ZONA</span>
              <input className={inp} type="text" value={p.descripcion}
                placeholder="zona_entrega, red_bucket, table..."
                onChange={e => onChange({ ...p, descripcion: e.target.value })} />
              <p className="text-[9px] text-slate-600 mt-1">
                El rover buscará visualmente la zona de entrega antes de descargar.
              </p>
            </div>
          )}
        </div>
      );

    case 'ESPERAR':
      return (
        <div className="mt-2">
          <span className={lbl}>SEGUNDOS</span>
          <input className={inp} type="number" step="1" min="1" value={p.seconds}
            onChange={e => onChange({ ...p, seconds: parseFloat(e.target.value) || 3 })} />
        </div>
      );

    default:
      return null;
  }
}

// ── Bloque individual ──────────────────────────────────────────────────────

function BlockItem({ block, index, total, onUpdate, onDelete, onMoveUp, onMoveDown, runningIndex, zones, onOpenMap }: {
  block: Block; index: number; total: number;
  onUpdate: (id: string, p: Record<string, any>) => void;
  onDelete: (id: string) => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
  runningIndex: number;
  zones: GpsZone[];
  onOpenMap: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const def       = BLOCK_DEFS[block.type];
  const isRunning = index === runningIndex;
  const isDone    = index < runningIndex;

  return (
    <div className={`rounded-lg border transition-all duration-150 ${
      isRunning ? `${COLOR_MAP[def.color]} shadow-lg` :
      isDone    ? 'border-slate-800 bg-slate-900/30 opacity-50' :
                  'border-slate-800 bg-slate-900/50'
    }`}>
      <div className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none"
        onClick={() => setExpanded(e => !e)}>
        <div className={`w-5 h-5 rounded-full text-[9px] font-bold flex items-center justify-center flex-shrink-0 border ${
          isRunning ? `${BADGE_MAP[def.color]} animate-pulse` :
          isDone    ? 'bg-green-950 text-green-500 border-green-800' :
                      'bg-slate-900 text-slate-600 border-slate-700'
        }`}>
          {isDone ? '✓' : index + 1}
        </div>
        <span className="text-base leading-none">{def.icon}</span>
        <span className={`text-xs font-bold uppercase tracking-widest flex-1 ${
          isRunning ? 'text-white' : isDone ? 'text-slate-500' : 'text-slate-300'
        }`}>{def.label}</span>
        <span className="text-[9px] text-slate-600 font-mono truncate max-w-28">
          {Object.values(block.params).filter(v => typeof v !== 'object' && v !== '').join(' · ')}
        </span>
        <div className="flex gap-0.5 flex-shrink-0" onClick={e => e.stopPropagation()}>
          <button onClick={() => onMoveUp(block.id)} disabled={index === 0}
            className="w-5 h-5 text-[10px] flex items-center justify-center text-slate-600 hover:text-slate-300 disabled:opacity-20">▲</button>
          <button onClick={() => onMoveDown(block.id)} disabled={index === total - 1}
            className="w-5 h-5 text-[10px] flex items-center justify-center text-slate-600 hover:text-slate-300 disabled:opacity-20">▼</button>
          <button onClick={() => onDelete(block.id)}
            className="w-5 h-5 text-[10px] flex items-center justify-center text-slate-600 hover:text-red-400 ml-1">✕</button>
        </div>
        <span className="text-[9px] text-slate-700">{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div className="px-3 pb-3 border-t border-slate-800/60 pt-2">
          <BlockParams block={block} onChange={p => onUpdate(block.id, p)} zones={zones} onOpenMap={onOpenMap} />
        </div>
      )}
    </div>
  );
}

// ── Panel principal ────────────────────────────────────────────────────────

export default function MissionPanel({ jetsonIP, telemetryGps, addLog }: Props) {
  const [blocks, setBlocks]               = useState<Block[]>([]);
  const [zones, setZones]                 = useState<GpsZone[]>([]);
  const [missionStatus, setMissionStatus] = useState<MissionStatus | null>(null);
  const [isRunning, setIsRunning]         = useState(false);
  const [showJson, setShowJson]           = useState(false);
  const [mapForBlock, setMapForBlock]     = useState<string | null>(null);
  const [missionName, setMissionName]     = useState('Misión sin nombre');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Bloques ──────────────────────────────────────────────────────────────

  const addBlock = useCallback((type: BlockType) => {
    setBlocks(prev => [...prev, {
      id: `${type}_${Date.now()}`,
      type,
      params: { ...BLOCK_DEFS[type].defaultParams },
    }]);
  }, []);

  const updateBlock = useCallback((id: string, params: Record<string, any>) => {
    setBlocks(prev => prev.map(b => b.id === id ? { ...b, params } : b));
  }, []);

  const deleteBlock = useCallback((id: string) => {
    setBlocks(prev => prev.filter(b => b.id !== id));
  }, []);

  const moveBlock = useCallback((id: string, dir: 'up' | 'down') => {
    setBlocks(prev => {
      const idx  = prev.findIndex(b => b.id === id);
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
    addLog(`📍 Zona ${label} → ${lat.toFixed(6)}, ${lon.toFixed(6)}`);
  }, [telemetryGps, addLog]);

  // ── Map modal ────────────────────────────────────────────────────────────

  const handleMapSelect = useCallback((lat: number, lon: number) => {
    if (!mapForBlock) return;
    const block = blocks.find(b => b.id === mapForBlock);
    if (block) updateBlock(mapForBlock, { ...block.params, lat, lon });
    setMapForBlock(null);
    addLog(`📍 Coordenada seleccionada: ${lat.toFixed(6)}, ${lon.toFixed(6)}`);
  }, [mapForBlock, blocks, updateBlock, addLog]);

  // ── Ejecutar misión ──────────────────────────────────────────────────────

  const runningIndex = (!missionStatus || !isRunning) ? -1 : missionStatus.completed.length;

  const startMission = useCallback(() => {
    addLog('Autonomía deshabilitada hasta validar seguridad en hardware');
  }, [addLog]);

  const stopMission = useCallback(async () => {
    try {
      await apiFetch('/mission/stop', { method: 'POST', body: '{}' });
      if (pollRef.current) clearInterval(pollRef.current);
      setIsRunning(false);
      addLog('🛑 Misión detenida');
    } catch (error) { addLog(`Parada NO confirmada: ${String(error)}`); }
  }, [jetsonIP, addLog]);

  const clearAll = () => {
    setBlocks([]);
    setMissionStatus(null);
    setIsRunning(false);
    if (pollRef.current) clearInterval(pollRef.current);
  };

  // Cleanup al desmontar
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────

  const PALETTE: BlockType[] = ['IR_A_GPS','AVANZAR','GIRAR_DER','GIRAR_IZQ','BUSCAR_Y_RECOLECTAR','DESCARGAR','DETENER','ESPERAR'];

  return (
    <>
      {/* Modales via Portal — renderizan en body, nunca bloqueados por z-index */}
      {mapForBlock && createPortal(
        <LeafletPickerModal
          onSelect={handleMapSelect}
          onClose={() => setMapForBlock(null)}
          currentGps={telemetryGps}
        />,
        document.body
      )}
      {showJson && createPortal(
        <JsonModal blocks={blocks} onClose={() => setShowJson(false)} />,
        document.body
      )}

      <section className="grid grid-cols-12 gap-3 mb-3">

        {/* ── Constructor de misión ── */}
        <div className="col-span-5 bg-slate-900 border border-purple-900/40 rounded-xl flex flex-col overflow-hidden">

          {/* Header */}
          <div className="px-4 py-3 border-b border-slate-800 flex items-center gap-3">
            <span className="text-purple-400">⚡</span>
            <input className="flex-1 bg-transparent text-sm font-bold text-white focus:outline-none placeholder-slate-600"
              value={missionName} onChange={e => setMissionName(e.target.value)}
              placeholder="Nombre de la misión..." />
            <div className="flex gap-1.5">
              <button onClick={() => setShowJson(true)} disabled={blocks.length === 0}
                className="text-[9px] px-2 py-1 rounded border border-slate-700 text-slate-400 hover:border-slate-500 hover:text-white transition-colors uppercase tracking-wider disabled:opacity-30">
                JSON
              </button>
              <button onClick={clearAll} disabled={blocks.length === 0}
                className="text-[9px] px-2 py-1 rounded border border-red-900 text-red-500 hover:bg-red-950/30 transition-colors uppercase tracking-wider disabled:opacity-30">
                Limpiar
              </button>
            </div>
          </div>

          {/* Paleta */}
          <div className="px-4 py-3 border-b border-slate-800">
            <span className="text-[9px] text-slate-600 uppercase tracking-widest block mb-2">Acciones</span>
            <div className="flex flex-wrap gap-1">
              {PALETTE.map(type => {
                const def = BLOCK_DEFS[type];
                return (
                  <button key={type} onClick={() => addBlock(type)}
                    className={`text-[9px] px-2 py-1.5 rounded border font-bold uppercase tracking-wider transition-all hover:scale-105 active:scale-95 ${BADGE_MAP[def.color]}`}>
                    {def.icon} {def.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Lista de bloques */}
          <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-1.5" style={{ maxHeight: 300 }}>
            {blocks.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-32 gap-2 text-slate-700">
                <span className="text-3xl opacity-20">⚡</span>
                <span className="text-[10px] uppercase tracking-widest">Pulsá una acción para agregar</span>
              </div>
            ) : blocks.map((block, i) => (
              <BlockItem
                key={block.id} block={block} index={i} total={blocks.length}
                onUpdate={updateBlock} onDelete={deleteBlock}
                onMoveUp={id => moveBlock(id, 'up')}
                onMoveDown={id => moveBlock(id, 'down')}
                runningIndex={runningIndex} zones={zones} onOpenMap={setMapForBlock}
              />
            ))}
          </div>

          {/* Footer: zonas GPS + botón ejecutar */}
          <div className="px-4 py-3 border-t border-slate-800 flex flex-col gap-2">
            {/* Zonas GPS rápidas */}
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-slate-600 uppercase tracking-widest flex-shrink-0">Zonas GPS</span>
              <div className="flex gap-1 flex-wrap">
                {['A','B','C'].map(label => {
                  const zone = zones.find(z => z.label === label);
                  return (
                    <button key={label}
                      onClick={() => zone ? setZones(p => p.filter(z => z.label !== label)) : markZone(label)}
                      className={`text-[9px] px-2 py-0.5 rounded border uppercase tracking-wider transition-colors ${
                        zone
                          ? 'bg-green-900/40 text-green-400 border-green-700'
                          : 'bg-slate-950 text-slate-600 border-slate-700 hover:border-purple-700 hover:text-purple-400'
                      }`}>
                      {zone ? `✓ ${label} (${zone.lat.toFixed(4)},${zone.lon.toFixed(4)})` : `+ Zona ${label}`}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Botón ejecutar — aislado en su propio div con z-index explícito */}
            <div className="relative z-20">
              <button
                type="button"
                onClick={isRunning ? stopMission : startMission}
                disabled={blocks.length === 0 && !isRunning}
                className={`w-full py-2.5 text-xs font-black rounded uppercase tracking-widest transition-all disabled:opacity-30 disabled:cursor-not-allowed ${
                  isRunning
                    ? 'bg-red-600 text-white hover:bg-red-500'
                    : 'bg-purple-700/60 text-purple-200 border border-purple-600 hover:bg-purple-600/60'
                }`}>
                {isRunning ? '■ DETENER MISIÓN' : `▶ EJECUTAR (${blocks.length} pasos)`}
              </button>
            </div>
          </div>
        </div>

        {/* ── Estado en vivo ── */}
        <div className="col-span-4 bg-slate-900 border border-purple-900/40 rounded-xl flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
            <span className="text-[10px] font-bold text-purple-400 uppercase tracking-widest">Estado</span>
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
                {missionStatus.current && (
                  <div className="bg-slate-950 border border-purple-900/40 rounded-lg px-3 py-2">
                    <p className="text-[9px] text-slate-500 uppercase tracking-widest mb-1">Ejecutando</p>
                    <p className="text-xs text-purple-300 font-bold">{missionStatus.current.action}</p>
                    <p className="text-[9px] text-slate-600 font-mono mt-0.5">
                      {JSON.stringify(missionStatus.current.params)}
                    </p>
                  </div>
                )}

                {(() => {
                  const total = missionStatus.completed.length + missionStatus.pending.length + (missionStatus.current ? 1 : 0);
                  const done  = missionStatus.completed.length;
                  const pct   = total > 0 ? Math.round((done / total) * 100) : 0;
                  return (
                    <div>
                      <div className="flex justify-between text-[9px] text-slate-500 mb-1">
                        <span>{done}/{total} pasos</span><span>{pct}%</span>
                      </div>
                      <div className="w-full bg-slate-950 h-1.5 rounded-full overflow-hidden border border-slate-800">
                        <div className="h-full bg-purple-600 transition-all duration-500" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })()}

                <div className="flex flex-col gap-1 overflow-y-auto max-h-40">
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

        {/* ── Log ── */}
        <div className="col-span-3 bg-slate-900 border border-purple-900/40 rounded-xl flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800">
            <span className="text-[10px] font-bold text-purple-400 uppercase tracking-widest">Log Misión</span>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-0.5 font-mono" style={{ maxHeight: 320 }}>
            {(missionStatus?.log ?? []).slice().reverse().map((line, i) => (
              <p key={i} className={`text-[9px] leading-relaxed ${
                line.includes('✅') ? 'text-green-400' :
                line.includes('❌') ? 'text-red-400' :
                line.includes('⚠️') ? 'text-yellow-400' :
                line.includes('🎯') ? 'text-cyan-400' :
                line.includes('🚀') || line.includes('▶') ? 'text-purple-400' :
                'text-slate-500'
              }`}>{line}</p>
            ))}
            {!missionStatus?.log?.length && (
              <p className="text-[9px] text-slate-700 italic">Sin actividad</p>
            )}
          </div>
        </div>

      </section>
    </>
  );
}