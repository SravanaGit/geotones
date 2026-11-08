import { useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import type { RemoteTrack, Room } from 'livekit-client';
import { fileLink, supabase } from './supabase';
import { distanceM, formatDistance } from './geo';
import type { Position } from './usePosition';
import { liveTicket, playlistNow, SILENCE, TUNE_MESSAGES } from './radio';
import type { MapStation, Tuned } from './radio';
import ArtistFollow from './ArtistFollow';

type Mode = 'off' | 'tuning' | 'playlist' | 'live' | 'quiet';

// Re-checks the listener's location this often while they listen.
const RENEW_MS = 60 * 1000;

export default function StationPlayer({ station, position, cover, session, onNeedSignIn, onClose }: {
  station: MapStation;
  position: Position | null;
  cover: string | undefined;
  session: Session | null;
  onNeedSignIn: () => void;
  onClose: () => void;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const room = useRef<Room | null>(null);
  const tuned = useRef<{ data: Tuned; at: number } | null>(null);
  const trackId = useRef<string | null>(null);
  const active = useRef(false);
  const positionRef = useRef(position);
  positionRef.current = position;
  const [mode, setMode] = useState<Mode>('off');
  const [nowPlaying, setNowPlaying] = useState('');
  const [message, setMessage] = useState('');

  const distance = position ? distanceM(position.lat, position.lng, station.lat, station.lng) : null;

  function leaveRoom() {
    room.current?.disconnect();
    room.current = null;
  }

  function stop(note = '') {
    active.current = false;
    leaveRoom();
    const el = audio.current;
    if (el) {
      el.pause();
      el.srcObject = null;
      el.removeAttribute('src');
    }
    trackId.current = null;
    tuned.current = null;
    setMode('off');
    setNowPlaying('');
    setMessage(note);
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  }

  useEffect(() => () => stop(), []);

  function showOnLockScreen(title: string) {
    setNowPlaying(title);
    if ('mediaSession' in navigator && 'MediaMetadata' in window) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title, artist: `${station.title} · ${station.owner_name}`, album: 'Geotones radio',
        ...(cover && { artwork: [{ src: cover }] }),
      });
    }
  }

  // Returns the playlist and clock, or why the listener can't hear the station.
  async function tune(): Promise<Tuned | string> {
    const p = positionRef.current;
    const { data, error } = await supabase.rpc('tune_in', {
      p_station_id: station.id, p_lat: p?.lat ?? null, p_lng: p?.lng ?? null, p_accuracy_m: p?.accuracy ?? null,
    });
    if (error) return error.message;
    if (data.status !== 'tuned') {
      return data.status === 'too_far'
        ? `You’re ${formatDistance(data.distance_m)} from the station. Get inside its ${formatDistance(station.radius_m)} zone.`
        : TUNE_MESSAGES[data.status] ?? data.status;
    }
    tuned.current = { data, at: performance.now() };
    return data;
  }

  async function playFromClock(skipId?: string) {
    const el = audio.current!;
    const t = tuned.current;
    if (!t) return;
    let now = playlistNow(t.data, t.at);
    if (!now) {
      el.pause();
      setMode('quiet');
      showOnLockScreen('Off air');
      return;
    }
    // A file can end a moment before the clock says it should.
    if (skipId && now.track.id === skipId) {
      const index = (now.index + 1) % t.data.tracks.length;
      now = { index, track: t.data.tracks[index], offset: 0 };
    }
    const url = await fileLink('station-audio', now.track.audio_path);
    if (!active.current) return;
    const offset = now.offset;
    el.srcObject = null;
    el.src = url;
    el.onloadedmetadata = () => {
      el.onloadedmetadata = null;
      if (offset > 1) el.currentTime = offset;
    };
    trackId.current = now.track.id;
    setMode('playlist');
    showOnLockScreen(now.track.title);
    await el.play().catch(() => setMessage('Tap Tune in again to start the sound.'));
  }

  async function joinLive() {
    const el = audio.current!;
    // Loaded on first use, so the map opens faster.
    const [{ Room, RoomEvent, Track }, ticket] = await Promise.all([import('livekit-client'), liveTicket(station.id)]);
    if (!active.current) return;
    const r = new Room();
    r.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind !== Track.Kind.Audio) return;
      el.removeAttribute('src');
      track.attach(el);
      el.play().catch(() => setMessage('Tap Tune in again to start the sound.'));
    });
    // The broadcaster stopped: go back to the playlist, if there is one.
    r.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      track.detach(el);
      if (active.current) setTimeout(renew, 1500);
    });
    r.on(RoomEvent.Disconnected, () => {
      if (room.current === r) room.current = null;
    });
    await r.connect(ticket.url, ticket.token);
    room.current = r;
    trackId.current = null;
    setMode('live');
    showOnLockScreen('Live now');
  }

  async function apply(t: Tuned) {
    if (t.on_air) {
      if (!room.current) {
        try {
          await joinLive();
          return;
        } catch (e) {
          setMessage(`Couldn’t join the live broadcast: ${(e as Error).message}`);
        }
      } else return;
    }
    leaveRoom();
    const now = playlistNow(t, tuned.current!.at);
    const el = audio.current!;
    // Keep playing if this is the right song and it hasn't drifted.
    if (now && trackId.current === now.track.id && !el.paused && Math.abs(el.currentTime - now.offset) < 4) {
      setMode('playlist');
      return;
    }
    await playFromClock();
  }

  async function renew() {
    if (!active.current) return;
    const t = await tune();
    if (!active.current) return;
    if (typeof t === 'string') return stop(t);
    await apply(t);
  }

  useEffect(() => {
    if (mode === 'off') return;
    const timer = setInterval(renew, RENEW_MS);
    return () => clearInterval(timer);
  }, [mode === 'off']);

  async function start() {
    if (!session) return onNeedSignIn();
    const el = audio.current!;
    // Start a sound straight from the tap, so iPhones allow the real one later.
    el.src = SILENCE;
    el.play().catch(() => {});
    active.current = true;
    setMessage('');
    setMode('tuning');
    const t = await tune();
    if (typeof t === 'string') return stop(t);
    await apply(t);
  }

  function ended() {
    if (active.current && mode === 'playlist') playFromClock(trackId.current ?? undefined);
  }

  const status = {
    off: '',
    tuning: 'Tuning in…',
    playlist: `Now playing: ${nowPlaying}`,
    live: 'Live now',
    quiet: 'Off air. Nothing is playing right now.',
  }[mode];

  return (
    <section className="sheet">
      <button className="close" aria-label="Close" onClick={() => { stop(); onClose(); }}>×</button>
      <div className="sheet-head">
        {cover ? <img className="cover" src={cover} alt="" />
          : <div className="cover cover-blank cover-radio" aria-hidden="true">📻</div>}
        <div>
          <h2>{station.title}</h2>
          <ArtistFollow artistId={station.owner_id} name={station.owner_name} session={session} onNeedSignIn={onNeedSignIn} />
          <p className="muted">
            Radio · {formatDistance(station.radius_m)} zone
            {distance !== null && ` · ${distance <= station.radius_m ? 'you’re inside' : `${formatDistance(distance - station.radius_m)} to the edge`}`}
          </p>
        </div>
      </div>
      <div className="tags">
        {station.on_air ? <span className="tag on-air">● On air</span> : <span className="tag">Off air</span>}
        <span className="tag">{station.track_count} {station.track_count === 1 ? 'track' : 'tracks'} in rotation</span>
      </div>
      {station.description && <p className="note">{station.description}</p>}
      <p className="muted">You can only hear this station inside its zone. It keeps checking while you listen.</p>
      {mode === 'off' || mode === 'tuning'
        ? <button className="primary" disabled={mode === 'tuning' || (!position && !station.mine)} onClick={start}>
            {!session ? 'Sign in to listen' : !position && !station.mine ? 'Waiting for your location…' : 'Tune in'}
          </button>
        : <button className="primary" onClick={() => stop()}>Stop</button>}
      {status && <p className="note" role="status">{mode === 'live' && <span className="dot" aria-hidden="true" />}{status}</p>}
      {message && <p className="note" role="alert">{message}</p>}
      <audio ref={audio} onEnded={ended} playsInline />
    </section>
  );
}
