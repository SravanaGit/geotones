// Hands out a LiveKit ticket (a signed token) for a station's live broadcast.
// The database decides who may have one: live_pass() lets the owner broadcast
// and lets tuned-in listeners hear it while the station is on air.
// Needs three secrets set in Supabase: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

export async function signToken(claims: Record<string, unknown>, secret: string) {
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(unsigned)));
  return `${unsigned}.${base64url(signature)}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' });

  const url = Deno.env.get('LIVEKIT_URL');
  const apiKey = Deno.env.get('LIVEKIT_API_KEY');
  const apiSecret = Deno.env.get('LIVEKIT_API_SECRET');
  if (!url || !apiKey || !apiSecret) return reply(503, { error: 'Live radio isn’t set up on this server yet.' });

  const authorization = req.headers.get('Authorization');
  if (!authorization) return reply(401, { error: 'Sign in first.' });

  let stationId: unknown;
  try {
    stationId = (await req.json()).station_id;
  } catch {
    return reply(400, { error: 'Send {"station_id": "..."}.' });
  }
  if (typeof stationId !== 'string') return reply(400, { error: 'Send {"station_id": "..."}.' });

  // Ask as the caller, so the database's own rules decide.
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authorization } },
  });
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) return reply(401, { error: 'Sign in first.' });
  const { data: pass, error } = await supabase.rpc('live_pass', { p_station_id: stationId });
  if (error) return reply(403, { error: 'You need to be in the station’s zone while it’s on air.' });

  const host = pass.role === 'host';
  const now = Math.floor(Date.now() / 1000);
  const token = await signToken({
    iss: apiKey,
    sub: user.user.id,
    name: pass.name,
    nbf: now - 10,
    // Listeners re-ask every few minutes, so leaving the zone ends access.
    exp: now + (host ? 4 * 3600 : 15 * 60),
    video: { room: pass.room, roomJoin: true, canPublish: host, canSubscribe: true, canPublishData: false },
  }, apiSecret);

  return reply(200, { url, token, role: pass.role });
});
