import { useEffect, useRef, useState } from 'react';
import { Map as MapLibreMap, NavigationControl, setWorkerUrl } from 'maplibre-gl';
import type { ExpressionSpecification, GeoJSONSource } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { circleRing } from './geo';

// MapLibre looks for its worker beside its own file, which bundling moves.
setWorkerUrl(workerUrl);

export type Pin = {
  id: string;
  lat: number;
  lng: number;
  radius_m: number;
  // An area pin is the rough region of a hidden pin; it has no exact point.
  kind: 'live' | 'claimed' | 'draft' | 'area' | 'private' | 'soldout' | 'station' | 'onair';
};

type Props = {
  pins: Pin[];
  me?: { lat: number; lng: number } | null;
  focus?: { lat: number; lng: number } | null;
  onPinClick?: (id: string) => void;
  onMapClick?: (lat: number, lng: number) => void;
};

const STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const COLOR: ExpressionSpecification = [
  'match', ['get', 'kind'],
  'claimed', '#0f766e', 'draft', '#7c3aed', 'area', '#ca8a04', 'private', '#be185d', 'soldout', '#78716c',
  'station', '#0369a1', 'onair', '#0891b2',
  '#d9480f',
];
const IS_AREA: ExpressionSpecification = ['==', ['get', 'kind'], 'area'];
// Station zones are big, so they are drawn faintly under the drops.
const IS_STATION: ExpressionSpecification = ['in', ['get', 'kind'], ['literal', ['station', 'onair']]];

function pinData(pins: Pin[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: pins.flatMap((p): GeoJSON.Feature[] => [
      {
        type: 'Feature',
        properties: { id: p.id, kind: p.kind },
        geometry: { type: 'Polygon', coordinates: [circleRing(p.lat, p.lng, p.radius_m)] },
      },
      ...(p.kind === 'area' ? [] : [{
        type: 'Feature' as const,
        properties: { id: p.id, kind: p.kind },
        geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
      }]),
    ]),
  };
}

function meData(me: Props['me']): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: me
      ? [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [me.lng, me.lat] } }]
      : [],
  };
}

export default function GeoMap({ pins, me, focus, onPinClick, onMapClick }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const handlers = useRef({ onPinClick, onMapClick });
  handlers.current = { onPinClick, onMapClick };
  const centred = useRef(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const m = new MapLibreMap({ container: container.current!, style: STYLE, center: [0, 20], zoom: 1.5 });
    m.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    m.on('load', () => {
      m.addSource('pins', { type: 'geojson', data: pinData([]) });
      m.addSource('me', { type: 'geojson', data: meData(null) });
      m.addLayer({ id: 'zone', type: 'fill', source: 'pins', filter: ['==', '$type', 'Polygon'],
        paint: { 'fill-color': COLOR, 'fill-opacity': ['case', IS_AREA, 0.1, IS_STATION, 0.07, 0.18] } });
      m.addLayer({ id: 'zone-edge', type: 'line', source: 'pins',
        filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['!', IS_AREA]],
        paint: { 'line-color': COLOR, 'line-width': 1.5 } });
      m.addLayer({ id: 'area-edge', type: 'line', source: 'pins',
        filter: ['all', ['==', ['geometry-type'], 'Polygon'], IS_AREA],
        paint: { 'line-color': COLOR, 'line-width': 2, 'line-dasharray': [2, 2] } });
      m.addLayer({ id: 'pin', type: 'circle', source: 'pins', filter: ['==', '$type', 'Point'],
        paint: { 'circle-color': COLOR, 'circle-radius': 8, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
      m.addLayer({ id: 'me', type: 'circle', source: 'me',
        paint: { 'circle-color': '#2563eb', 'circle-radius': 7, 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
      setReady(true);
    });
    m.on('click', (e) => {
      const hit = m.queryRenderedFeatures(e.point, { layers: ['pin', 'zone'] })
        .find((f) => f.properties.kind !== 'draft');
      if (hit && handlers.current.onPinClick) handlers.current.onPinClick(hit.properties.id);
      else handlers.current.onMapClick?.(e.lngLat.lat, e.lngLat.lng);
    });
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      setReady(false);
    };
  }, []);

  useEffect(() => {
    if (ready) (map.current!.getSource('pins') as GeoJSONSource).setData(pinData(pins));
  }, [ready, pins]);

  useEffect(() => {
    if (!ready) return;
    (map.current!.getSource('me') as GeoJSONSource).setData(meData(me));
    if (me && !centred.current) {
      centred.current = true;
      map.current!.flyTo({ center: [me.lng, me.lat], zoom: 15 });
    }
  }, [ready, me]);

  useEffect(() => {
    if (!ready || !focus) return;
    centred.current = true;
    map.current!.flyTo({ center: [focus.lng, focus.lat], zoom: Math.max(map.current!.getZoom(), 15) });
  }, [ready, focus]);

  return <div className="map" ref={container} />;
}
