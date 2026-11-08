import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { LocalAudioTrack, Room } from 'livekit-client';
import { fileLink, supabase, uploadOwn } from './supabase';
import { formatDistance, parseCoordinates } from './geo';
import { formatTime, resizeCover } from './media';
import GeoMap from './GeoMap';
import type { Pin } from './GeoMap';
import { usePosition } from './usePosition';
import { audioDuration, liveTicket } from './radio';
import type { StationTrack } from './radio';

type MyStation = {
  id: string;
  title: string;
  description: string | null;
  lat: number;
  lng: number;
  radius_m: number;
  cover_path: string | null;
  started_at: string;
  on_air: boolean;
  hidden: boolean;
  tracks: (StationTrack & { position: number })[];
};

const MAX_FILE_BYTES = 50 * 1024 * 1024;

export default function Stations({ userId }: { userId: string }) {
  const { position, locationError } = usePosition();
  const [spot, setSpot] = useState<{ lat: number; lng: number } | null>(null);
  const [focus, setFocus] = useState<{ lat: number; lng: number } | null>(null);
  const [pasted, setPasted] = useState('');
  const [spotError, setSpotError] = useState('');
  const [radius, setRadius] = useState(500);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [cover, setCover] = useState<File | null>(null);
  const [rights, setRights] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formMessage, setFormMessage] = useState('');
  const [stations, setStations] = useState<MyStation[]>([]);
  const [listMessage, setListMessage] = useState('');

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('my_stations');
    if (error) setListMessage(error.message);
    else setStations(data as MyStation[]);
  }, []);

  useEffect(() => { load(); }, [load]);

  const pins = useMemo<Pin[]>(() => [
    ...stations.map((s): Pin => ({ id: s.id, lat: s.lat, lng: s.lng, radius_m: s.radius_m, kind: 'station' })),
    ...(spot ? [{ id: 'draft', ...spot, radius_m: radius, kind: 'draft' as const }] : []),
  ], [stations, spot, radius]);

  function placeAt(lat: number, lng: number) {
    setSpot({ lat, lng });
    setFocus({ lat, lng });
    setSpotError('');
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    if (!spot) return setFormMessage('Choose where the station broadcasts: use your location, paste coordinates, or click the map.');
    setBusy(true);
    let coverPath: string | null = null;
    try {
      if (cover) {
        setFormMessage('Uploading the cover…');
        coverPath = await uploadOwn('covers', userId, await resizeCover(cover), '.jpg', 'image/jpeg');
      }
      const { error } = await supabase.from('stations').insert({
        title: title.trim(), description: description.trim() || null, lat: spot.lat, lng: spot.lng,
        radius_m: radius, cover_path: coverPath, rights_confirmed: rights,
      });
      if (error) throw new Error(`Couldn’t create the station: ${error.message}`);
      setFormMessage(`“${title.trim()}” is on the map. Add tracks or go live below.`);
      form.reset();
      setTitle('');
      setDescription('');
      setCover(null);
      setRights(false);
      setSpot(null);
      load();
    } catch (err) {
      if (coverPath) await supabase.storage.from('covers').remove([coverPath]);
      setFormMessage((err as Error).message);
    }
    setBusy(false);
  }

  return (
    <div className="artist">
      <div className="artist-map">
        <GeoMap pins={pins} me={position} focus={focus} onMapClick={(lat, lng) => { setSpot({ lat, lng }); setSpotError(''); }} />
        {!spot && <p className="banner">Click the map, or set the location in the form.</p>}
      </div>
      <div className="page">
        <form className="stack" onSubmit={create}>
          <h1>Start a radio station</h1>
          <p className="muted">People inside the zone can tune in. Play a playlist that runs on its own, go live, or both:
            going live takes over from the playlist until you stop.</p>
          <label>Station name
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />
          </label>
          <label>About the station (optional)
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} rows={2} />
          </label>
          <label>Cover art (optional)
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setCover(e.target.files?.[0] ?? null)} />
          </label>
          <fieldset>
            <legend>Location</legend>
            <button type="button" onClick={() => position ? placeAt(position.lat, position.lng)
              : setSpotError(locationError || 'Still finding your location. Try again in a moment.')}>Use my location</button>
            <div className="paste">
              <input aria-label="Coordinates or map link" placeholder="Paste coordinates or a map link"
                value={pasted} onChange={(e) => setPasted(e.target.value)} />
              <button type="button" onClick={() => {
                const c = parseCoordinates(pasted);
                if (c) placeAt(c.lat, c.lng);
                else setSpotError('Paste coordinates like -33.9249, 18.4241, or a map link that contains them.');
              }}>Go</button>
            </div>
            <p className="muted" role="status">
              {spot ? `Centre at ${spot.lat.toFixed(5)}, ${spot.lng.toFixed(5)}` : 'Or click the map to place the centre.'}
            </p>
            {spotError && <p className="note" role="alert">{spotError}</p>}
          </fieldset>
          <label>Broadcast zone: {formatDistance(radius)} around the centre
            <input type="range" min={50} max={20000} step={50} value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
          </label>
          <label className="check">
            <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} required />
            I own the rights to everything I play on this station, or have permission or broadcast licences for it.
          </label>
          <button className="primary" disabled={busy}>Put the station on the map</button>
          {formMessage && <p className="note" role="status">{formMessage}</p>}
        </form>

        <h2>Your stations</h2>
        {listMessage && <p className="note" role="alert">{listMessage}</p>}
        {stations.length === 0 && <p className="muted">No stations yet.</p>}
        <ul className="list">
          {stations.map((s) => <StationCard key={s.id} station={s} userId={userId} onChange={load} />)}
        </ul>
      </div>
    </div>
  );
}

