import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import Listen from './Listen';
import Library from './Library';
import Following from './Following';
import Artist from './Artist';
import Stations from './Stations';
import Admin from './Admin';
import Account from './Account';
import Auth from './Auth';

type Tab = 'map' | 'library' | 'following' | 'artist' | 'admin' | 'account';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [tab, setTab] = useState<Tab>('map');
  const [signingIn, setSigningIn] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [focusDropId, setFocusDropId] = useState<string | null>(null);
  const [studio, setStudio] = useState<'song' | 'radio'>('song');

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (s) setSigningIn(false);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return setAdmin(false);
    supabase.rpc('is_admin').then(({ data }) => setAdmin(data === true));
  }, [session]);

  const go = (t: Tab) => { setTab(t); setSigningIn(false); };
  const onFocused = useCallback(() => setFocusDropId(null), []);

  const tabs: [Tab, string][] = [
    ['map', 'Map'], ['library', 'Collection'], ['following', 'Following'], ['artist', 'Drop'],
    ...(admin ? [['admin', 'Reports'] as [Tab, string]] : []),
    ['account', session ? 'Account' : 'Sign in'],
  ];

  const needsAccount = tab !== 'map' && !session;

  return (
    <div className="app">
      <header>
        <strong className="brand">Geotones</strong>
        <nav aria-label="Sections">
          {tabs.map(([id, label]) => (
            <button key={id} className={tab === id ? 'tab on' : 'tab'} aria-current={tab === id ? 'page' : undefined}
              onClick={() => go(id)}>
              {label}
            </button>
          ))}
        </nav>
      </header>
      <main>
        {signingIn || needsAccount ? <Auth /> : (
          <>
            {tab === 'map' && <Listen session={session} onNeedSignIn={() => setSigningIn(true)}
              focusDropId={focusDropId} onFocused={onFocused} />}
            {tab === 'library' && session && <Library userId={session.user.id} />}
            {tab === 'following' && session && <Following onShowOnMap={(id) => { setFocusDropId(id); go('map'); }} />}
            {tab === 'artist' && session && (
              <>
                <div className="switch" role="tablist" aria-label="What to make">
                  <button role="tab" aria-selected={studio === 'song'} className={studio === 'song' ? 'on' : ''}
                    onClick={() => setStudio('song')}>Song drop</button>
                  <button role="tab" aria-selected={studio === 'radio'} className={studio === 'radio' ? 'on' : ''}
                    onClick={() => setStudio('radio')}>Radio station</button>
                </div>
                {studio === 'song' ? <Artist userId={session.user.id} /> : <Stations userId={session.user.id} />}
              </>
            )}
            {tab === 'admin' && session && admin && <Admin />}
            {tab === 'account' && session && <Account session={session} />}
          </>
        )}
      </main>
    </div>
  );
}
