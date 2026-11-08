-- Geotones backend: artists drop songs on a map, listeners claim them on site.
-- Client access goes through row-level security (RLS) and the functions below.
-- Supabase grants everything on public tables and functions by default, so each
-- object here revokes that first and then grants only what clients need.

-- Profiles ------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default 'Anonymous'
    check (char_length(display_name) between 1 and 100),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;
grant select (id, display_name) on public.profiles to anon, authenticated;
grant update (display_name) on public.profiles to authenticated;

create policy "profiles are public" on public.profiles
  for select to anon, authenticated using (true);

create policy "users edit their own profile" on public.profiles
  for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(nullif(left(new.raw_user_meta_data ->> 'display_name', 100), ''), 'Anonymous')
  );
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Drops ---------------------------------------------------------------------

create table public.drops (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null default auth.uid() references public.profiles (id) on delete restrict,
  title text not null check (char_length(title) between 1 and 200),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  radius_m integer not null default 50 check (radius_m between 25 and 5000),
  audio_path text not null unique,
  opens_at timestamptz not null default now(),
  closes_at timestamptz,
  -- The artist confirms they own the rights to the track when uploading.
  rights_confirmed boolean not null check (rights_confirmed),
  -- Set by moderation. Hides the drop and stops playback, even for past claims.
  hidden_at timestamptz,
  created_at timestamptz not null default now(),
  check (closes_at is null or closes_at > opens_at)
);

create index drops_lat_lng_idx on public.drops (lat, lng);
create index drops_artist_id_idx on public.drops (artist_id);

alter table public.drops enable row level security;

-- audio_path and hidden_at are left out on purpose. Clients must list columns
-- rather than select *, and get audio paths from my_library() or my_drops().
revoke all on public.drops from anon, authenticated;
grant select (id, artist_id, title, lat, lng, radius_m, opens_at, closes_at)
  on public.drops to anon, authenticated;
grant insert (title, lat, lng, radius_m, audio_path, opens_at, closes_at, rights_confirmed)
  on public.drops to authenticated;
grant update (title, lat, lng, radius_m, opens_at, closes_at)
  on public.drops to authenticated;

-- Claims --------------------------------------------------------------------

-- The listener's position is checked in claim_drop() and never stored.
create table public.claims (
  user_id uuid not null references public.profiles (id) on delete cascade,
  drop_id uuid not null references public.drops (id) on delete cascade,
  claimed_at timestamptz not null default now(),
  primary key (user_id, drop_id)
);

create index claims_drop_id_idx on public.claims (drop_id);

alter table public.claims enable row level security;
revoke all on public.claims from anon, authenticated;
grant select on public.claims to authenticated;

create policy "users see their own claims" on public.claims
  for select to authenticated using (user_id = auth.uid());

-- Runs as owner so the drops policy can check claims for signed-out visitors,
-- who have no access to the claims table.
create function public.has_claim(p_drop_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.claims c
    where c.drop_id = p_drop_id and c.user_id = auth.uid()
  );
$$;
revoke all on function public.has_claim(uuid) from public, anon, authenticated;
grant execute on function public.has_claim(uuid) to anon, authenticated;

create policy "live drops are public, claimed drops stay visible" on public.drops
  for select to anon, authenticated using (
    artist_id = auth.uid()
    or (
      hidden_at is null
      and (
        (opens_at <= now() and (closes_at is null or closes_at > now()))
        or public.has_claim(id)
      )
    )
  );

create policy "artists create drops with their own audio" on public.drops
  for insert to authenticated with check (
    artist_id = auth.uid()
    and split_part(audio_path, '/', 1) = auth.uid()::text
  );

create policy "artists edit their own drops" on public.drops
  for update to authenticated
  using (artist_id = auth.uid()) with check (artist_id = auth.uid());

-- Distance ------------------------------------------------------------------

-- Great-circle distance in metres (haversine formula).
create function public.distance_m(
  lat1 double precision, lng1 double precision,
  lat2 double precision, lng2 double precision
) returns double precision
language sql immutable set search_path = '' as $$
  select 2 * 6371008.8 * asin(least(1, sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
  )));
$$;
revoke all on function public.distance_m(double precision, double precision, double precision, double precision)
  from public, anon, authenticated;

-- Claiming ------------------------------------------------------------------

