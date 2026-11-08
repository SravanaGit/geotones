// Claimed songs saved on this device so they play without signal. They stay inside the app.
const CACHE = 'geotones-audio';
const key = (dropId: string) => new URL(`offline/${dropId}`, location.href).toString();
const supported = () => typeof caches !== 'undefined';

export async function saveOffline(dropId: string, url: string) {
  if (!supported()) throw new Error('This browser can’t save songs offline.');
  const response = await fetch(url);
  if (!response.ok) throw new Error('Couldn’t download the song.');
  const type = response.headers.get('Content-Type') ?? 'audio/mpeg';
  const cache = await caches.open(CACHE);
  await cache.put(key(dropId), new Response(await response.blob(), { headers: { 'Content-Type': type } }));
}

export async function removeOffline(dropId: string) {
  if (supported()) await (await caches.open(CACHE)).delete(key(dropId));
}

export async function offlineLink(dropId: string): Promise<string | null> {
  if (!supported()) return null;
  const hit = await (await caches.open(CACHE)).match(key(dropId));
  return hit ? URL.createObjectURL(await hit.blob()) : null;
}

export async function savedOffline(): Promise<Set<string>> {
  if (!supported()) return new Set();
  const keys = await (await caches.open(CACHE)).keys();
  return new Set(keys.map((request) => request.url.split('/offline/')[1]));
}
