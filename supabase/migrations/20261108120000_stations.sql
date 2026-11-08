-- Local radio stations. An artist puts a station on the map with a zone.
-- Inside the zone, listeners hear either the station's playlist, playing on a
-- shared clock so everyone hears the same moment, or the artist broadcasting
-- live. Live audio goes through LiveKit; the live-token server function asks
-- live_pass() below before handing anyone a LiveKit ticket.
-- Same rule as the earlier migrations: revoke Supabase's default grants on every
-- new object, then grant only what clients need.

-- Stations ------------------------------------------------------------------

create table public.stations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  description text check (char_length(description) <= 2000),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  radius_m integer not null default 500 check (radius_m between 50 and 20000),
  cover_path text,
  -- The playlist clock: the playlist started from the top at this moment and
  -- has looped ever since. Moving it forward restarts the playlist.
  started_at timestamptz not null default now(),
  -- The broadcaster's app touches this every 30 seconds while live.
  live_seen_at timestamptz,
  rights_confirmed boolean not null check (rights_confirmed),
  hidden_at timestamptz,
  created_at timestamptz not null default now()
);

create index stations_owner_id_idx on public.stations (owner_id);

alter table public.stations enable row level security;
revoke all on public.stations from anon, authenticated;
grant select (id, owner_id, title, description, lat, lng, radius_m, cover_path, started_at, created_at)
  on public.stations to anon, authenticated;
grant insert (title, description, lat, lng, radius_m, cover_path, rights_confirmed)
  on public.stations to authenticated;
grant update (title, description, lat, lng, radius_m, cover_path, started_at)
  on public.stations to authenticated;
grant delete on public.stations to authenticated;

create policy "stations are public unless taken down" on public.stations
  for select to anon, authenticated using (hidden_at is null or owner_id = auth.uid());

create policy "artists create their own stations" on public.stations
  for insert to authenticated with check (
    owner_id = auth.uid()
    and (cover_path is null or split_part(cover_path, '/', 1) = auth.uid()::text)
  );

create policy "artists edit their own stations" on public.stations
  for update to authenticated using (owner_id = auth.uid()) with check (
    owner_id = auth.uid()
    and (cover_path is null or split_part(cover_path, '/', 1) = auth.uid()::text)
  );

create policy "artists delete their own stations" on public.stations
  for delete to authenticated using (owner_id = auth.uid());

create function public.owns_station(p_station_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.stations s where s.id = p_station_id and s.owner_id = auth.uid());
$$;
revoke all on function public.owns_station(uuid) from public, anon, authenticated;
grant execute on function public.owns_station(uuid) to authenticated;

-- Playlist ------------------------------------------------------------------

create table public.station_tracks (
  id uuid primary key default gen_random_uuid(),
  station_id uuid not null references public.stations (id) on delete cascade,
  position integer not null default 0,
  title text not null check (char_length(title) between 1 and 200),
  audio_path text not null unique,
  duration_s double precision not null check (duration_s > 0 and duration_s <= 14400),
  created_at timestamptz not null default now()
);

create index station_tracks_station_id_idx on public.station_tracks (station_id, position);

-- Listeners never read this table; tune_in() hands them the playlist.
alter table public.station_tracks enable row level security;
revoke all on public.station_tracks from anon, authenticated;
grant select, delete on public.station_tracks to authenticated;
grant insert (station_id, position, title, audio_path, duration_s) on public.station_tracks to authenticated;
grant update (position, title) on public.station_tracks to authenticated;

create policy "artists see their own playlists" on public.station_tracks
  for select to authenticated using (public.owns_station(station_id));

create policy "artists add their own audio to their own stations" on public.station_tracks
  for insert to authenticated with check (
    public.owns_station(station_id) and split_part(audio_path, '/', 1) = auth.uid()::text
  );

create policy "artists reorder their own playlists" on public.station_tracks
  for update to authenticated
  using (public.owns_station(station_id)) with check (public.owns_station(station_id));

create policy "artists remove tracks from their own playlists" on public.station_tracks
  for delete to authenticated using (public.owns_station(station_id));

-- Tuning in -----------------------------------------------------------------

-- A pass lets one listener hear one station for a few minutes. The app renews
-- it while the listener stays in the zone. Positions are never stored.
create table public.station_passes (
  user_id uuid not null references public.profiles (id) on delete cascade,
  station_id uuid not null references public.stations (id) on delete cascade,
  expires_at timestamptz not null,
  primary key (user_id, station_id)
);

alter table public.station_passes enable row level security;
revoke all on public.station_passes from anon, authenticated;

create function public.station_on_air(p_station public.stations) returns boolean
language sql stable set search_path = '' as $$
  select p_station.live_seen_at is not null and p_station.live_seen_at > now() - interval '90 seconds';
$$;
revoke all on function public.station_on_air(public.stations) from public, anon, authenticated;

