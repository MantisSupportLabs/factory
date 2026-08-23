/**
 * Center map. MapLibre GL (Mapbox-GL-compatible API) with satellite/street
 * raster bases, jobsite boundaries, live asset markers, the selected asset's
 * breadcrumb trail, and tap-to-drop manual positioning.
 */

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { AssetStateRow, LocationPoint } from '../api/types';
import { useApp } from '../state/store';
import { iconMarkup, type IconName } from '../ui/icons';
import { PlotBoard } from './PlotBoard';

/**
 * Basemaps: Mapbox styles when a token is available (satellite-streets for
 * imagery, dark for streets — served as raster tiles so MapLibre consumes
 * them directly), falling back to public Esri/OSM rasters without one.
 * VITE_MAPBOX_TOKEN overrides the default public token at build time.
 */
const MAPBOX_TOKEN: string =
  (import.meta.env.VITE_MAPBOX_TOKEN as string | undefined) ?? storedMapboxToken();

/** Runtime fallback: paste a token once via localStorage without rebuilding. */
function storedMapboxToken(): string {
  try {
    return localStorage.getItem('dirtworks.mapboxToken') ?? '';
  } catch {
    return '';
  }
}

function rasterStyle(tiles: string[], tileSize: number, attribution: string): maplibregl.StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: { base: { type: 'raster', tiles, tileSize, maxzoom: 19, attribution } },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
  };
}

function mapboxStyle(styleId: string): maplibregl.StyleSpecification {
  return rasterStyle(
    [`https://api.mapbox.com/styles/v1/mapbox/${styleId}/tiles/512/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`],
    512,
    '© Mapbox © OpenStreetMap © Maxar',
  );
}

const SAT_STYLE: maplibregl.StyleSpecification = MAPBOX_TOKEN
  ? mapboxStyle('satellite-streets-v12')
  : rasterStyle(
      ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      256,
      'Imagery © Esri & contributors',
    );

const STREET_STYLE: maplibregl.StyleSpecification = MAPBOX_TOKEN
  ? mapboxStyle('dark-v11')
  : rasterStyle(['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], 256, '© OpenStreetMap contributors');

/**
 * Offline demo basemap. The packaged snapshot demo runs inside sandboxes
 * that block every external tile host, so instead of dead raster sources it
 * gets a tactical graticule: real vector layers that pan and zoom with the
 * camera (a static CSS backdrop is exactly what makes zooming feel broken).
 */
declare global {
  interface Window {
    __DIRTWORKS_SNAPSHOT__?: unknown;
  }
}
const OFFLINE_DEMO = typeof window !== 'undefined' && !!window.__DIRTWORKS_SNAPSHOT__;

function graticule(): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  const [lngMin, lngMax, latMin, latMax] = [-98.4, -96.6, 32.3, 33.7];
  const minor = 0.01;
  const line = (coords: [number, number][], major: boolean) =>
    features.push({
      type: 'Feature',
      properties: { major },
      geometry: { type: 'LineString', coordinates: coords },
    });
  for (let lng = lngMin; lng <= lngMax + 1e-9; lng += minor) {
    const v = Math.round(lng * 100);
    line([[lng, latMin], [lng, latMax]], v % 5 === 0);
  }
  for (let lat = latMin; lat <= latMax + 1e-9; lat += minor) {
    const v = Math.round(lat * 100);
    line([[lngMin, lat], [lngMax, lat]], v % 5 === 0);
  }
  return { type: 'FeatureCollection', features };
}

function offlineStyle(): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: { graticule: { type: 'geojson', data: graticule() } },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0a1016' } },
      {
        id: 'grid-minor',
        type: 'line',
        source: 'graticule',
        filter: ['==', ['get', 'major'], false],
        minzoom: 11,
        paint: { 'line-color': '#131f2e', 'line-width': 0.7 },
      },
      {
        id: 'grid-major',
        type: 'line',
        source: 'graticule',
        filter: ['==', ['get', 'major'], true],
        paint: { 'line-color': '#1b2c40', 'line-width': 1 },
      },
    ],
  };
}

/** Marker labels clutter the view at regional zooms — hide them early. */
const LABEL_MIN_ZOOM = 10.8;

const KIND_ICON: Record<string, IconName> = {
  machine: 'dozer',
  truck: 'truck',
  small_tool: 'toolbox',
  attachment: 'cog',
  camera: 'camera',
  network: 'antenna',
  trailer: 'trailer',
};

