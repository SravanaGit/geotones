import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { Bucket } from './supabase';

export default function Account({ session }: { session: Session }) {
  const userId = session.user.id;
  const [name, setName] = useState('');
  const [nameMessage, setNameMessage] = useState('');
  const [permission, setPermission] = useState(() => ('Notification' in window ? Notification.permission : 'unsupported'));
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteMessage, setDeleteMessage] = useState('');

  useEffect(() => {
    supabase.from('profiles').select('display_name').eq('id', userId).single()
      .then(({ data }) => setName(data?.display_name ?? ''));
  }, [userId]);

  async function saveName(e: FormEvent) {
    e.preventDefault();
    const { error } = await supabase.from('profiles').update({ display_name: name.trim() }).eq('id', userId);
    setNameMessage(error ? error.message : 'Saved.');
  }

  async function enableNotifications() {
    setPermission(await Notification.requestPermission());
  }

  async function deleteAccount(e: FormEvent) {
    e.preventDefault();
    setDeleting(true);
    setDeleteMessage('Closing your drops and stations…');
    const retired = await supabase.rpc('retire_my_drops');
    if (retired.error) {
      setDeleting(false);
      return setDeleteMessage(retired.error.message);
    }
    // Remove files no drop uses any more. Storage refuses files listeners still own.
    setDeleteMessage('Removing unused files…');
    for (const bucket of ['audio', 'covers', 'previews', 'station-audio'] as Bucket[]) {
      const { data } = await supabase.storage.from(bucket).list(userId, { limit: 1000 });
      const paths = (data ?? []).map((f) => `${userId}/${f.name}`);
      if (paths.length) await supabase.storage.from(bucket).remove(paths);
    }
    setDeleteMessage('Deleting your account…');
    const { error } = await supabase.rpc('delete_my_account');
    if (error) {
      setDeleting(false);
      return setDeleteMessage(error.message);
    }
    await supabase.auth.signOut();
  }

  return (
    <div className="page">
      <h1>Account</h1>
      <p className="muted">Signed in as {session.user.email}</p>

      <form className="stack" onSubmit={saveName}>
        <label>Your name on drops
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
        </label>
        <button>Save name</button>
        {nameMessage && <p className="note" role="status">{nameMessage}</p>}
      </form>

      <h2>Alerts</h2>
      <p className="muted">
        While Geotones is open, it tells you when a drop is near. On iPhone, alerts outside the app need it added to
        your Home Screen first: tap Share, then Add to Home Screen.
      </p>
      {permission === 'granted' && <p className="note">Notifications are on.</p>}
      {permission === 'default' && <button onClick={enableNotifications}>Turn on notifications</button>}
      {permission === 'denied' && <p className="note">Notifications are blocked in this browser’s settings.</p>}
      {permission === 'unsupported' && <p className="note">This browser can’t show notifications. Add Geotones to your Home Screen first.</p>}

      <h2>Sign out</h2>
      <button onClick={() => supabase.auth.signOut()}>Sign out</button>

      <h2>Delete account</h2>
      <p className="muted">
        This can’t be undone. Drops nobody has claimed are deleted. Drops people have claimed close, and stay in
        their libraries under “Former artist”. Your own collection is deleted.
      </p>
      <form className="stack" onSubmit={deleteAccount}>
        <label>Type DELETE to confirm
          <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoCapitalize="characters" />
        </label>
        <button className="danger" disabled={confirmText !== 'DELETE' || deleting}>Delete my account</button>
        {deleteMessage && <p className="note" role="status">{deleteMessage}</p>}
      </form>
    </div>
  );
}
