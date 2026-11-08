import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { coverLinks, fileLink, supabase } from './supabase';
import { distanceM, formatDistance } from './geo';
import { loadCodes, normaliseCode, saveCodes } from './codes';
import GeoMap from './GeoMap';
import type { Pin } from './GeoMap';
import ArtistFollow from './ArtistFollow';
import { usePosition } from './usePosition';
import StationPlayer from './StationPlayer';
import type { MapStation } from './radio';

export type MapDrop = {
  id: string;
  title: string;
  artist_id: string | null;
  artist_name: string;
  lat: number;
  lng: number;
  radius_m: number;
  exact: boolean;
  area_m: number | null;
  hint: string | null;
  place_name: string | null;
  notes: string | null;
  cover_path: string | null;
  preview_path: string | null;
  opens_at: string;
  closes_at: string | null;
  max_claims: number | null;
  claims_count: number;
  claimed: boolean;
  trail_id: string | null;
  trail_title: string | null;
  is_private: boolean;
};

const CLAIM_MESSAGES: Record<string, string> = {
  already_claimed: 'This one is already in your library.',
  not_available: 'This drop isn’t available right now.',
  invalid_location: 'Your device sent a location we couldn’t read. Try again.',
  simulated_location: 'This device appears to be faking its location.',
  low_accuracy: 'Your location is too rough to confirm. Try again outside, away from buildings.',
  sold_out: 'Every copy has been claimed.',
};

const NEAR_M = 300;

function soldOut(d: MapDrop) {
  return d.max_claims !== null && d.claims_count >= d.max_claims;
}

function notify(title: string, body: string) {
  navigator.vibrate?.([120, 60, 120]);
  if (document.visibilityState === 'hidden' && 'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(title, { body });
    } catch {
      // Some browsers only allow notifications from a service worker.
    }
  }
}