create function public.has_station_pass(p_station_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.station_passes p
    where p.station_id = p_station_id and p.user_id = auth.uid() and p.expires_at > now()
  );
$$;
revoke all on function public.has_station_pass(uuid) from public, anon, authenticated;

-- Returns {"status": ...}, one of: tuned, not_available, invalid_location,
-- simulated_location, low_accuracy, too_far (with distance_m). tuned includes
-- the playlist, the clock (started_at and the server's now) and on_air.
-- The station's owner can always tune in, from anywhere.
create function public.tune_in(
  p_station_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_accuracy_m double precision,
  p_simulated boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_station public.stations;
  v_distance double precision;
  v_expires timestamptz := now() + interval '10 minutes';
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  select * into v_station from public.stations s
  where s.id = p_station_id and s.hidden_at is null;
  if not found then
    return jsonb_build_object('status', 'not_available');
  end if;

  if v_station.owner_id <> auth.uid() then
    if p_lat is null or p_lng is null or p_accuracy_m is null
      or not (p_lat between -90 and 90)
      or not (p_lng between -180 and 180)
      or p_accuracy_m < 0 or p_accuracy_m = 'NaN'::double precision then
      return jsonb_build_object('status', 'invalid_location');
    end if;
    if coalesce(p_simulated, false) then
      return jsonb_build_object('status', 'simulated_location');
    end if;
    -- Rougher than claiming allows, since a radio zone is much bigger.
    if p_accuracy_m > greatest(100, v_station.radius_m / 4.0) then
      return jsonb_build_object('status', 'low_accuracy');
    end if;
    v_distance := public.distance_m(p_lat, p_lng, v_station.lat, v_station.lng);
    if v_distance > v_station.radius_m then
      return jsonb_build_object('status', 'too_far', 'distance_m', round(v_distance));
    end if;
  end if;

  insert into public.station_passes (user_id, station_id, expires_at)
  values (auth.uid(), p_station_id, v_expires)
  on conflict (user_id, station_id) do update set expires_at = excluded.expires_at;

  return jsonb_build_object(
    'status', 'tuned',
    'expires_at', v_expires,
    'now', now(),
    'started_at', v_station.started_at,
    'on_air', public.station_on_air(v_station),
    'tracks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'title', t.title, 'audio_path', t.audio_path, 'duration_s', t.duration_s
      ) order by t.position, t.created_at)
      from public.station_tracks t where t.station_id = p_station_id
    ), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.tune_in(uuid, double precision, double precision, double precision, boolean)
  from public, anon, authenticated;
grant execute on function public.tune_in(uuid, double precision, double precision, double precision, boolean)
  to authenticated;

-- Live ----------------------------------------------------------------------

-- The owner's app calls this every 30 seconds while broadcasting, and with
-- p_live false when it stops. A station with no touch for 90 seconds is off air.
create function public.station_heartbeat(p_station_id uuid, p_live boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.stations s set live_seen_at = case when p_live then now() end
  where s.id = p_station_id and s.owner_id = auth.uid() and s.hidden_at is null;
  if not found then
    raise exception 'not your station' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.station_heartbeat(uuid, boolean) from public, anon, authenticated;
grant execute on function public.station_heartbeat(uuid, boolean) to authenticated;

-- Asked by the live-token server function, as the signed-in user, before it
-- hands out a LiveKit ticket. The owner may broadcast; anyone holding a pass
-- may listen while the station is on air.
create function public.live_pass(p_station_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_station public.stations;
  v_name text;
begin
  select * into v_station from public.stations s
  where s.id = p_station_id and s.hidden_at is null;
  if not found or auth.uid() is null then
    raise exception 'no access to this station' using errcode = '42501';
  end if;
  select p.display_name into v_name from public.profiles p where p.id = auth.uid();

  if v_station.owner_id = auth.uid() then
    return jsonb_build_object('role', 'host', 'room', 'station-' || p_station_id, 'name', v_name);
  end if;
  if public.has_station_pass(p_station_id) and public.station_on_air(v_station) then
    return jsonb_build_object('role', 'listener', 'room', 'station-' || p_station_id, 'name', v_name);
  end if;
  raise exception 'no access to this station' using errcode = '42501';
end;
$$;
revoke all on function public.live_pass(uuid) from public, anon, authenticated;
grant execute on function public.live_pass(uuid) to authenticated;

-- Lists ---------------------------------------------------------------------

create function public.map_stations()
returns table (
  id uuid, title text, description text, owner_id uuid, owner_name text,
  lat double precision, lng double precision, radius_m integer, cover_path text,
  on_air boolean, track_count integer, mine boolean
)
language sql stable security definer set search_path = '' as $$
  select s.id, s.title, s.description, s.owner_id, p.display_name,
    s.lat, s.lng, s.radius_m, s.cover_path,
    public.station_on_air(s),
    (select count(*)::integer from public.station_tracks t where t.station_id = s.id),
    coalesce(s.owner_id = auth.uid(), false)
  from public.stations s
  join public.profiles p on p.id = s.owner_id
  where s.hidden_at is null;
$$;
revoke all on function public.map_stations() from public, anon, authenticated;
grant execute on function public.map_stations() to anon, authenticated;

create function public.my_stations() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id, 'title', s.title, 'description', s.description,
    'lat', s.lat, 'lng', s.lng, 'radius_m', s.radius_m, 'cover_path', s.cover_path,
    'started_at', s.started_at, 'on_air', public.station_on_air(s), 'hidden', s.hidden_at is not null,
    'tracks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'title', t.title, 'audio_path', t.audio_path, 'duration_s', t.duration_s, 'position', t.position
      ) order by t.position, t.created_at)
      from public.station_tracks t where t.station_id = s.id
    ), '[]'::jsonb)
  ) order by s.created_at desc), '[]'::jsonb)
  from public.stations s
  where s.owner_id = auth.uid();
