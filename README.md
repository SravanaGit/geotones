# Geotones

Artists drop songs on a map. Listeners go to the spot to claim them, and keep them in the app.

Working name. Web app now; an iPhone app comes later.

## What's here

- `supabase/migrations/` — the backend: tables, access rules and functions, applied in order.
- `test/` — backend tests on a throwaway local Postgres. Run `test/run.sh` (needs Homebrew Postgres).
- `web/` — the web app (React, MapLibre maps with OpenFreeMap tiles, Supabase).

## Features

- Drops with a claim zone, opening and closing times, cover art, a 30-second preview anyone can hear, and lyrics and a message only finders see.
- Limited editions with numbered copies, hidden pins that show a rough area and a hint, private drops behind a code.
- Trails: a set of drops that unlocks a bonus track once all are found.
- Collection with stats, offline listening, and share cards for social posts.
- Following artists, with a feed of their live drops.
- Reports and a moderator view; account deletion.
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
