import { useCallback, useEffect, useMemo, useState } from 'react';
import { coverLinks, playLink, supabase } from './supabase';
import { offlineLink, removeOffline, saveOffline, savedOffline } from './offline';
import { shareCard, shareImage } from './share';

type Song = {
  drop_id: string;
  title: string;
  artist_name: string;
  audio_path: string;
  cover_path: string | null;
  claimed_at: string;
  edition: number;
  max_claims: number | null;
  place_name: string | null;
  notes: string | null;
  lyrics: string | null;
  message: string | null;
  lat: number | null;
  lng: number | null;
  trail_title: string | null;
  is_bonus: boolean;
};

type Trail = {
  id: string;
  title: string;
  description: string | null;
  artist_name: string;
  total: number;
  found: number;
  has_bonus: boolean;
  bonus_claimed: boolean;
};

const CACHE_KEY = 'geotones.library';

function editionLabel(s: Song) {
  if (s.edition === 1) return s.max_claims ? `#1 of ${s.max_claims} · First finder` : 'First finder';
  return s.max_claims ? `#${s.edition} of ${s.max_claims}` : `Finder #${s.edition}`;
}

export default function Library({ userId }: { userId: string }) {
  const [songs, setSongs] = useState<Song[] | null>(null);
  const [trails, setTrails] = useState<Trail[]>([]);
  const [covers, setCovers] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [playing, setPlaying] = useState<{ id: string; url: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const cacheKey = `${CACHE_KEY}.${userId}`;

  const load = useCallback(async () => {
    const [library, overview] = await Promise.all([supabase.rpc('my_library'), supabase.rpc('trails_overview')]);
    if (library.error) {
      // Offline or unreachable: fall back to the last list this device saw.
      try {
        setSongs(JSON.parse(localStorage.getItem(cacheKey) ?? '[]'));
      } catch {
        setSongs([]);
      }
      setOffline(true);
    } else {
      const rows = library.data as Song[];
      setSongs(rows);
      setOffline(false);
      try {
        localStorage.setItem(cacheKey, JSON.stringify(rows));
      } catch {
        // Storage full or blocked; the list just won't be there offline.
      }
      coverLinks(rows.map((s) => s.cover_path)).then(setCovers);
    }
    setTrails((overview.data ?? []) as Trail[]);
    setSaved(await savedOffline());
  }, [cacheKey]);

  useEffect(() => { load(); }, [load]);

  const stats = useMemo(() => {
    const list = songs ?? [];
    const places = new Set(list.map((s) => s.place_name?.trim().toLowerCase()
      || (s.lat !== null && s.lng !== null ? `${s.lat.toFixed(2)},${s.lng.toFixed(2)}` : null)).filter(Boolean));
    return {
      found: list.length,
      firsts: list.filter((s) => s.edition === 1).length,
      places: places.size,
      trails: trails.filter((t) => t.total > 0 && t.found === t.total).length,
    };
  }, [songs, trails]);

  async function play(song: Song) {
    setMessage('');
    try {
      const url = (await offlineLink(song.drop_id)) ?? await playLink(song.audio_path);
      setPlaying({ id: song.drop_id, url });
    } catch (e) {
      setMessage(`Couldn’t play “${song.title}”: ${(e as Error).message}`);
    }
  }

  async function toggleOffline(song: Song) {
    setBusy(song.drop_id);
    setMessage('');
    try {
      if (saved.has(song.drop_id)) await removeOffline(song.drop_id);
      else await saveOffline(song.drop_id, await playLink(song.audio_path));
      setSaved(await savedOffline());
    } catch (e) {
      setMessage((e as Error).message);
    }
    setBusy(null);
  }

  async function share(song: Song) {
    setBusy(song.drop_id);
    setMessage('');
    try {
      const blob = await shareCard({
        title: song.title,
        artist: song.artist_name,
        place: song.place_name,
        edition: song.edition,
        maxClaims: song.max_claims,
        coverUrl: song.cover_path ? covers[song.cover_path] ?? null : null,
      });
      await shareImage(blob, `I found ${song.title} on Geotones`);
    } catch (e) {
      setMessage(`Couldn’t share: ${(e as Error).message}`);
    }
    setBusy(null);
  }

  async function unlock(trail: Trail) {
    setBusy(trail.id);
    const { data, error } = await supabase.rpc('claim_trail_bonus', { p_trail_id: trail.id });
    setBusy(null);
    if (error) return setMessage(error.message);
    setMessage(data.status === 'claimed' ? `Bonus track unlocked for “${trail.title}”.`
      : data.status === 'locked' ? `Find ${data.remaining} more on this trail first.`
      : data.status === 'sold_out' ? 'Every copy of the bonus track has been claimed.'
      : data.status === 'already_claimed' ? 'You already have the bonus track.'
      : 'The bonus track isn’t available right now.');
    load();
  }

  return (
    <div className="page">
      <h1>Your collection</h1>
      {offline && <p className="note" role="status">You’re offline. Showing the songs this device knows about; saved ones will play.</p>}
      <div className="stats">
        <div><strong>{stats.found}</strong><span>songs found</span></div>
        <div><strong>{stats.firsts}</strong><span>first finds</span></div>
        <div><strong>{stats.places}</strong><span>places</span></div>
        <div><strong>{stats.trails}</strong><span>trails done</span></div>
      </div>
      {message && <p className="note" role="status">{message}</p>}

      {trails.length > 0 && (
        <>
          <h2>Trails</h2>
          <ul className="list">
            {trails.map((t) => (
              <li key={t.id}>
                <div className="grow">
                  <strong>{t.title}</strong>
                  <p className="muted">{t.artist_name} · {t.found} of {t.total} found</p>
                  {t.description && <p className="muted">{t.description}</p>}
                  <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={t.total} aria-valuenow={t.found}>
                    <span style={{ width: `${t.total ? (100 * t.found) / t.total : 0}%` }} />
                  </div>
                </div>
                {t.has_bonus && (t.bonus_claimed
                  ? <span className="tag">Bonus unlocked</span>
                  : <button disabled={busy === t.id || t.found < t.total} onClick={() => unlock(t)}>
                      {t.found < t.total ? 'Bonus locked' : 'Unlock bonus'}
                    </button>)}
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>Songs</h2>
      {songs?.length === 0 && <p className="muted">Nothing yet. Go to a pin on the map and claim your first song.</p>}
      <ul className="list">
        {songs?.map((s) => (
          <li key={s.drop_id} className="song">
            <div className="song-head">
              {s.cover_path && covers[s.cover_path]
                ? <img className="thumb" src={covers[s.cover_path]} alt="" />
                : <div className="thumb cover-blank" aria-hidden="true">♪</div>}
              <div className="grow">
                <strong>{s.title}</strong>
                <p className="muted">{s.artist_name}{s.place_name && ` · ${s.place_name}`}</p>
                <p className="muted">
                  {editionLabel(s)} · found {new Date(s.claimed_at).toLocaleDateString()}
                  {s.is_bonus && ` · bonus track${s.trail_title ? ` of ${s.trail_title}` : ''}`}
                </p>
              </div>
            </div>
            {playing?.id === s.drop_id && <audio controls autoPlay src={playing.url} />}
            <div className="actions">
              {playing?.id !== s.drop_id && <button onClick={() => play(s)}>Play</button>}
              <button disabled={busy === s.drop_id} onClick={() => toggleOffline(s)}>
                {saved.has(s.drop_id) ? 'Saved ✓' : 'Save offline'}
              </button>
              <button disabled={busy === s.drop_id || offline} onClick={() => share(s)}>Share</button>
              {(s.notes || s.lyrics || s.message) && (
                <button onClick={() => setOpen(open === s.drop_id ? null : s.drop_id)}>
                  {open === s.drop_id ? 'Less' : 'More'}
                </button>
              )}
            </div>
            {open === s.drop_id && (
              <div className="details">
                {s.message && <><h3>From the artist</h3><p>{s.message}</p></>}
                {s.notes && <><h3>About</h3><p>{s.notes}</p></>}
                {s.lyrics && <><h3>Lyrics</h3><p className="lyrics">{s.lyrics}</p></>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