function StationCard({ station, userId, onChange }: { station: MyStation; userId: string; onChange: () => void }) {
  const [message, setMessage] = useState('');
  const [uploading, setUploading] = useState(false);
  const [playing, setPlaying] = useState<{ id: string; url: string } | null>(null);
  const total = station.tracks.reduce((sum, t) => sum + t.duration_s, 0);

  async function addTracks(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    let position = station.tracks.reduce((max, t) => Math.max(max, t.position), -1) + 1;
    for (const file of Array.from(files)) {
      const name = file.name.replace(/\.[^.]+$/, '').slice(0, 200) || 'Untitled';
      if (file.size > MAX_FILE_BYTES) {
        setMessage(`${file.name} is over the 50 MB limit, so it was skipped.`);
        continue;
      }
      let path: string | null = null;
      try {
        setMessage(`Uploading ${file.name}…`);
        const duration = await audioDuration(file);
        const extension = file.name.includes('.') ? `.${file.name.split('.').pop()!.toLowerCase()}` : '';
        path = await uploadOwn('station-audio', userId, file, extension, file.type);
        const { error } = await supabase.from('station_tracks').insert({
          station_id: station.id, position: position++, title: name, audio_path: path, duration_s: duration,
        });
        if (error) throw new Error(error.message);
        setMessage('');
      } catch (e) {
        if (path) await supabase.storage.from('station-audio').remove([path]);
        setMessage(`${file.name}: ${(e as Error).message}`);
      }
    }
    setUploading(false);
    onChange();
  }

  async function move(index: number, by: number) {
    const a = station.tracks[index];
    const b = station.tracks[index + by];
    if (!a || !b) return;
    // Renumber the whole list so equal positions can't get stuck.
    const order = [...station.tracks];
    order[index] = b;
    order[index + by] = a;
    await Promise.all(order.map((t, i) => supabase.from('station_tracks').update({ position: i }).eq('id', t.id)));
    onChange();
  }

  async function remove(t: StationTrack) {
    if (!window.confirm(`Take “${t.title}” out of the playlist? The file is deleted too.`)) return;
    const { error } = await supabase.from('station_tracks').delete().eq('id', t.id);
    if (!error) await supabase.storage.from('station-audio').remove([t.audio_path]);
    setMessage(error ? error.message : '');
    onChange();
  }

  async function restart() {
    const { error } = await supabase.from('stations').update({ started_at: new Date().toISOString() }).eq('id', station.id);
    setMessage(error ? error.message : 'The playlist starts again from the top for everyone.');
  }

  async function removeStation() {
    if (!window.confirm(`Delete “${station.title}”? Its playlist files are deleted too. This can’t be undone.`)) return;
    const { error } = await supabase.from('stations').delete().eq('id', station.id);
    if (error) return setMessage(error.message);
    const files = station.tracks.map((t) => t.audio_path);
    if (files.length) await supabase.storage.from('station-audio').remove(files);
    if (station.cover_path) await supabase.storage.from('covers').remove([station.cover_path]);
    onChange();
  }

  async function play(t: StationTrack) {
    try {
      setPlaying({ id: t.id, url: await fileLink('station-audio', t.audio_path) });
    } catch (e) {
      setMessage((e as Error).message);
    }
  }

  return (
    <li className="song">
      <div className="grow">
        <strong>{station.title}</strong>
        <p className="muted">
          {station.hidden ? 'Taken down by a moderator' : station.on_air ? '● On air' : 'Off air'} · {formatDistance(station.radius_m)} zone
          · {station.tracks.length} {station.tracks.length === 1 ? 'track' : 'tracks'}{total > 0 && `, ${formatTime(total)} loop`}
        </p>
      </div>

      <h3>Playlist</h3>
      {station.tracks.length === 0 && <p className="muted">Empty. Listeners hear nothing unless you’re live.</p>}
      <ol className="playlist">
        {station.tracks.map((t, i) => (
          <li key={t.id}>
            <span className="grow">{t.title} <span className="muted">{formatTime(t.duration_s)}</span></span>
            <span className="actions">
              {playing?.id === t.id ? <audio controls autoPlay src={playing.url} />
                : <button className="small" onClick={() => play(t)} aria-label={`Play ${t.title}`}>▶</button>}
              <button className="small" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${t.title} up`}>↑</button>
              <button className="small" disabled={i === station.tracks.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${t.title} down`}>↓</button>
              <button className="small" onClick={() => remove(t)} aria-label={`Remove ${t.title}`}>✕</button>
            </span>
          </li>
        ))}
      </ol>
      <label>Add tracks (50 MB each at most)
        <input type="file" accept="audio/*" multiple disabled={uploading}
          onChange={(e) => { addTracks(e.target.files); e.target.value = ''; }} />
      </label>

      <GoLive station={station} onChange={onChange} />

      <div className="actions">
        {station.tracks.length > 0 && <button onClick={restart}>Restart playlist</button>}
        <button className="danger" onClick={removeStation}>Delete station</button>
      </div>
      {message && <p className="note" role="status">{message}</p>}
    </li>
  );
}

