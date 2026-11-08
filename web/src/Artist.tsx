import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { playLink, supabase, uploadOwn } from './supabase';
import type { Bucket } from './supabase';
import { formatDistance, parseCoordinates } from './geo';
import { decodeAudio, formatTime, PREVIEW_SECONDS, previewClip, resizeCover } from './media';
import GeoMap from './GeoMap';
import type { Pin } from './GeoMap';
import { usePosition } from './usePosition';
import DropEditor from './DropEditor';

export type MyDrop = {
  id: string;
  title: string;
  lat: number | null;
  lng: number | null;
  radius_m: number;
  audio_path: string;
  cover_path: string | null;
  preview_path: string | null;
  opens_at: string;
  closes_at: string | null;
  hidden_at: string | null;
  place_name: string | null;
  notes: string | null;
  lyrics: string | null;
  message: string | null;
  max_claims: number | null;
  hide_pin: boolean;
  hint: string | null;
  access_code: string | null;
  trail_id: string | null;
  trail_title: string | null;
  is_bonus: boolean;
  claims_count: number;
  claims_7d: number;
  last_claimed_at: string | null;
};

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const NEW_TRAIL = '__new__';

function status(d: MyDrop): string {
  const now = Date.now();
  if (d.hidden_at) return 'Taken down by a moderator';
  if (new Date(d.opens_at).getTime() > now) return `Opens ${new Date(d.opens_at).toLocaleString()}`;
  if (d.closes_at && new Date(d.closes_at).getTime() <= now) return 'Closed';
  return d.closes_at ? `Live until ${new Date(d.closes_at).toLocaleString()}` : 'Live';
}

function isLive(d: MyDrop) {
  return status(d).startsWith('Live');
}

function randomCode() {
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (n) => letters[n % letters.length]).join('');
}