export default function Listen({ session, onNeedSignIn, focusDropId, onFocused }: {
  session: Session | null;
  onNeedSignIn: () => void;
  focusDropId: string | null;
  onFocused: () => void;
}) {
  const [drops, setDrops] = useState<MapDrop[]>([]);
  const [stations, setStations] = useState<MapStation[]>([]);
  const [stationId, setStationId] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[]>(loadCodes);
  const [revealed, setRevealed] = useState<Record<string, { lat: number; lng: number }>>({});
  const [covers, setCovers] = useState<Record<string, string>>({});
  const { position, locationError } = usePosition();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ lat: number; lng: number } | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [preview, setPreview] = useState<{ id: string; url: string } | null>(null);
  const [codeOpen, setCodeOpen] = useState(false);
  const [codeInput, setCodeInput] = useState('');
  const [codeMessage, setCodeMessage] = useState('');
  const alerted = useRef(new Set<string>());
  const lastReveal = useRef<{ lat: number; lng: number; at: number } | null>(null);

  const load = useCallback(async (withCodes: string[]) => {
    const { data, error } = await supabase.rpc('map_drops', { p_codes: withCodes });
    if (error) {
      setLoadError(error.message);
      return [] as MapDrop[];
    }
    setLoadError('');
    const rows = (data ?? []) as MapDrop[];
    setDrops(rows);
    coverLinks(rows.map((d) => d.cover_path)).then((links) => setCovers((c) => ({ ...c, ...links })));
    return rows;
  }, []);

  useEffect(() => { load(codes); }, [load, codes, session]);

  // Stations, refreshed every minute so "on air" stays current.
  useEffect(() => {
    let stopped = false;
    const refresh = () => supabase.rpc('map_stations').then(({ data }) => {
      if (stopped || !data) return;
      const rows = data as MapStation[];
      setStations(rows);
      coverLinks(rows.map((r) => r.cover_path)).then((links) => setCovers((c) => ({ ...c, ...links })));
    });
    refresh();
    const timer = setInterval(refresh, 60000);
    return () => { stopped = true; clearInterval(timer); };
  }, [session]);

  // Ask for the exact spot of hidden pins as the listener moves.
  useEffect(() => {
    if (!position || !drops.some((d) => !d.exact && !revealed[d.id])) return;
    const last = lastReveal.current;
    if (last && distanceM(last.lat, last.lng, position.lat, position.lng) < 25 && Date.now() - last.at < 30000) return;
    lastReveal.current = { lat: position.lat, lng: position.lng, at: Date.now() };
    supabase.rpc('reveal_nearby', {
      p_lat: position.lat, p_lng: position.lng, p_accuracy_m: position.accuracy, p_codes: codes,
    }).then(({ data }) => {
      if (!data?.length) return;
      setRevealed((current) => {
        const next = { ...current };
        for (const r of data as { id: string; lat: number; lng: number }[]) next[r.id] = { lat: r.lat, lng: r.lng };
        return next;
      });
    });
  }, [position, drops, revealed, codes]);

  const located = useMemo(() => drops.map((d) => {
    const spot = revealed[d.id];
    return spot ? { ...d, ...spot, exact: true } : d;
  }), [drops, revealed]);

  const pins = useMemo<Pin[]>(() => [
    ...stations.map((st): Pin => ({
      id: `station:${st.id}`, lat: st.lat, lng: st.lng, radius_m: st.radius_m, kind: st.on_air ? 'onair' : 'station',
    })),
    ...located.map((d): Pin => ({
      id: d.id,
      lat: d.lat,
      lng: d.lng,
      radius_m: d.exact ? d.radius_m : d.area_m ?? d.radius_m,
      kind: d.claimed ? 'claimed' : !d.exact ? 'area' : soldOut(d) ? 'soldout' : d.is_private ? 'private' : 'live',
    })),
  ], [located, stations]);

  // The nearest drop the listener could still claim.
  const nearest = useMemo(() => {
    if (!position) return null;
    let best: { drop: MapDrop; distance: number } | null = null;
    for (const d of located) {
      if (d.claimed || !d.exact || soldOut(d)) continue;
      const distance = distanceM(position.lat, position.lng, d.lat, d.lng);
      if (!best || distance < best.distance) best = { drop: d, distance };
    }
    return best;
  }, [position, located]);

  useEffect(() => {
    if (!nearest || nearest.distance > nearest.drop.radius_m) return;
    if (alerted.current.has(nearest.drop.id)) return;
    alerted.current.add(nearest.drop.id);
    notify('You found a Geotones drop', `“${nearest.drop.title}” is right here. Open the app to claim it.`);
  }, [nearest]);

  useEffect(() => {
    if (!focusDropId || !drops.length) return;
    const d = located.find((x) => x.id === focusDropId);
    if (d) {
      setSelectedId(d.id);
      setFocus({ lat: d.lat, lng: d.lng });
    }
    onFocused();
  }, [focusDropId, drops, located, onFocused]);

  const selected = located.find((d) => d.id === selectedId);
  const distance = selected && position ? distanceM(position.lat, position.lng, selected.lat, selected.lng) : null;

  function select(id: string) {
    if (id.startsWith('station:')) {
      setSelectedId(null);
      setStationId(id.slice('station:'.length));
      return;
    }
    setStationId(null);
    setSelectedId(id);
    setMessage('');
    setPreview(null);
  }

  async function claim(drop: MapDrop) {
    if (!position) return;
    setBusy(true);
    setMessage('');
    const { data, error } = await supabase.rpc('claim_drop', {
      p_drop_id: drop.id, p_lat: position.lat, p_lng: position.lng, p_accuracy_m: position.accuracy, p_codes: codes,
    });
    setBusy(false);
    if (error) return setMessage(error.message);
    if (data.status === 'claimed') {
      setMessage(data.max_claims
        ? `It’s yours: copy ${data.edition} of ${data.max_claims}. Find it in your library.`
        : data.edition === 1 ? 'It’s yours, and you’re the first to find it. Find it in your library.'
        : 'It’s yours. Find it in your library.');
    } else if (data.status === 'too_far') {
      setMessage(drop.exact
        ? `You’re ${formatDistance(data.distance_m)} away. Get within ${formatDistance(drop.radius_m)}.`
        : 'Not here yet. Keep looking inside the area; the pin appears when you’re close.');
    } else {
      setMessage(CLAIM_MESSAGES[data.status] ?? data.status);
    }
    if (['claimed', 'already_claimed', 'sold_out'].includes(data.status)) load(codes);
  }

  async function playPreview(drop: MapDrop) {
    try {
      setPreview({ id: drop.id, url: await fileLink('previews', drop.preview_path!) });
    } catch (e) {
      setMessage(`Couldn’t play the preview: ${(e as Error).message}`);
    }
  }

  async function report(drop: MapDrop) {
    if (!session) return onNeedSignIn();
    const reason = window.prompt('What’s wrong with this drop? For example: not the artist’s song, offensive, dangerous spot.');
    if (!reason?.trim()) return;
    const { error } = await supabase.from('reports').insert({ drop_id: drop.id, reason: reason.trim().slice(0, 1000) });
    setMessage(error
      ? error.code === '23505' ? 'You’ve already reported this drop.' : error.message
      : 'Thanks. A moderator will look at it.');
  }

  async function addCode(e: FormEvent) {
    e.preventDefault();
    const code = normaliseCode(codeInput);
    if (code.length < 4) return setCodeMessage('Codes are at least 4 letters or numbers.');
    const before = new Set(drops.map((d) => d.id));
    const next = [...new Set([...codes, code])];
    const rows = await load(next);
    const found = rows.filter((d) => d.is_private && !before.has(d.id));
    if (!found.length) return setCodeMessage('No live drop matches that code.');
    setCodes(next);
    saveCodes(next);
    setCodeInput('');
    setCodeOpen(false);
    setCodeMessage('');
    select(found[0].id);
    setFocus({ lat: found[0].lat, lng: found[0].lng });
  }

  const status = loadError || locationError;
  const station = stations.find((st) => st.id === stationId);

  return (
    <div className="map-page">
      <GeoMap pins={pins} me={position} focus={focus} onPinClick={select} />
      {status && <p className="banner" role="status">{status}</p>}
      {!status && nearest && nearest.distance <= NEAR_M && nearest.drop.id !== selectedId && (
        <button className="banner banner-action" onClick={() => { select(nearest.drop.id); setFocus({ lat: nearest.drop.lat, lng: nearest.drop.lng }); }}>
          {nearest.distance <= nearest.drop.radius_m
            ? `You’re in the zone for “${nearest.drop.title}”. Tap to claim.`
            : `“${nearest.drop.title}” is ${formatDistance(nearest.distance)} away.`}
        </button>
      )}

      {station && (
        <StationPlayer key={station.id} station={station} position={position}
          cover={station.cover_path ? covers[station.cover_path] : undefined}
          session={session} onNeedSignIn={onNeedSignIn} onClose={() => setStationId(null)} />
      )}

      {!selected && !station && (
        <div className="map-tools">
          {codeOpen ? (
            <form className="code-form" onSubmit={addCode}>
              <input aria-label="Private drop code" placeholder="Enter a code" value={codeInput} autoFocus
                autoCapitalize="characters" onChange={(e) => setCodeInput(e.target.value)} />
              <button className="small">Add</button>
              <button type="button" className="small" onClick={() => { setCodeOpen(false); setCodeMessage(''); }}>Cancel</button>
              {codeMessage && <p className="note" role="status">{codeMessage}</p>}
            </form>
          ) : (
            <button className="small floating" onClick={() => setCodeOpen(true)}>Have a code?</button>
          )}
        </div>
      )}

      {selected && (
        <section className="sheet">
          <button className="close" aria-label="Close" onClick={() => setSelectedId(null)}>×</button>
          <div className="sheet-head">
            {selected.cover_path && covers[selected.cover_path]
              ? <img className="cover" src={covers[selected.cover_path]} alt="" />
              : <div className="cover cover-blank" aria-hidden="true">♪</div>}
            <div>
              <h2>{selected.title}</h2>
              <ArtistFollow artistId={selected.artist_id} name={selected.artist_name} session={session} onNeedSignIn={onNeedSignIn} />
              <p className="muted">
                {[selected.place_name, distance !== null && selected.exact ? `${formatDistance(distance)} away` : null]
                  .filter(Boolean).join(' · ')}
              </p>
            </div>
          </div>
          <div className="tags">
            {selected.is_private && <span className="tag">Private</span>}
            {selected.max_claims !== null && (
              <span className="tag">{soldOut(selected) ? 'Sold out'
                : `${selected.max_claims - selected.claims_count} of ${selected.max_claims} left`}</span>
            )}
            {selected.trail_title && <span className="tag">Trail: {selected.trail_title}</span>}
          </div>
          {!selected.exact && (
            <p className="note">Hidden pin. It’s somewhere inside the dotted area and appears when you get close.
              {selected.hint && <><br /><strong>Hint:</strong> {selected.hint}</>}</p>
          )}
          {selected.notes && <p className="note">{selected.notes}</p>}
          {selected.preview_path && (preview?.id === selected.id
            ? <audio className="preview" controls autoPlay src={preview.url} />
            : <button className="small" onClick={() => playPreview(selected)}>▶ Play 30-second preview</button>)}
          {selected.claimed ? <p className="note">In your library.</p>
            : !session ? <button className="primary" onClick={onNeedSignIn}>Sign in to claim</button>
            : <button className="primary" disabled={busy || !position || soldOut(selected)} onClick={() => claim(selected)}>
                {soldOut(selected) ? 'Sold out' : position ? 'Claim this song' : 'Waiting for your location…'}
              </button>}
          {message && <p className="note" role="status">{message}</p>}
          <button className="link report" onClick={() => report(selected)}>Report this drop</button>
        </section>
      )}
    </div>
  );
}