function statusColor(a: AssetStateRow): string {
  if (a.active_faults > 0) return '#e5484d';
  if (a.engine_status === 'running') return '#37c98b';
  if (a.engine_status === 'idle') return '#e8a33d';
  return '#72869a';
}

function GLMap({ onFail }: { onFail: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<Map<number, maplibregl.Marker>>(new Map());
  const siteChipsRef = useRef<maplibregl.Marker[]>([]);
  const didFitRef = useRef(false);

  const assets = useApp((s) => s.assets);
  const jobsites = useApp((s) => s.jobsites);
  const schedule = useApp((s) => s.schedule);
  const mapStyle = useApp((s) => s.mapStyle);
  const selectedAssetId = useApp((s) => s.selectedAssetId);

  /* Create map once. GL can be unavailable in sandboxed hosts (WebGL or
     blob-worker restrictions) — any startup failure hands off to the
     DOM/SVG plotboard instead of leaving a dead map. */
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: OFFLINE_DEMO ? offlineStyle() : SAT_STYLE,
        center: [-97.41, 33.03],
        zoom: 10.3,
        minZoom: 8,
        maxZoom: 19,
        attributionControl: { compact: true },
      });
    } catch (err) {
      console.warn('MapLibre failed to start — using plotboard', err);
      onFail();
      return;
    }
    const bail = setTimeout(() => {
      console.warn('MapLibre never reached load — using plotboard');
      onFail();
    }, 8000);
    map.once('load', () => clearTimeout(bail));
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');
    const applyZoomClass = () => {
      containerRef.current?.parentElement?.classList.toggle('zoomed-out', map.getZoom() < LABEL_MIN_ZOOM);
    };
    applyZoomClass();
    map.on('zoom', applyZoomClass);
    map.on('click', (e) => {
      const { positionDropAssetId } = useApp.getState();
      if (positionDropAssetId != null) {
        api
          .post(`/assets/${positionDropAssetId}/position`, { lat: e.lngLat.lat, lng: e.lngLat.lng })
          .then(() => {
            useApp.getState().armPositionDrop(null);
            useApp.getState().refresh();
            useApp.getState().bumpVersion();
          })
          .catch((err) => console.error('position drop failed', err));
      }
    });
    mapRef.current = map;
    return () => {
      clearTimeout(bail);
      map.remove();
      mapRef.current = null;
      markersRef.current.clear();
    };
  }, []);

  /* Style switch (no-op in the offline demo — there is only the grid). */
  useEffect(() => {
    if (OFFLINE_DEMO) return;
    mapRef.current?.setStyle(mapStyle === 'satellite' ? SAT_STYLE : STREET_STYLE);
  }, [mapStyle]);

  /* Jobsite boundaries + name chips. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const draw = () => {
      const features = jobsites
        .filter((j) => j.boundary)
        .map((j) => ({
          type: 'Feature' as const,
          properties: { id: j.id, name: j.name },
          geometry: JSON.parse(j.boundary!) as GeoJSON.Geometry,
        }));
      const data: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features };
      const existing = map.getSource('jobsites') as maplibregl.GeoJSONSource | undefined;
      if (existing) {
        existing.setData(data);
      } else {
        map.addSource('jobsites', { type: 'geojson', data });
        map.addLayer({
          id: 'jobsites-fill',
          type: 'fill',
          source: 'jobsites',
          paint: { 'fill-color': '#e8a33d', 'fill-opacity': 0.08 },
        });
        map.addLayer({
          id: 'jobsites-line',
          type: 'line',
          source: 'jobsites',
          paint: { 'line-color': '#e8a33d', 'line-width': 2, 'line-dasharray': [3, 2] },
        });
      }
      // Name chips as DOM markers (no glyph dependency).
      siteChipsRef.current.forEach((m) => m.remove());
      siteChipsRef.current = jobsites.map((j) => {
        const el = document.createElement('div');
        const sched = useApp.getState().schedule.find((s) => s.jobsite_id === j.id);
        const statusClass =
          sched?.schedule_status === 'behind' ? ' behind' : sched?.schedule_status === 'ahead' ? ' ahead' : '';
        el.className = `site-chip${statusClass}`;
        el.textContent =
          j.name + (sched?.schedule_status === 'behind' && sched.days_variance ? ` · +${sched.days_variance}D` : '');
        el.onclick = (ev) => {
          ev.stopPropagation();
          useApp.getState().selectJobsite(j.id);
          useApp.getState().setModule('jobsites');
        };
        return new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -14] })
          .setLngLat([j.lng, j.lat])
          .addTo(map);
      });
      if (!didFitRef.current && jobsites.length > 0) {
        didFitRef.current = true;
        const b = new maplibregl.LngLatBounds();
        jobsites.forEach((j) => b.extend([j.lng, j.lat]));
        map.fitBounds(b, { padding: 90, maxZoom: 12 });
      }
    };
    if (map.isStyleLoaded()) draw();
    map.on('styledata', draw);
    return () => {
      map.off('styledata', draw);
    };
  }, [jobsites, mapStyle, schedule]);

  /* Asset markers. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const seen = new Set<number>();
    for (const a of assets) {
      if (a.lat == null || a.lng == null) continue;
      seen.add(a.id);
      let marker = markersRef.current.get(a.id);
      if (!marker) {
        const el = document.createElement('div');
        el.className = 'asset-marker';
        el.onclick = (ev) => {
          ev.stopPropagation();
          useApp.getState().selectAsset(a.id);
        };
        marker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([a.lng, a.lat]).addTo(map);
        markersRef.current.set(a.id, marker);
      } else {
        marker.setLngLat([a.lng, a.lat]);
      }
      const el = marker.getElement();
      const selected = a.id === selectedAssetId;
      el.className = `asset-marker${selected ? ' selected' : ''}`;
      el.style.setProperty('--ring', statusColor(a));
      el.innerHTML = `<span class="am-icon">${iconMarkup(KIND_ICON[a.kind] ?? 'cube', 15)}</span><span class="am-label">${escapeHtml(
        a.name,
      )}</span>`;
      el.title = `${a.name}${a.engine_status ? ` — ${a.engine_status}` : ''}`;
    }
    for (const [id, marker] of markersRef.current) {
      if (!seen.has(id)) {
        marker.remove();
        markersRef.current.delete(id);
      }
    }
  }, [assets, selectedAssetId]);

  /* Selected asset breadcrumb trail. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let cancelled = false;
    const clear = () => {
      if (map.getLayer('trail-line')) map.removeLayer('trail-line');
      if (map.getLayer('trail-dots')) map.removeLayer('trail-dots');
      if (map.getSource('trail')) map.removeSource('trail');
    };
    if (selectedAssetId == null) {
      if (map.isStyleLoaded()) clear();
      return;
    }
    api
      .get<LocationPoint[]>(`/assets/${selectedAssetId}/locations?limit=300`)
      .then((points) => {
        if (cancelled || !mapRef.current || points.length === 0) return;
        const coords = points.map((p) => [p.lng, p.lat] as [number, number]);
        const data: GeoJSON.FeatureCollection = {
          type: 'FeatureCollection',
          features: [
            { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } },
            ...coords.map((c) => ({
              type: 'Feature' as const,
              properties: {},
              geometry: { type: 'Point' as const, coordinates: c },
            })),
          ],
        };
        clear();
        map.addSource('trail', { type: 'geojson', data });
        map.addLayer({
          id: 'trail-line',
          type: 'line',
          source: 'trail',
          filter: ['==', '$type', 'LineString'],
          paint: { 'line-color': '#3fc6f0', 'line-width': 2.5, 'line-opacity': 0.85 },
        });
        map.addLayer({
          id: 'trail-dots',
          type: 'circle',
          source: 'trail',
          filter: ['==', '$type', 'Point'],
          paint: { 'circle-radius': 2.5, 'circle-color': '#3fc6f0', 'circle-opacity': 0.6 },
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (map.isStyleLoaded()) clear();
    };
  }, [selectedAssetId, assets.length > 0 ? 1 : 0]);

  return <div ref={containerRef} className="map-container" />;
}

/**
 * Map surface: MapLibre GL where it can run; the DOM/SVG plotboard in the
 * packaged offline demo and wherever GL startup fails.
 */
export function MapView() {
  const [plot, setPlot] = useState(OFFLINE_DEMO);
  const dropArmed = useApp((s) => s.positionDropAssetId != null);

  return (
    <div className={`map-wrap${dropArmed ? ' drop-armed' : ''}`}>
      {plot ? <PlotBoard /> : <GLMap onFail={() => setPlot(true)} />}
      {dropArmed && (
        <div className="drop-banner">
          Tap the map to set this asset's position
          <button onClick={() => useApp.getState().armPositionDrop(null)}>Cancel</button>
        </div>
      )}
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