-- Returns {"status": ...}, one of: claimed, already_claimed, not_available,
-- invalid_location, simulated_location, low_accuracy, too_far.
-- too_far also includes distance_m. Coordinates come from the client, so this
-- stops casual cheating but not a determined spoofer.
create function public.claim_drop(
  p_drop_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_accuracy_m double precision,
  p_simulated boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_drop public.drops;
  v_distance double precision;
  v_max_accuracy_m constant double precision := 100;
begin
  select * into v_drop from public.drops d
  where d.id = p_drop_id and d.hidden_at is null;
  if not found then
    return jsonb_build_object('status', 'not_available');
  end if;

  if exists (
    select 1 from public.claims c
    where c.drop_id = p_drop_id and c.user_id = auth.uid()
  ) then
    return jsonb_build_object('status', 'already_claimed');
  end if;

  if v_drop.opens_at > now() or (v_drop.closes_at is not null and v_drop.closes_at <= now()) then
    return jsonb_build_object('status', 'not_available');
  end if;

  -- 'NaN' sorts above every number in Postgres, so these ranges reject it too.
  if p_lat is null or p_lng is null or p_accuracy_m is null
    or not (p_lat between -90 and 90)
    or not (p_lng between -180 and 180)
    or p_accuracy_m < 0 or p_accuracy_m = 'NaN'::double precision then
    return jsonb_build_object('status', 'invalid_location');
  end if;

  if coalesce(p_simulated, false) then
    return jsonb_build_object('status', 'simulated_location');
  end if;

  if p_accuracy_m > v_max_accuracy_m then
    return jsonb_build_object('status', 'low_accuracy');
  end if;

  v_distance := public.distance_m(p_lat, p_lng, v_drop.lat, v_drop.lng);
  if v_distance > v_drop.radius_m then
    return jsonb_build_object('status', 'too_far', 'distance_m', round(v_distance));
  end if;

  insert into public.claims (user_id, drop_id)
  values (auth.uid(), p_drop_id)
  on conflict do nothing;

  return jsonb_build_object('status', 'claimed');
end;
$$;
revoke all on function public.claim_drop(uuid, double precision, double precision, double precision, boolean)
  from public, anon, authenticated;
grant execute on function public.claim_drop(uuid, double precision, double precision, double precision, boolean)
  to authenticated;

-- Library -------------------------------------------------------------------

create function public.my_library()
returns table (
  drop_id uuid, title text, artist_name text, audio_path text, claimed_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  select d.id, d.title, p.display_name, d.audio_path, c.claimed_at
  from public.claims c
  join public.drops d on d.id = c.drop_id
  join public.profiles p on p.id = d.artist_id
  where c.user_id = auth.uid() and d.hidden_at is null
  order by c.claimed_at desc;
$$;
revoke all on function public.my_library() from public, anon, authenticated;
grant execute on function public.my_library() to authenticated;

create function public.my_drops()
returns table (
  id uuid, title text, lat double precision, lng double precision, radius_m integer,
  audio_path text, opens_at timestamptz, closes_at timestamptz, hidden_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  select d.id, d.title, d.lat, d.lng, d.radius_m, d.audio_path, d.opens_at, d.closes_at, d.hidden_at
  from public.drops d
  where d.artist_id = auth.uid()
  order by d.created_at desc;
$$;
revoke all on function public.my_drops() from public, anon, authenticated;
grant execute on function public.my_drops() to authenticated;

-- Audio storage -------------------------------------------------------------

-- Private bucket. Files live at <artist user id>/<file>. Clients get a
-- short-lived play link with createSignedUrl, which obeys the policies below.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'audio', 'audio', false, 52428800,
  array['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/ogg']
);

create function public.can_play(p_audio_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.drops d
    join public.claims c on c.drop_id = d.id
    where d.audio_path = p_audio_path
      and d.hidden_at is null
      and c.user_id = auth.uid()
  );
$$;
revoke all on function public.can_play(text) from public, anon, authenticated;
grant execute on function public.can_play(text) to authenticated;

create policy "artists upload to their own folder" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'audio' and split_part(name, '/', 1) = auth.uid()::text
  );

create policy "artists and claimers can read audio" on storage.objects
  for select to authenticated using (
    bucket_id = 'audio'
    and (split_part(name, '/', 1) = auth.uid()::text or public.can_play(name))
  );
