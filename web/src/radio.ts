import { supabase } from './supabase';

export type StationTrack = { id: string; title: string; audio_path: string; duration_s: number };

export type MapStation = {
  id: string;
  title: string;
  description: string | null;
  owner_id: string;
  owner_name: string;
  lat: number;
  lng: number;
  radius_m: number;
  cover_path: string | null;
  on_air: boolean;
  track_count: number;
  mine: boolean;
};

export type Tuned = {
  status: 'tuned';
  expires_at: string;
  now: string;
  started_at: string;
  on_air: boolean;
  tracks: StationTrack[];
};

export type TuneResult = Tuned | { status: Exclude<string, 'tuned'>; distance_m?: number };

export const TUNE_MESSAGES: Record<string, string> = {
  not_available: 'This station isn’t on the map any more.',
  invalid_location: 'Your device sent a location we couldn’t read. Try again.',
  simulated_location: 'This device appears to be faking its location.',
  low_accuracy: 'Your location is too rough to confirm. Try again outside, away from buildings.',
};

// Where the playlist is right now. Everyone in the zone works this out from the
// same start time, so they all hear the same moment, like radio.
export function playlistNow(tuned: Tuned, receivedAt: number) {
  const total = tuned.tracks.reduce((sum, t) => sum + t.duration_s, 0);
  if (!total) return null;
  const elapsed = (new Date(tuned.now).getTime() - new Date(tuned.started_at).getTime()
    + (performance.now() - receivedAt)) / 1000;
  let at = ((elapsed % total) + total) % total;
  for (let index = 0; index < tuned.tracks.length; index++) {
    const track = tuned.tracks[index];
    if (at < track.duration_s) return { index, track, offset: at };
    at -= track.duration_s;
  }
  return { index: 0, track: tuned.tracks[0], offset: 0 };
}

// A LiveKit ticket from the live-token server function. The database decides
// whether the caller may broadcast (owner) or listen (tuned in, on air).
export async function liveTicket(stationId: string): Promise<{ url: string; token: string; role: string }> {
  const { data, error } = await supabase.functions.invoke('live-token', { body: { station_id: stationId } });
  if (error) {
    let message = error.message;
    try {
      message = (await (error as { context?: Response }).context?.json())?.error ?? message;
    } catch {
      // Keep the generic message.
    }
    throw new Error(message);
  }
  return data;
}

// Reads a track's length without decoding the whole file.
export function audioDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      Number.isFinite(audio.duration) && audio.duration > 0
        ? resolve(audio.duration)
        : reject(new Error(`Couldn’t read the length of ${file.name}.`));
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`This browser can’t play ${file.name}.`));
    };
    audio.src = url;
  });
}

// A tiny silent sound. Playing it straight from a tap lets iPhones play the
// real audio after the network calls finish.
export const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
