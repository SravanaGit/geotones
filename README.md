# Geotones

Artists drop songs on a map. Listeners go to the spot to claim them, and keep them in the app.

Working name. Web app now; an iPhone app comes later.

## What's here

- `supabase/migrations/` — the backend: tables, access rules and functions, applied in order.
- `test/` — backend tests on a throwaway local Postgres. Run `test/run.sh` (needs Homebrew Postgres).
- `supabase/functions/live-token/` — server function that hands out LiveKit tickets for live radio.
- `web/` — the web app (React, MapLibre maps with OpenFreeMap tiles, Supabase, LiveKit for live audio).

## Features

- Drops with a claim zone, opening and closing times, cover art, a 30-second preview anyone can hear, and lyrics and a message only finders see.
- Limited editions with numbered copies, hidden pins that show a rough area and a hint, private drops behind a code.
- Trails: a set of drops that unlocks a bonus track once all are found.
- Collection with stats, offline listening, and share cards for social posts.
- Following artists, with a feed of their live drops.
- Local radio stations: a zone on the map where people tune in to a playlist that plays on a shared clock (everyone hears the same moment), or to the artist broadcasting live. Live takes over from the playlist until it stops.
- Reports and a moderator view (drops and stations); account deletion.
- Alerts while the app is open when a drop is near. Background alerts need the iPhone app.

## Running the web app

```bash
cd web
cp .env.example .env.local   # then fill in the Supabase URL and publishable key
npm install
npm run dev                  # http://localhost:5183
```

## Publishing

`web/deploy.sh` builds the app and pushes it to the `gh-pages` branch, served by GitHub Pages.

## Backend changes

Paste each new file from `supabase/migrations/` into the Supabase SQL editor and run it, oldest first.
Run `test/run.sh` before applying any change.

To make someone a moderator, run in the SQL editor:

```sql
insert into public.admins (user_id) select id from auth.users where email = 'their@email';
```

## Live radio setup

Playlists work with Supabase alone. Live broadcasts also need LiveKit (a real-time audio service):

1. Make a free project at [cloud.livekit.io](https://cloud.livekit.io). Note its URL (`wss://….livekit.cloud`), API key and API secret.
2. In Supabase: Edge Functions → Secrets, add `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`.
3. In Supabase: Edge Functions → Deploy a new function → Via editor. Name it `live-token`, paste `supabase/functions/live-token/index.ts`, deploy.

Listeners are checked against the zone when they join and every minute after; leaving the zone stops their player.
A listener who keeps an old LiveKit connection open after leaving is not cut off by the server.
