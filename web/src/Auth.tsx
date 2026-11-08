import { useState } from 'react';
import type { FormEvent } from 'react';
import { supabase } from './supabase';

export default function Auth() {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage('');
    if (creating) {
      const { data, error } = await supabase.auth.signUp({
        email, password,
        options: { data: { display_name: name }, emailRedirectTo: window.location.origin + window.location.pathname },
      });
      if (error) setMessage(error.message);
      else if (!data.session) setMessage('Check your email for a link to confirm your account, then sign in here.');
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setMessage(error.message);
    }
    setBusy(false);
  }

  return (
    <form className="card narrow" onSubmit={submit}>
      <h1>{creating ? 'Create your account' : 'Sign in'}</h1>
      {creating && (
        <label>Name shown on your drops
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
        </label>
      )}
      <label>Email
        <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </label>
      <label>Password
        <input type="password" autoComplete={creating ? 'new-password' : 'current-password'} minLength={8}
          value={password} onChange={(e) => setPassword(e.target.value)} required />
      </label>
      <button className="primary" disabled={busy}>{creating ? 'Create account' : 'Sign in'}</button>
      {message && <p role="status" className="note">{message}</p>}
      <button type="button" className="link" onClick={() => { setCreating(!creating); setMessage(''); }}>
        {creating ? 'I already have an account' : 'Create an account'}
      </button>
    </form>
  );
}