$$;
revoke all on function public.my_stations() from public, anon, authenticated;
grant execute on function public.my_stations() to authenticated;

-- Moderation ------------------------------------------------------------------

create function public.admin_stations()
returns table (id uuid, title text, owner_name text, on_air boolean, hidden boolean, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'moderators only' using errcode = '42501';
  end if;
  return query
    select s.id, s.title, p.display_name, public.station_on_air(s), s.hidden_at is not null, s.created_at
    from public.stations s join public.profiles p on p.id = s.owner_id
    order by s.created_at desc;
end;
$$;
revoke all on function public.admin_stations() from public, anon, authenticated;
grant execute on function public.admin_stations() to authenticated;

-- Taking a station down also ends its passes, so nobody keeps listening.
create function public.admin_set_station_hidden(p_station_id uuid, p_hidden boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'moderators only' using errcode = '42501';
  end if;
  update public.stations s set
    hidden_at = case when p_hidden then now() end,
    live_seen_at = case when p_hidden then null else s.live_seen_at end
  where s.id = p_station_id;
  if p_hidden then
    delete from public.station_passes p where p.station_id = p_station_id;
  end if;
end;
$$;
revoke all on function public.admin_set_station_hidden(uuid, boolean) from public, anon, authenticated;
grant execute on function public.admin_set_station_hidden(uuid, boolean) to authenticated;

-- Account deletion: stations go too, so their files can be cleaned up.
create or replace function public.retire_my_drops() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  delete from public.stations s where s.owner_id = auth.uid();
  delete from public.drops d
  where d.artist_id = auth.uid()
    and not exists (select 1 from public.claims c where c.drop_id = d.id);
  update public.drops d set closes_at = greatest(now(), d.opens_at + interval '1 second')
  where d.artist_id = auth.uid() and (d.closes_at is null or d.closes_at > now());
end;
$$;

-- Storage -------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'station-audio', 'station-audio', false, 52428800,
  array['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/ogg']
);

create or replace function public.file_in_use(p_bucket text, p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.drops d
    where (p_bucket = 'audio' and d.audio_path = p_path)
      or (p_bucket = 'covers' and d.cover_path = p_path)
      or (p_bucket = 'previews' and d.preview_path = p_path)
  ) or exists (
    select 1 from public.stations s where p_bucket = 'covers' and s.cover_path = p_path
  ) or exists (
    select 1 from public.station_tracks t where p_bucket = 'station-audio' and t.audio_path = p_path
  );
$$;

create function public.can_hear_station_file(p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.station_tracks t
    join public.stations s on s.id = t.station_id
    where t.audio_path = p_path and s.hidden_at is null and public.has_station_pass(s.id)
  );
$$;
revoke all on function public.can_hear_station_file(text) from public, anon, authenticated;
grant execute on function public.can_hear_station_file(text) to authenticated;

create function public.is_station_cover(p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.stations s where s.cover_path = p_path and s.hidden_at is null);
$$;
revoke all on function public.is_station_cover(text) from public, anon, authenticated;
grant execute on function public.is_station_cover(text) to anon, authenticated;

create policy "artists upload station audio to their own folder" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'station-audio' and split_part(name, '/', 1) = auth.uid()::text
  );

create policy "station audio plays for owners and tuned-in listeners" on storage.objects
  for select to authenticated using (
    bucket_id = 'station-audio'
    and (split_part(name, '/', 1) = auth.uid()::text or public.can_hear_station_file(name) or public.is_admin())
  );

create policy "station covers are public" on storage.objects
  for select to anon, authenticated using (bucket_id = 'covers' and public.is_station_cover(name));

create policy "artists remove their own unused station audio" on storage.objects
  for delete to authenticated using (
    bucket_id = 'station-audio'
    and split_part(name, '/', 1) = auth.uid()::text
    and not public.file_in_use(bucket_id, name)
  );
