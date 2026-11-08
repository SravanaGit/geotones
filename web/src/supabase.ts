import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
);

export type Bucket = 'audio' | 'covers' | 'previews' | 'station-audio';

// Short-lived link to a stored file. Storage refuses it unless the policies allow the viewer.
export async function fileLink(bucket: Bucket, path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 3600);
  if (error) throw error;
  return data.signedUrl;
}

export const playLink = (audioPath: string) => fileLink('audio', audioPath);

const linkCache = new Map<string, { url: string; expires: number }>();

// Links for many covers at once, reused for most of their hour.
export async function coverLinks(paths: (string | null)[]): Promise<Record<string, string>> {
  const now = Date.now();
  const wanted = [...new Set(paths.filter((p): p is string => !!p))];
  const missing = wanted.filter((p) => (linkCache.get(p)?.expires ?? 0) < now);
  if (missing.length) {
    const { data } = await supabase.storage.from('covers').createSignedUrls(missing, 3600);
    for (const item of data ?? []) {
      if (item.signedUrl && item.path) linkCache.set(item.path, { url: item.signedUrl, expires: now + 50 * 60 * 1000 });
    }
  }
  return Object.fromEntries(wanted.flatMap((p) => {
    const hit = linkCache.get(p);
    return hit ? [[p, hit.url]] : [];
  }));
}

// Upload into the signed-in user's own folder, which is all the storage policies allow.
export async function uploadOwn(bucket: Bucket, userId: string, body: Blob, extension: string, contentType: string) {
  const path = `${userId}/${crypto.randomUUID()}${extension}`;
  const { error } = await supabase.storage.from(bucket).upload(path, body, { contentType });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  return path;
}