function ago(iso: string) {
  const hours = (Date.now() - new Date(iso).getTime()) / 3600000;
  if (hours < 1) return 'within the hour';
  if (hours < 48) return `${Math.round(hours)} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export default function Artist({ userId }: { userId: string }) {
  const { position, locationError } = usePosition();
  const [spot, setSpot] = useState<{ lat: number; lng: number } | null>(null);
  const [focus, setFocus] = useState<{ lat: number; lng: number } | null>(null);
  const [pasted, setPasted] = useState('');
  const [spotError, setSpotError] = useState('');
  const [radius, setRadius] = useState(50);
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [decoded, setDecoded] = useState<AudioBuffer | null>(null);
  const [decodeNote, setDecodeNote] = useState('');
  const [previewStart, setPreviewStart] = useState(0);
  const [audition, setAudition] = useState<string | null>(null);
  const [cover, setCover] = useState<File | null>(null);
  const [placeName, setPlaceName] = useState('');
  const [notes, setNotes] = useState('');
  const [lyrics, setLyrics] = useState('');
  const [message, setMessageText] = useState('');
  const [opensAt, setOpensAt] = useState('');
  const [closesAt, setClosesAt] = useState('');
  const [limited, setLimited] = useState('');
  const [hidePin, setHidePin] = useState(false);
  const [hint, setHint] = useState('');
  const [code, setCode] = useState('');
  const [trailId, setTrailId] = useState('');
  const [newTrail, setNewTrail] = useState('');
  const [bonus, setBonus] = useState(false);
  const [rights, setRights] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formMessage, setFormMessage] = useState('');
  const [drops, setDrops] = useState<MyDrop[]>([]);
  const [trails, setTrails] = useState<{ id: string; title: string }[]>([]);
  const [playing, setPlaying] = useState<{ id: string; url: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [listMessage, setListMessage] = useState('');

  const load = useCallback(async () => {
    const [mine, myTrails] = await Promise.all([
      supabase.rpc('my_drops'),
      supabase.from('trails').select('id, title').eq('artist_id', userId).order('title'),
    ]);
    if (mine.error) setListMessage(mine.error.message);
    else setDrops(mine.data as MyDrop[]);
    setTrails(myTrails.data ?? []);
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  const pins = useMemo<Pin[]>(() => (
    spot && !bonus ? [{ id: 'draft', ...spot, radius_m: radius, kind: 'draft' }] : []
  ), [spot, radius, bonus]);

  function placeAt(lat: number, lng: number) {
    setSpot({ lat, lng });
    setFocus({ lat, lng });
    setSpotError('');
  }

  function useMyLocation() {
    if (position) placeAt(position.lat, position.lng);
    else setSpotError(locationError || 'Still finding your location. Try again in a moment.');
  }

  function usePasted() {
    const coordinates = parseCoordinates(pasted);
    if (coordinates) placeAt(coordinates.lat, coordinates.lng);
    else setSpotError('Paste coordinates like -33.9249, 18.4241, or a map link that contains them.');
  }

  async function chooseAudio(chosen: File | null) {
    setFile(chosen);
    setDecoded(null);
    setAudition(null);
    setPreviewStart(0);
    setDecodeNote('');
    if (!chosen) return;
    try {
      setDecodeNote('Reading the song for the preview…');
      const buffer = await decodeAudio(chosen);
      setDecoded(buffer);
      setPreviewStart(Math.max(0, Math.min(30, buffer.duration - PREVIEW_SECONDS)));
      setDecodeNote('');
    } catch {
      setDecodeNote('This browser can’t read that file for a preview, so the drop will have no preview.');
    }
  }

  function listenToPreview() {
    if (!decoded) return;
    if (audition) URL.revokeObjectURL(audition);
    setAudition(URL.createObjectURL(previewClip(decoded, previewStart)));
  }

  function reset(form: HTMLFormElement) {
    form.reset();
    for (const set of [setTitle, setPlaceName, setNotes, setLyrics, setMessageText, setOpensAt, setClosesAt,
      setLimited, setHint, setCode, setNewTrail, setPasted]) set('');
    setFile(null);
    setDecoded(null);
    setAudition(null);
    setCover(null);
    setSpot(null);
    setHidePin(false);
    setBonus(false);
    setRights(false);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    if (!bonus && !spot) return setFormMessage('Choose where this song lives: use your location, paste coordinates, or click the map.');
    if (!file) return setFormMessage('Choose an audio file.');
    if (file.size > MAX_FILE_BYTES) return setFormMessage('That file is over the 50 MB limit.');
    const opens = opensAt ? new Date(opensAt).getTime() : Date.now();
    if (closesAt && new Date(closesAt).getTime() <= opens) {
      return setFormMessage(opensAt
        ? 'The closing time must be after the opening time.'
        : 'The closing time must be in the future. Change it, or leave it blank to keep the drop open.');
    }
    const copies = limited ? Number(limited) : null;
    if (copies !== null && (!Number.isInteger(copies) || copies < 1)) return setFormMessage('Limited copies must be a whole number, 1 or more.');
    if (code && !/^[A-Z0-9]{4,20}$/.test(code)) return setFormMessage('Private codes are 4 to 20 letters or numbers.');
    if (trailId === NEW_TRAIL && !newTrail.trim()) return setFormMessage('Give the new trail a name.');
    if (bonus && !trailId) return setFormMessage('A bonus track has to belong to a trail.');

    setBusy(true);
    const uploaded: [Bucket, string][] = [];
    try {
      setFormMessage('Uploading the song…');
      const extension = file.name.includes('.') ? `.${file.name.split('.').pop()!.toLowerCase()}` : '';
      const audioPath = await uploadOwn('audio', userId, file, extension, file.type);
      uploaded.push(['audio', audioPath]);

      let coverPath: string | null = null;
      if (cover) {
        setFormMessage('Uploading the cover…');
        coverPath = await uploadOwn('covers', userId, await resizeCover(cover), '.jpg', 'image/jpeg');
        uploaded.push(['covers', coverPath]);
      }

      let previewPath: string | null = null;
      if (decoded) {
        setFormMessage('Making the preview…');
        previewPath = await uploadOwn('previews', userId, previewClip(decoded, previewStart), '.wav', 'audio/wav');
        uploaded.push(['previews', previewPath]);
      }

      let trail: string | null = trailId || null;
      if (trailId === NEW_TRAIL) {
        const { data, error } = await supabase.from('trails').insert({ title: newTrail.trim() }).select('id').single();
        if (error) throw new Error(`Couldn’t create the trail: ${error.message}`);
        trail = data.id;
      }

      const { error } = await supabase.from('drops').insert({
        title: title.trim(),
        lat: bonus ? null : spot!.lat,
        lng: bonus ? null : spot!.lng,
        radius_m: radius,
        audio_path: audioPath,
        cover_path: coverPath,
        preview_path: previewPath,
        rights_confirmed: rights,
        place_name: placeName.trim() || null,
        notes: notes.trim() || null,
        lyrics: lyrics.trim() || null,
        message: message.trim() || null,
        max_claims: copies,
        hide_pin: !bonus && hidePin,
        hint: hidePin && hint.trim() ? hint.trim() : null,
        access_code: code || null,
        trail_id: trail,
        is_bonus: bonus,
        ...(opensAt && { opens_at: new Date(opensAt).toISOString() }),
        ...(closesAt && { closes_at: new Date(closesAt).toISOString() }),
      });
      if (error) throw new Error(`Couldn’t create the drop: ${error.message}`);
      setFormMessage(bonus ? `“${title.trim()}” is the trail’s bonus track.` : `“${title.trim()}” is on the map.`);
      reset(form);
      load();
    } catch (err) {
      // Remove anything uploaded for a drop that never got created.
      for (const [bucket, path] of uploaded) await supabase.storage.from(bucket).remove([path]);
      setFormMessage((err as Error).message);
    }
    setBusy(false);
  }

  async function closeDrop(d: MyDrop) {
    if (!window.confirm(`Close “${d.title}”? Nobody new can claim it, but people who already have it keep it.`)) return;
    const { error } = await supabase.from('drops').update({ closes_at: new Date().toISOString() }).eq('id', d.id);
    setListMessage(error ? error.message : '');
    load();
  }

  async function play(d: MyDrop) {
    try {
      setPlaying({ id: d.id, url: await playLink(d.audio_path) });
    } catch (e) {
      setListMessage(`Couldn’t play this song: ${(e as Error).message}`);
    }
  }

  return (
    <div className="artist">
      <div className="artist-map">
        <GeoMap pins={pins} me={position} focus={focus}
          onMapClick={(lat, lng) => { if (!bonus) { setSpot({ lat, lng }); setSpotError(''); } }} />
        {!spot && !bonus && <p className="banner">Click the map, or set the location in the form.</p>}
      </div>
      <div className="page">
        <form className="stack" onSubmit={submit}>
          <h1>Drop a song</h1>
          <label>Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />
          </label>
          <label>Audio file (50 MB maximum)
            <input type="file" accept="audio/*" onChange={(e) => chooseAudio(e.target.files?.[0] ?? null)} required />
          </label>
          {decodeNote && <p className="muted">{decodeNote}</p>}
          {decoded && (
            <fieldset>
              <legend>Preview</legend>
              <p className="muted">Anyone can hear these 30 seconds from anywhere. The full song still needs the walk.</p>
              <label>Starts at {formatTime(previewStart)}
                <input type="range" min={0} max={Math.max(0, Math.floor(decoded.duration - PREVIEW_SECONDS))} step={1}
                  value={previewStart} onChange={(e) => { setPreviewStart(Number(e.target.value)); setAudition(null); }} />
              </label>
              {audition ? <audio controls autoPlay src={audition} /> : <button type="button" onClick={listenToPreview}>Listen to the preview</button>}
            </fieldset>
          )}
          <label>Cover art (optional)
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setCover(e.target.files?.[0] ?? null)} />
          </label>
          <label>Place name (optional)
            <input value={placeName} onChange={(e) => setPlaceName(e.target.value)} maxLength={100} placeholder="For example: Maboneng, Johannesburg" />
          </label>
          <label>About this drop (optional, everyone sees it)
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} rows={2} />
          </label>
          <label>Message for people who find it (optional)
            <textarea value={message} onChange={(e) => setMessageText(e.target.value)} maxLength={2000} rows={2} />
          </label>
          <label>Lyrics (optional, only for people who find it)
            <textarea value={lyrics} onChange={(e) => setLyrics(e.target.value)} maxLength={20000} rows={3} />
          </label>

          <fieldset>
            <legend>Trail (optional)</legend>
            <select aria-label="Trail" value={trailId} onChange={(e) => { setTrailId(e.target.value); if (!e.target.value) setBonus(false); }}>
              <option value="">Not part of a trail</option>
              {trails.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
              <option value={NEW_TRAIL}>+ New trail…</option>
            </select>
            {trailId === NEW_TRAIL && (
              <input aria-label="New trail name" placeholder="Trail name" value={newTrail} maxLength={200}
                onChange={(e) => setNewTrail(e.target.value)} />
            )}
            {trailId && (
              <label className="check">
                <input type="checkbox" checked={bonus} onChange={(e) => setBonus(e.target.checked)} />
                This is the bonus track. It has no location and unlocks when someone finds every drop on the trail.
              </label>
            )}
          </fieldset>

          {!bonus && (
            <>
              <fieldset>
                <legend>Location</legend>
                <button type="button" onClick={useMyLocation}>Use my location</button>
                <div className="paste">
                  <input aria-label="Coordinates or map link" placeholder="Paste coordinates or a map link"
                    value={pasted} onChange={(e) => setPasted(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); usePasted(); } }} />
                  <button type="button" onClick={usePasted}>Go</button>
                </div>
                <p className="muted" role="status">
                  {spot ? `Pin at ${spot.lat.toFixed(5)}, ${spot.lng.toFixed(5)}` : 'Or click the map to place the pin.'}
                </p>
                {spotError && <p className="note" role="alert">{spotError}</p>}
              </fieldset>
              <label>Claim zone: {formatDistance(radius)} around the pin
                <input type="range" min={25} max={5000} step={25} value={radius}
                  onChange={(e) => setRadius(Number(e.target.value))} />
              </label>
              <label className="check">
                <input type="checkbox" checked={hidePin} onChange={(e) => setHidePin(e.target.checked)} />
                Hide the exact pin. Listeners see a rough area and the pin appears when they get close.
              </label>
              {hidePin && (
                <label>Hint (optional)
                  <input value={hint} onChange={(e) => setHint(e.target.value)} maxLength={500} placeholder="For example: Under the big jacaranda" />
                </label>
              )}
            </>
          )}

          <div className="row">
            <label>Opens (optional)
              <input type="datetime-local" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} />
            </label>
            <label>Closes (optional)
              <input type="datetime-local" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} />
            </label>
          </div>
          <div className="row">
            <label>Limited copies (optional)
              <input type="number" min={1} step={1} inputMode="numeric" value={limited} placeholder="Unlimited"
                onChange={(e) => setLimited(e.target.value)} />
            </label>
            <label>Private code (optional)
              <span className="paste">
                <input value={code} maxLength={20} placeholder="Public" autoCapitalize="characters"
                  onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />
                <button type="button" onClick={() => setCode(randomCode())}>Make one</button>
              </span>
            </label>
          </div>
          {code && <p className="muted">Only people who enter {code} on the map will see this drop.</p>}

          <label className="check">
            <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} required />
            I own the rights to this track, or have permission to release it.
          </label>
          <p className="muted">Anyone who claims this song keeps it, even after you close the drop.</p>
          <button className="primary" disabled={busy}>{bonus ? 'Add bonus track' : 'Drop it'}</button>
          {formMessage && <p className="note" role="status">{formMessage}</p>}
        </form>

        <h2>Your drops</h2>
        {listMessage && <p className="note" role="alert">{listMessage}</p>}
        {drops.length === 0 && <p className="muted">Nothing dropped yet.</p>}
        <ul className="list">
          {drops.map((d) => (
            <li key={d.id} className="song">
              <div className="grow">
                <strong>{d.title}</strong>
                <p className="muted">
                  {status(d)} · {d.is_bonus ? `bonus track of ${d.trail_title}` : `${formatDistance(d.radius_m)} zone`}
                  {!d.is_bonus && d.trail_title && ` · trail: ${d.trail_title}`}
                </p>
                <p className="muted">
                  {d.claims_count} {d.claims_count === 1 ? 'claim' : 'claims'}
                  {d.max_claims !== null && ` of ${d.max_claims}`} · {d.claims_7d} this week
                  {d.last_claimed_at && ` · last ${ago(d.last_claimed_at)}`}
                </p>
                {(d.access_code || d.hide_pin) && (
                  <p className="muted">
                    {d.access_code && `Private code: ${d.access_code}`}
                    {d.access_code && d.hide_pin && ' · '}
                    {d.hide_pin && 'Hidden pin'}
                  </p>
                )}
              </div>
              {playing?.id === d.id && <audio controls autoPlay src={playing.url} />}
              <div className="actions">
                {playing?.id !== d.id && <button onClick={() => play(d)}>Play</button>}
                <button onClick={() => setEditing(editing === d.id ? null : d.id)}>{editing === d.id ? 'Cancel edit' : 'Edit'}</button>
                {isLive(d) && <button onClick={() => closeDrop(d)}>Close drop</button>}
              </div>
              {editing === d.id && (
                <DropEditor drop={d} userId={userId} onDone={() => { setEditing(null); load(); }} />
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
