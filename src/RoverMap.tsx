/**
 * RoverMap.tsx
 * Mapa GPS en tiempo real del rover usando Leaflet + OpenStreetMap.
 * Muestra posición actual, rastro de recorrido, y orientación (yaw).
 * Sin API key. Sin costo.
 */

import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

interface RoverMapProps {
  lat: number;
  lon: number;
  yaw?: number;       // grados, para la flecha de orientación
  fix?: boolean;      // GPS fix
  sats?: number;
  trailColor?: string;
}

// Ícono del rover como flecha SVG rotada según yaw
function makeRoverIcon(yaw: number | undefined, fix: boolean) {
  const color = fix ? '#4ade80' : '#f87171';
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <g transform="rotate(${yaw ?? 0}, 16, 16)">
        <polygon opacity="${yaw === undefined ? 0 : 1}" points="16,4 22,24 16,20 10,24" fill="${color}" stroke="#000" stroke-width="1.5"/>
      </g>
      <circle cx="16" cy="16" r="${yaw === undefined ? 6 : 3}" fill="${color}" stroke="#000" stroke-width="1"/>
    </svg>`;
  return L.divIcon({
    html: svg,
    className: '',
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}

export default function RoverMap({ lat, lon, yaw, fix = false, sats = 0 }: RoverMapProps) {
  const mapRef      = useRef<L.Map | null>(null);
  const markerRef   = useRef<L.Marker | null>(null);
  const trailRef    = useRef<L.Polyline | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const trailPoints = useRef<[number, number][]>([]);
  const hasFix = useRef(false);
  const [tileError,setTileError] = useState(false);
  const [following, setFollowing] = useState(true);
  const [trailLen, setTrailLen]   = useState(0);

  // Inicializar mapa una sola vez
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: fix ? [lat, lon] : [0, 0],
      zoom: fix ? 18 : 1,
      zoomControl: true,
      attributionControl: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).on('tileerror',()=>setTileError(true)).on('tileload',()=>setTileError(false)).addTo(map);

    // Marcador del rover
    const marker = L.marker([lat, lon], {
      icon: makeRoverIcon(yaw, fix),
      zIndexOffset: 1000,
    });

    // Línea del rastro
    const trail = L.polyline([], {
      color: '#38bdf8',
      weight: 2,
      opacity: 0.7,
    }).addTo(map);

    mapRef.current    = map;
    markerRef.current = marker;
    trailRef.current  = trail;

    return () => {
      map.remove();
      mapRef.current    = null;
      markerRef.current = null;
      trailRef.current  = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Actualizar posición cuando cambia lat/lon/yaw
  useEffect(() => {
    if (!mapRef.current || !markerRef.current || !trailRef.current) return;
    if (!fix) {
      markerRef.current.remove();
      return;
    }
    markerRef.current.addTo(mapRef.current);
    if (!hasFix.current) {
      mapRef.current.setView([lat, lon], 18);
      hasFix.current = true;
    }

    const pos: [number, number] = [lat, lon];

    // Actualizar ícono con nueva orientación y estado fix
    markerRef.current.setIcon(makeRoverIcon(yaw, fix));
    markerRef.current.setLatLng(pos);

    // Agregar al rastro solo si hay fix y se movió algo
    if (fix) {
      const prev = trailPoints.current[trailPoints.current.length - 1];
      const moved = !prev || Math.abs(prev[0] - lat) > 0.000005 || Math.abs(prev[1] - lon) > 0.000005;
      if (moved) {
        trailPoints.current.push(pos);
        // Limitar a los últimos 500 puntos para no sobrecargar
        if (trailPoints.current.length > 500) trailPoints.current.shift();
        trailRef.current.setLatLngs(trailPoints.current);
        setTrailLen(trailPoints.current.length);
      }
    }

    // Seguir al rover si following está activo
    if (following && fix) {
      mapRef.current.setView(pos, mapRef.current.getZoom(), { animate: true, duration: 0.5 });
    }
  }, [lat, lon, yaw, fix, following]);

  const clearTrail = () => {
    trailPoints.current = [];
    trailRef.current?.setLatLngs([]);
    setTrailLen(0);
  };

  const centerOnRover = () => {
    if (mapRef.current && fix) {
      mapRef.current.setView([lat, lon], 18, { animate: true });
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header con estado */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
          Mapa GPS
        </h3>
        <div className="flex items-center gap-2">
          <span className={`text-[9px] font-bold ${fix ? 'text-green-400' : 'text-red-400'}`}>
            {fix ? `● FIX (${sats} sats)` : '● SIN FIX'}
          </span>
          {fix && (
            <span className="text-[9px] text-slate-600 font-mono">
              {lat.toFixed(5)}, {lon.toFixed(5)}
            </span>
          )}
        </div>
      </div>

      {/* Mapa */}
      <div className="flex-1 relative min-h-0">
        <div ref={containerRef} className="w-full h-full" style={{ minHeight: '180px' }} />

        {/* Controles flotantes sobre el mapa */}
        <div className="absolute bottom-2 right-2 z-[1000] flex flex-col gap-1">
          <button
            onClick={() => setFollowing(v => !v)}
            title={following ? 'Desactivar seguimiento' : 'Activar seguimiento'}
            className={`w-7 h-7 rounded text-[11px] flex items-center justify-center border transition-colors ${
              following
                ? 'bg-blue-900/80 border-blue-700 text-blue-300'
                : 'bg-slate-900/80 border-slate-700 text-slate-400'
            }`}>
            🎯
          </button>
          <button disabled={!fix}
            onClick={centerOnRover}
            title="Centrar en rover"
            className="w-7 h-7 rounded text-[11px] flex items-center justify-center border bg-slate-900/80 border-slate-700 text-slate-400 hover:text-white transition-colors">
            ⊕
          </button>
          <button
            onClick={clearTrail}
            title="Borrar rastro"
            className="w-7 h-7 rounded text-[11px] flex items-center justify-center border bg-slate-900/80 border-slate-700 text-slate-400 hover:text-white transition-colors">
            ✕
          </button>
        </div>

        {/* Overlay sin fix */}
        {!fix && (
          <div className="absolute inset-0 flex items-center justify-center z-[999] pointer-events-none">
            <div className="bg-black/60 rounded-lg px-3 py-1.5 text-[10px] text-red-400 font-mono border border-red-900/50">
              GPS sin fix — esperando señal...
            </div>
          </div>
        )}
      </div>

      {tileError && <small>Fondo cartográfico sin conexión. El GPS usa la red local.</small>}
      {/* Footer */}
      {trailLen > 0 && (
        <div className="px-3 py-1 border-t border-slate-800">
          <span className="text-[9px] text-slate-600">{trailLen} puntos de rastro</span>
        </div>
      )}
    </div>
  );
}
