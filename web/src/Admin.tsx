import { useCallback, useEffect, useState } from 'react';
import { playLink, supabase } from './supabase';

type Report = {
  report_id: string;
  reason: string;
  reported_at: string;
  resolved_at: string | null;
  drop_id: string;
  title: string;
  artist_name: string;
  audio_path: string;
  hidden_at: string | null;
  report_count: number;
};

export default function Admin() {
  const [reports, setReports] = useState<Report[] | null>(null);
  const [playing, setPlaying] = useState<{ id: string; url: string } | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('admin_reports');
    if (error) setError(error.message);
    setReports((data ?? []) as Report[]);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function act(call: PromiseLike<{ error: { message: string } | null }>) {
    const { error } = await call;
    setError(error ? error.message : '');
    load();
  }

  async function play(r: Report) {
    try {
      setPlaying({ id: r.report_id, url: await playLink(r.audio_path) });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="page">
      <h1>Reports</h1>
      {error && <p className="note" role="alert">{error}</p>}
      {reports?.length === 0 && <p className="muted">No reports.</p>}
      <ul className="list">
        {reports?.map((r) => (
          <li key={r.report_id} className="song">
            <div className="grow">
              <strong>{r.title}</strong>
              <p className="muted">{r.artist_name} · {r.report_count} {r.report_count === 1 ? 'report' : 'reports'} · {new Date(r.reported_at).toLocaleString()}</p>
              <p>“{r.reason}”</p>
              <p className="muted">
                {r.hidden_at ? 'Taken down' : 'Live'}{r.resolved_at && ' · resolved'}
              </p>
            </div>
            {playing?.id === r.report_id && <audio controls autoPlay src={playing.url} />}
            <div className="actions">
              {playing?.id !== r.report_id && <button onClick={() => play(r)}>Listen</button>}
              <button onClick={() => act(supabase.rpc('admin_set_hidden', { p_drop_id: r.drop_id, p_hidden: !r.hidden_at }))}>
                {r.hidden_at ? 'Restore' : 'Take down'}
              </button>
              {!r.resolved_at && (
                <button onClick={() => act(supabase.rpc('admin_resolve_report', { p_report_id: r.report_id }))}>Mark resolved</button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