function GoLive({ station, onChange }: { station: MyStation; onChange: () => void }) {
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [level, setLevel] = useState(0);
  const session = useRef<{ room: Room; track: LocalAudioTrack; timer: number; meter: number; context: AudioContext } | null>(null);

  async function listInputs() {
    try {
      // Device names only show once the browser has microphone permission.
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      setInputs(devices);
      setDeviceId((current) => current || devices[0]?.deviceId || '');
    } catch {
      setMessage('Allow microphone access to broadcast.');
    }
  }

  const end = useCallback(async () => {
    const s = session.current;
    session.current = null;
    if (!s) return;
    clearInterval(s.timer);
    cancelAnimationFrame(s.meter);
    s.context.close();
    s.track.stop();
    await s.room.disconnect();
    await supabase.rpc('station_heartbeat', { p_station_id: station.id, p_live: false });
  }, [station.id]);

  // Going off air if the page closes. The 90-second timeout covers a crash.
  useEffect(() => {
    const leave = () => { end(); };
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      end();
    };
  }, [end]);

  async function start() {
    setBusy(true);
    setMessage('Connecting…');
    let track: LocalAudioTrack | null = null;
    try {
      const { AudioPresets, createLocalAudioTrack, Room } = await import('livekit-client');
      // Music settings: no echo cancelling, noise removal or automatic volume.
      track = await createLocalAudioTrack({
        deviceId: deviceId || undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        channelCount: 2,
      });
      const ticket = await liveTicket(station.id);
      const room = new Room();
      await room.connect(ticket.url, ticket.token);
      await room.localParticipant.publishTrack(track, {
        audioPreset: AudioPresets.musicHighQualityStereo, dtx: false, red: true, forceStereo: true,
      });
      const beat = () => supabase.rpc('station_heartbeat', { p_station_id: station.id, p_live: true });
      const { error } = await beat();
      if (error) throw new Error(error.message);
      const timer = window.setInterval(beat, 30000);

      const context = new AudioContext();
      const analyser = context.createAnalyser();
      context.createMediaStreamSource(new MediaStream([track.mediaStreamTrack])).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      let meter = 0;
      const draw = () => {
        analyser.getFloatTimeDomainData(samples);
        setLevel(Math.min(1, Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length) * 4));
        meter = requestAnimationFrame(draw);
        if (session.current) session.current.meter = meter;
      };
      session.current = { room, track, timer, meter, context };
      draw();
      setLive(true);
      setMessage('');
      onChange();
    } catch (e) {
      track?.stop();
      setMessage(`Couldn’t go live: ${(e as Error).message}`);
    }
    setBusy(false);
  }

  async function stop() {
    setBusy(true);
    await end();
    setLive(false);
    setLevel(0);
    setBusy(false);
    onChange();
  }

  return (
    <fieldset>
      <legend>Live broadcast</legend>
      {live ? (
        <>
          <p className="note"><span className="dot" aria-hidden="true" />You’re on air. Keep this page open.</p>
          <div className="meter" aria-label="Input level"><span style={{ width: `${Math.round(level * 100)}%` }} /></div>
          <button className="primary" disabled={busy} onClick={stop}>End broadcast</button>
        </>
      ) : (
        <>
          <p className="muted">Broadcast from this device’s microphone, or from Ableton through your audio interface
            or a loopback device such as BlackHole. Listeners hear you within about a second.</p>
          {inputs.length === 0
            ? <button type="button" onClick={listInputs}>Choose an input</button>
            : (
              <select aria-label="Audio input" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
                {inputs.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Input ${i + 1}`}</option>)}
              </select>
            )}
          <button className="primary" disabled={busy || station.hidden} onClick={start}>Go live</button>
        </>
      )}
      {message && <p className="note" role="status">{message}</p>}
    </fieldset>
  );
}
