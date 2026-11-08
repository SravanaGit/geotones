import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

type Info = { display_name: string; followers: number; following: boolean };

// Artist name with a follow button, shown on a drop.
export default function ArtistFollow({ artistId, name, session, onNeedSignIn }: {
  artistId: string | null;
  name: string;
  session: Session | null;
  onNeedSignIn: () => void;
}) {
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!artistId) return;
    supabase.rpc('artist_info', { p_artist: artistId }).then(({ data }) => setInfo(data));
  }, [artistId, session]);

  const own = artistId && session?.user.id === artistId;

  async function toggle() {
    if (!session) return onNeedSignIn();
    if (!artistId || !info) return;
    setBusy(true);
    const { error } = info.following
      ? await supabase.from('follows').delete().eq('artist_id', artistId)
      : await supabase.from('follows').insert({ artist_id: artistId });
    if (!error) {
      setInfo({ ...info, following: !info.following, followers: info.followers + (info.following ? -1 : 1) });
    }
    setBusy(false);
  }

  return (
    <div className="artist-row">
      <span>
        {name}
        {info && <span className="muted"> · {info.followers} {info.followers === 1 ? 'follower' : 'followers'}</span>}
      </span>
      {artistId && !own && info && (
        <button className="small" onClick={toggle} disabled={busy}>{info.following ? 'Following' : 'Follow'}</button>
      )}
    </div>
  );
}
