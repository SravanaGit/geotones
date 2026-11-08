import { useState } from 'react';
import type { FormEvent } from 'react';
import { supabase, uploadOwn } from './supabase';
import { resizeCover } from './media';
import type { MyDrop } from './Artist';

// Edits the parts of a drop an artist can change after it's out.
export default function DropEditor({ drop, userId, onDone }: { drop: MyDrop; userId: string; onDone: () => void }) {
  const [title, setTitle] = useState(drop.title);
  const [placeName, setPlaceName] = useState(drop.place_name ?? '');
  const [notes, setNotes] = useState(drop.notes ?? '');
  const [message, setMessage] = useState(drop.message ?? '');
  const [lyrics, setLyrics] = useState(drop.lyrics ?? '');
  const [hint, setHint] = useState(drop.hint ?? '');
  const [cover, setCover] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    let newCover: string | null = null;
    try {
      if (cover) newCover = await uploadOwn('covers', userId, await resizeCover(cover), '.jpg', 'image/jpeg');
      const { error: updateError } = await supabase.from('drops').update({
        title: title.trim(),
        place_name: placeName.trim() || null,
        notes: notes.trim() || null,
        message: message.trim() || null,
        lyrics: lyrics.trim() || null,
        ...(drop.hide_pin && { hint: hint.trim() || null }),
        ...(newCover && { cover_path: newCover }),
      }).eq('id', drop.id);
      if (updateError) throw new Error(updateError.message);
      // The old cover is no longer used by anything.
      if (newCover && drop.cover_path) await supabase.storage.from('covers').remove([drop.cover_path]);
      onDone();
    } catch (err) {
      if (newCover) await supabase.storage.from('covers').remove([newCover]);
      setError((err as Error).message);
    }
    setBusy(false);
  }

  return (
    <form className="stack editor" onSubmit={save}>
      <label>Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />
      </label>
      <label>{drop.cover_path ? 'Replace cover art' : 'Add cover art'}
        <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setCover(e.target.files?.[0] ?? null)} />
      </label>
      <label>Place name
        <input value={placeName} onChange={(e) => setPlaceName(e.target.value)} maxLength={100} />
      </label>
      <label>About this drop
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} rows={2} />
      </label>
      <label>Message for people who find it
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} rows={2} />
      </label>
      <label>Lyrics
        <textarea value={lyrics} onChange={(e) => setLyrics(e.target.value)} maxLength={20000} rows={3} />
      </label>
      {drop.hide_pin && (
        <label>Hint
          <input value={hint} onChange={(e) => setHint(e.target.value)} maxLength={500} />
        </label>
      )}
      <button className="primary" disabled={busy}>Save changes</button>
      {error && <p className="note" role="alert">{error}</p>}
    </form>
  );
}
