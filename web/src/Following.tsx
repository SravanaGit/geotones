import { useEffect, useState } from 'react';
import { coverLinks, supabase } from './supabase';

type FeedItem = {
  id: string;
  title: string;
  artist_id: string;
  artist_name: string;
  place_name: string | null;
  cover_path: string | null;
  created_at: string;
  claimed: boolean;
};

const SEEN_KEY = 'geotones.feedSeen';

export default function Following({ onShowOnMap }: { onShowOnMap: (dropId: string) => void }) {
  const [feed, setFeed] = useState<FeedItem[] | null>(null);
  const [follows, setFollows] = useState<{ artist_id: string; display_name: string }[]>([]);
  const [covers, setCovers] = useState<Record<string, string>>({});
  const [seen] = useState(() => {
    try {
      return Number(localStorage.getItem(SEEN_KEY) ?? 0);
    } catch {
      return 0;
    }
  });

  async function load() {
    const [f, a] = await Promise.all([supabase.rpc('following_feed'), supabase.rpc('my_follows')]);
    const rows = (f.data ?? []) as FeedItem[];
    setFeed(rows);
    setFollows(a.data ?? []);
    coverLinks(rows.map((r) => r.cover_path)).then(setCovers);
    try {
      localStorage.setItem(SEEN_KEY, String(Date.now()));
    } catch {
      // Without storage everything just stays marked as new.
    }
  }

  useEffect(() => { load(); }, []);

  async function unfollow(artistId: string) {
    await supabase.from('follows').delete().eq('artist_id', artistId);
    load();
  }

  return (
    <div className="page">
      <h1>Following</h1>
      {follows.length === 0 && (
        <p className="muted">You don’t follow anyone yet. Open a drop on the map and tap Follow next to the artist’s name.</p>
      )}
      {feed && feed.length > 0 && (
        <>
          <h2>Live drops from artists you follow</h2>
          <ul className="list">
            {feed.map((d) => (
              <li key={d.id}>
                <div className="song-head grow">
                  {d.cover_path && covers[d.cover_path]
                    ? <img className="thumb" src={covers[d.cover_path]} alt="" />
                    : <div className="thumb cover-blank" aria-hidden="true">♪</div>}
                  <div>
                    <strong>{d.title}</strong>
                    {new Date(d.created_at).getTime() > seen && <span className="tag new">New</span>}
                    <p className="muted">{d.artist_name}{d.place_name && ` · ${d.place_name}`}</p>
                    {d.claimed && <p className="muted">In your library</p>}
                  </div>
                </div>
                <button onClick={() => onShowOnMap(d.id)}>Show on map</button>
              </li>
            ))}
          </ul>
        </>
      )}
      {feed?.length === 0 && follows.length > 0 && <p className="muted">No live drops from the artists you follow right now.</p>}
      {follows.length > 0 && (
        <>
          <h2>Artists</h2>
          <ul className="list">
            {follows.map((a) => (
              <li key={a.artist_id}>
                <strong>{a.display_name}</strong>
                <button onClick={() => unfollow(a.artist_id)}>Unfollow</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
