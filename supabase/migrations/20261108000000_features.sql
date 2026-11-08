-- Geotones features: cover art and previews, limited editions, hidden pins,
-- private drops, trails with bonus tracks, follows, reports and moderation,
-- account deletion, and cleanup of unused files.
-- Builds on 20261101000000_init.sql. Same rule as there: revoke Supabase's
-- default grants on every new object, then grant only what clients need.

-- Trails --------------------------------------------------------------------

create table public.trails (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid default auth.uid() references public.profiles (id) on delete set null,
  title text not null check (char_length(title) between 1 and 200),
  description text check (char_length(description) <= 2000),
  created_at timestamptz not null default now()
);

alter table public.trails enable row level security;
revoke all on public.trails from anon, authenticated;
grant select (id, artist_id, title, description) on public.trails to anon, authenticated;
grant insert (title, description) on public.trails to authenticated;
grant update (title, description) on public.trails to authenticated;

create policy "trails are public" on public.trails
  for select to anon, authenticated using (true);
create policy "artists create their own trails" on public.trails
  for insert to authenticated with check (artist_id = auth.uid());
create policy "artists edit their own trails" on public.trails
  for update to authenticated using (artist_id = auth.uid()) with check (artist_id = auth.uid());

-- Drops: new columns ---------------------------------------------------------

-- An artist's drops outlive their account (listeners keep their songs), so the
-- link to the artist becomes empty instead of blocking account deletion.
-- The constraint keeps its name because the web app refers to it.
alter table public.drops drop constraint drops_artist_id_fkey;
alter table public.drops alter column artist_id drop not null;
alter table public.drops add constraint drops_artist_id_fkey
  foreign key (artist_id) references public.profiles (id) on delete set null;

alter table public.drops
  add column place_name text check (char_length(place_name) <= 100),
  add column notes text check (char_length(notes) <= 2000),
  -- Lyrics and the message are for people who claimed the song.
  add column lyrics text check (char_length(lyrics) <= 20000),
  add column message text check (char_length(message) <= 2000),
  add column cover_path text unique,
  add column preview_path text unique,
  add column max_claims integer check (max_claims between 1 and 1000000),
  -- Hidden pins show a rough area until the listener gets close.
  add column hide_pin boolean not null default false,
  add column hint text check (char_length(hint) <= 500),
  add column area_lat double precision,
  add column area_lng double precision,
  add column area_m integer,
  -- Private drops only appear for people who enter the code.
  add column access_code text check (access_code ~ '^[A-Z0-9]{4,20}$'),
  add column trail_id uuid references public.trails (id) on delete restrict,
  -- A bonus track has no location. It unlocks when the whole trail is found.
  add column is_bonus boolean not null default false;

alter table public.drops alter column lat drop not null;
alter table public.drops alter column lng drop not null;
alter table public.drops add constraint drops_location_check check (
  (is_bonus and lat is null and lng is null and trail_id is not null)
  or (not is_bonus and lat is not null and lng is not null)
);

create index drops_trail_id_idx on public.drops (trail_id);

-- Picks the rough area shown for a hidden pin. The claim zone always fits inside it.
create function public.set_drop_area() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_offset double precision;
  v_bearing double precision;
begin
  if new.lat is null or not new.hide_pin then
    new.area_lat := null;
    new.area_lng := null;
    new.area_m := null;
    return new;
  end if;
  if tg_op = 'UPDATE' and old.hide_pin and old.area_lat is not null
    and new.lat = old.lat and new.lng = old.lng and new.radius_m = old.radius_m then
    new.area_lat := old.area_lat;
    new.area_lng := old.area_lng;
    new.area_m := old.area_m;
    return new;
  end if;
  new.area_m := greatest(400, new.radius_m * 3);
  v_offset := 0.8 * (new.area_m - new.radius_m) * sqrt(random());
  v_bearing := random() * 2 * pi();
  new.area_lat := least(90, greatest(-90, new.lat + v_offset * cos(v_bearing) / 111195.0));
  new.area_lng := new.lng + v_offset * sin(v_bearing) / (111195.0 * greatest(cos(radians(new.lat)), 0.01));
  if new.area_lng > 180 then new.area_lng := new.area_lng - 360; end if;
  if new.area_lng < -180 then new.area_lng := new.area_lng + 360; end if;
  return new;
end;
$$;
revoke all on function public.set_drop_area() from public, anon, authenticated;

create trigger drops_set_area
  before insert or update on public.drops
  for each row execute function public.set_drop_area();

-- Exact locations, codes, lyrics and the message are never readable from the
-- table. Clients get them through map_drops(), reveal_nearby(), my_library()
-- and my_drops(), which decide who may see what.
revoke select on public.drops from anon, authenticated;
grant select (id, artist_id, title, radius_m, opens_at, closes_at) on public.drops to anon, authenticated;
revoke insert, update on public.drops from authenticated;
grant insert (title, lat, lng, radius_m, audio_path, opens_at, closes_at, rights_confirmed,
  place_name, notes, lyrics, message, cover_path, preview_path, max_claims, hide_pin, hint,
  access_code, trail_id, is_bonus)
  on public.drops to authenticated;
grant update (title, lat, lng, radius_m, opens_at, closes_at,
  place_name, notes, lyrics, message, cover_path, preview_path, max_claims, hide_pin, hint,
  access_code, trail_id)
  on public.drops to authenticated;

-- Artists may only use files from their own folder and their own trails.
create function public.owns_media_and_trail(
  p_cover text, p_preview text, p_trail uuid
) returns boolean
language sql stable security definer set search_path = '' as $$
  select (p_cover is null or split_part(p_cover, '/', 1) = auth.uid()::text)
    and (p_preview is null or split_part(p_preview, '/', 1) = auth.uid()::text)
    and (p_trail is null or exists (
      select 1 from public.trails t where t.id = p_trail and t.artist_id = auth.uid()
    ));
$$;
revoke all on function public.owns_media_and_trail(text, text, uuid) from public, anon, authenticated;
grant execute on function public.owns_media_and_trail(text, text, uuid) to authenticated;

drop policy "artists create drops with their own audio" on public.drops;
create policy "artists create drops with their own audio" on public.drops
  for insert to authenticated with check (
    artist_id = auth.uid()
    and split_part(audio_path, '/', 1) = auth.uid()::text
    and public.owns_media_and_trail(cover_path, preview_path, trail_id)
  );

drop policy "artists edit their own drops" on public.drops;
create policy "artists edit their own drops" on public.drops
  for update to authenticated
  using (artist_id = auth.uid())
  with check (artist_id = auth.uid() and public.owns_media_and_trail(cover_path, preview_path, trail_id));

drop policy "live drops are public, claimed drops stay visible" on public.drops;
create policy "live drops are public, claimed drops stay visible" on public.drops
  for select to anon, authenticated using (
    artist_id = auth.uid()
    or (
      hidden_at is null
      and (
        (opens_at <= now() and (closes_at is null or closes_at > now())
          and access_code is null and not is_bonus)
        or public.has_claim(id)
      )
    )
  );

-- Claims: edition numbers --------------------------------------------------

alter table public.claims add column edition integer;
update public.claims c set edition = n.rn
from (
  select user_id, drop_id, row_number() over (partition by drop_id order by claimed_at, user_id) as rn
  from public.claims
) n
where n.user_id = c.user_id and n.drop_id = c.drop_id;
alter table public.claims alter column edition set not null;
alter table public.claims add constraint claims_drop_edition_key unique (drop_id, edition);

-- Gives the next numbered copy, or reports that the edition is sold out.
-- The caller must hold a lock on the drop row so numbers stay in order.
create function public.add_claim(p_drop public.drops) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  select count(*) into v_count from public.claims c where c.drop_id = p_drop.id;
  if p_drop.max_claims is not null and v_count >= p_drop.max_claims then
    return jsonb_build_object('status', 'sold_out');
  end if;
  insert into public.claims (user_id, drop_id, edition)
  values (auth.uid(), p_drop.id, v_count + 1);
  return jsonb_build_object('status', 'claimed', 'edition', v_count + 1, 'max_claims', p_drop.max_claims);
end;
$$;
revoke all on function public.add_claim(public.drops) from public, anon, authenticated;

-- Live means open now and not taken down.
create function public.is_live(p_drop public.drops) returns boolean
language sql stable set search_path = '' as $$
  select p_drop.hidden_at is null
    and p_drop.opens_at <= now()
    and (p_drop.closes_at is null or p_drop.closes_at > now());
$$;
revoke all on function public.is_live(public.drops) from public, anon, authenticated;

-- Claiming (replaces the first version) -----------------------------------

drop function public.claim_drop(uuid, double precision, double precision, double precision, boolean);

-- Returns {"status": ...}, one of: claimed (with edition and max_claims),
-- already_claimed, not_available, invalid_location, simulated_location,
-- low_accuracy, too_far (with distance_m), sold_out.
-- p_codes are the private-drop codes the listener has entered.
-- A private drop with a missing or wrong code is reported as not_available,
-- so the answer does not reveal that it exists.
create function public.claim_drop(
  p_drop_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_accuracy_m double precision,
  p_simulated boolean default false,
  p_codes text[] default '{}'
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_drop public.drops;
  v_distance double precision;
  v_max_accuracy_m constant double precision := 100;
begin
  select * into v_drop from public.drops d
  where d.id = p_drop_id and d.hidden_at is null and not d.is_bonus
  for update;
  if not found then
    return jsonb_build_object('status', 'not_available');
  end if;

  if public.has_claim(p_drop_id) then
    return jsonb_build_object('status', 'already_claimed');
  end if;

  if not public.is_live(v_drop) then
    return jsonb_build_object('status', 'not_available');
  end if;

  if v_drop.access_code is not null
    and v_drop.artist_id is distinct from auth.uid()
    and not v_drop.access_code = any (array(select upper(btrim(x)) from unnest(coalesce(p_codes, '{}')) x)) then
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

  return public.add_claim(v_drop);
end;
$$;
revoke all on function public.claim_drop(uuid, double precision, double precision, double precision, boolean, text[])
  from public, anon, authenticated;
grant execute on function public.claim_drop(uuid, double precision, double precision, double precision, boolean, text[])
  to authenticated;

-- Returns {"status": ...}: claimed, already_claimed, not_available, sold_out,
-- or locked (with remaining, the number of trail drops still to find).
-- Every trail drop that has opened must be claimed, so missing one that has
-- since closed means the bonus stays locked.
create function public.claim_trail_bonus(p_trail_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_bonus public.drops;
  v_remaining integer;
begin
  select * into v_bonus from public.drops d
  where d.trail_id = p_trail_id and d.is_bonus and public.is_live(d)
  order by d.created_at
  limit 1
  for update;
  if not found then
    return jsonb_build_object('status', 'not_available');
  end if;

  if public.has_claim(v_bonus.id) then
    return jsonb_build_object('status', 'already_claimed');
  end if;

  select count(*) filter (where not public.has_claim(d.id)) into v_remaining
  from public.drops d
  where d.trail_id = p_trail_id and not d.is_bonus and d.hidden_at is null and d.opens_at <= now();

  if v_remaining > 0 then
    return jsonb_build_object('status', 'locked', 'remaining', v_remaining);
  end if;

  return public.add_claim(v_bonus);
end;
$$;
revoke all on function public.claim_trail_bonus(uuid) from public, anon, authenticated;
grant execute on function public.claim_trail_bonus(uuid) to authenticated;

-- The map -------------------------------------------------------------------

-- Everything the map shows. Hidden pins give the rough area instead of the
-- exact spot, unless the viewer is the artist or has claimed the song.
-- Private drops appear only for matching codes.
create function public.map_drops(p_codes text[] default '{}')
returns table (
  id uuid, title text, artist_id uuid, artist_name text,
  lat double precision, lng double precision, radius_m integer,
  exact boolean, area_m integer, hint text,
  place_name text, notes text, cover_path text, preview_path text,
  opens_at timestamptz, closes_at timestamptz,
  max_claims integer, claims_count integer, claimed boolean,
  trail_id uuid, trail_title text, is_private boolean
)
language sql stable security definer set search_path = '' as $$
  select d.id, d.title, d.artist_id, coalesce(p.display_name, 'Former artist'),
    case when v.exact then d.lat else d.area_lat end,
    case when v.exact then d.lng else d.area_lng end,
    d.radius_m, v.exact, case when v.exact then null else d.area_m end, d.hint,
    d.place_name, d.notes, d.cover_path, d.preview_path,
    d.opens_at, d.closes_at,
    d.max_claims, (select count(*)::integer from public.claims c where c.drop_id = d.id), v.claimed,
    d.trail_id, t.title, d.access_code is not null
  from public.drops d
  left join public.profiles p on p.id = d.artist_id
  left join public.trails t on t.id = d.trail_id
  cross join lateral (
    select public.has_claim(d.id) as claimed,
      (not d.hide_pin or coalesce(d.artist_id = auth.uid(), false) or public.has_claim(d.id)) as exact
  ) v
  where not d.is_bonus
    and d.hidden_at is null
    and (
      v.claimed
      or (public.is_live(d) and (
        d.access_code is null
        or coalesce(d.artist_id = auth.uid(), false)
        or d.access_code = any (array(select upper(btrim(x)) from unnest(p_codes) x))
      ))
    );
$$;
revoke all on function public.map_drops(text[]) from public, anon, authenticated;
grant execute on function public.map_drops(text[]) to anon, authenticated;

-- Exact spots of hidden pins near the listener, so the pin appears as they
-- close in. Same location checks as claiming.
create function public.reveal_nearby(
  p_lat double precision, p_lng double precision, p_accuracy_m double precision,
  p_simulated boolean default false, p_codes text[] default '{}'
)
returns table (id uuid, lat double precision, lng double precision)
language sql stable security definer set search_path = '' as $$
  select d.id, d.lat, d.lng
  from public.drops d
  where d.hide_pin and not d.is_bonus and public.is_live(d)
    and not coalesce(p_simulated, false)
    and p_accuracy_m between 0 and 100
    and p_lat between -90 and 90 and p_lng between -180 and 180
    and (d.access_code is null
      or d.access_code = any (array(select upper(btrim(x)) from unnest(p_codes) x)))
    and public.distance_m(p_lat, p_lng, d.lat, d.lng) <= greatest(150, d.radius_m * 2);
$$;
revoke all on function public.reveal_nearby(double precision, double precision, double precision, boolean, text[])
  from public, anon, authenticated;
grant execute on function public.reveal_nearby(double precision, double precision, double precision, boolean, text[])
  to anon, authenticated;

-- Library and artist dashboard (replace the first versions) -----------------

drop function public.my_library();
create function public.my_library()
returns table (
  drop_id uuid, title text, artist_id uuid, artist_name text, audio_path text, cover_path text,
  claimed_at timestamptz, edition integer, max_claims integer,
  place_name text, notes text, lyrics text, message text,
  lat double precision, lng double precision,
  trail_id uuid, trail_title text, is_bonus boolean
)
language sql stable security definer set search_path = '' as $$
  select d.id, d.title, d.artist_id, coalesce(p.display_name, 'Former artist'), d.audio_path, d.cover_path,
    c.claimed_at, c.edition, d.max_claims,
    d.place_name, d.notes, d.lyrics, d.message,
    d.lat, d.lng, d.trail_id, t.title, d.is_bonus
  from public.claims c
  join public.drops d on d.id = c.drop_id
  left join public.profiles p on p.id = d.artist_id
  left join public.trails t on t.id = d.trail_id
  where c.user_id = auth.uid() and d.hidden_at is null
  order by c.claimed_at desc;
$$;
revoke all on function public.my_library() from public, anon, authenticated;
grant execute on function public.my_library() to authenticated;

drop function public.my_drops();
create function public.my_drops()
returns table (
  id uuid, title text, lat double precision, lng double precision, radius_m integer,
  audio_path text, cover_path text, preview_path text,
  opens_at timestamptz, closes_at timestamptz, hidden_at timestamptz,
  place_name text, notes text, lyrics text, message text,
  max_claims integer, hide_pin boolean, hint text, access_code text,
  trail_id uuid, trail_title text, is_bonus boolean,
  claims_count integer, claims_7d integer, last_claimed_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  select d.id, d.title, d.lat, d.lng, d.radius_m, d.audio_path, d.cover_path, d.preview_path,
    d.opens_at, d.closes_at, d.hidden_at,
    d.place_name, d.notes, d.lyrics, d.message,
    d.max_claims, d.hide_pin, d.hint, d.access_code,
    d.trail_id, t.title, d.is_bonus,
    s.total, s.week, s.last
  from public.drops d
  left join public.trails t on t.id = d.trail_id
  cross join lateral (
    select count(*)::integer as total,
      (count(*) filter (where c.claimed_at > now() - interval '7 days'))::integer as week,
      max(c.claimed_at) as last
    from public.claims c where c.drop_id = d.id
  ) s
  where d.artist_id = auth.uid()
  order by d.created_at desc;
$$;
revoke all on function public.my_drops() from public, anon, authenticated;
grant execute on function public.my_drops() to authenticated;

-- Trails overview: every trail with something on the map for this viewer,
-- with their progress. found and total count opened, non-bonus drops.
create function public.trails_overview()
returns table (
  id uuid, title text, description text, artist_name text,
  total integer, found integer, has_bonus boolean, bonus_claimed boolean
)
language sql stable security definer set search_path = '' as $$
  select t.id, t.title, t.description, coalesce(p.display_name, 'Former artist'),
    s.total, s.found, s.has_bonus, s.bonus_claimed
  from public.trails t
  left join public.profiles p on p.id = t.artist_id
  cross join lateral (
    select
      (count(*) filter (where not d.is_bonus and d.opens_at <= now()))::integer as total,
      (count(*) filter (where not d.is_bonus and d.opens_at <= now() and public.has_claim(d.id)))::integer as found,
      bool_or(d.is_bonus and public.is_live(d)) as has_bonus,
      bool_or(d.is_bonus and public.has_claim(d.id)) as bonus_claimed,
      bool_or(not d.is_bonus and (public.has_claim(d.id)
        or (public.is_live(d) and d.access_code is null))) as on_map
    from public.drops d
    where d.trail_id = t.id and d.hidden_at is null
  ) s
  where s.on_map or t.artist_id = auth.uid()
  order by t.created_at desc;
$$;
revoke all on function public.trails_overview() from public, anon, authenticated;
grant execute on function public.trails_overview() to anon, authenticated;

-- Follows -------------------------------------------------------------------

create table public.follows (
  follower_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  artist_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, artist_id),
  check (follower_id <> artist_id)
);

alter table public.follows enable row level security;
revoke all on public.follows from anon, authenticated;
grant select on public.follows to authenticated;
grant insert (artist_id) on public.follows to authenticated;
grant delete on public.follows to authenticated;

create policy "users see who they follow" on public.follows
  for select to authenticated using (follower_id = auth.uid());
create policy "users follow as themselves" on public.follows
  for insert to authenticated with check (follower_id = auth.uid());
create policy "users unfollow as themselves" on public.follows
  for delete to authenticated using (follower_id = auth.uid());

-- Public facts about an artist, for the follow button.
create function public.artist_info(p_artist uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'display_name', p.display_name,
    'followers', (select count(*) from public.follows f where f.artist_id = p.id),
    'following', exists (select 1 from public.follows f where f.artist_id = p.id and f.follower_id = auth.uid()),
    'live_drops', (select count(*) from public.drops d
      where d.artist_id = p.id and public.is_live(d) and d.access_code is null and not d.is_bonus)
  )
  from public.profiles p where p.id = p_artist;
$$;
revoke all on function public.artist_info(uuid) from public, anon, authenticated;
grant execute on function public.artist_info(uuid) to anon, authenticated;

-- Recent public drops from artists the user follows.
create function public.following_feed()
returns table (
  id uuid, title text, artist_id uuid, artist_name text, place_name text, cover_path text,
  created_at timestamptz, claimed boolean
)
language sql stable security definer set search_path = '' as $$
  select d.id, d.title, d.artist_id, p.display_name, d.place_name, d.cover_path, d.created_at,
    public.has_claim(d.id)
  from public.follows f
  join public.drops d on d.artist_id = f.artist_id
  join public.profiles p on p.id = d.artist_id
  where f.follower_id = auth.uid()
    and public.is_live(d) and d.access_code is null and not d.is_bonus
  order by d.created_at desc
  limit 50;
$$;
revoke all on function public.following_feed() from public, anon, authenticated;
grant execute on function public.following_feed() to authenticated;

create function public.my_follows()
returns table (artist_id uuid, display_name text)
language sql stable security definer set search_path = '' as $$
  select f.artist_id, p.display_name
  from public.follows f join public.profiles p on p.id = f.artist_id
  where f.follower_id = auth.uid()
  order by p.display_name;
$$;
revoke all on function public.my_follows() from public, anon, authenticated;
grant execute on function public.my_follows() to authenticated;

-- Reports and moderation -----------------------------------------------------

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  drop_id uuid not null references public.drops (id) on delete cascade,
  reporter_id uuid default auth.uid() references public.profiles (id) on delete set null,
  reason text not null check (char_length(reason) between 1 and 1000),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (drop_id, reporter_id)
);

alter table public.reports enable row level security;
revoke all on public.reports from anon, authenticated;
grant insert (drop_id, reason) on public.reports to authenticated;

create policy "users report as themselves" on public.reports
  for insert to authenticated with check (reporter_id = auth.uid());

-- Moderators. Add one in the SQL editor:
--   insert into public.admins (user_id) select id from auth.users where email = '...';
create table public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);
alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;

create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;
revoke all on function public.is_admin() from public, anon, authenticated;
grant execute on function public.is_admin() to authenticated;

create function public.admin_reports()
returns table (
  report_id uuid, reason text, reported_at timestamptz, resolved_at timestamptz,
  drop_id uuid, title text, artist_name text, audio_path text, cover_path text,
  hidden_at timestamptz, report_count integer
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'admins only' using errcode = '42501';
  end if;
  return query
    select r.id, r.reason, r.created_at, r.resolved_at,
      d.id, d.title, coalesce(p.display_name, 'Former artist'), d.audio_path, d.cover_path, d.hidden_at,
      (select count(*)::integer from public.reports r2 where r2.drop_id = d.id)
    from public.reports r
    join public.drops d on d.id = r.drop_id
    left join public.profiles p on p.id = d.artist_id
    order by r.resolved_at is not null, r.created_at desc
    limit 200;
end;
$$;
revoke all on function public.admin_reports() from public, anon, authenticated;
grant execute on function public.admin_reports() to authenticated;

create function public.admin_set_hidden(p_drop_id uuid, p_hidden boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'admins only' using errcode = '42501';
  end if;
  update public.drops set hidden_at = case when p_hidden then now() end where id = p_drop_id;
end;
$$;
revoke all on function public.admin_set_hidden(uuid, boolean) from public, anon, authenticated;
grant execute on function public.admin_set_hidden(uuid, boolean) to authenticated;

create function public.admin_resolve_report(p_report_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'admins only' using errcode = '42501';
  end if;
  update public.reports set resolved_at = now() where id = p_report_id;
end;
$$;
revoke all on function public.admin_resolve_report(uuid) from public, anon, authenticated;
grant execute on function public.admin_resolve_report(uuid) to authenticated;

-- Account deletion -----------------------------------------------------------

-- Step one of deleting an account: drops nobody has claimed are removed, and
-- drops people have claimed close but stay in those listeners' libraries.
-- The app then removes the now-unused files, then calls delete_my_account().
create function public.retire_my_drops() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  delete from public.drops d
  where d.artist_id = auth.uid()
    and not exists (select 1 from public.claims c where c.drop_id = d.id);
  update public.drops d set closes_at = greatest(now(), d.opens_at + interval '1 second')
  where d.artist_id = auth.uid() and (d.closes_at is null or d.closes_at > now());
end;
$$;
revoke all on function public.retire_my_drops() from public, anon, authenticated;
grant execute on function public.retire_my_drops() to authenticated;

create function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  perform public.retire_my_drops();
  delete from auth.users where id = v_uid;
end;
$$;
revoke all on function public.delete_my_account() from public, anon, authenticated;
grant execute on function public.delete_my_account() to authenticated;

-- Storage: covers, previews, cleanup ------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('covers', 'covers', false, 5242880, array['image/jpeg', 'image/png', 'image/webp']),
  ('previews', 'previews', false, 10485760, array['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp4']);

-- Covers and previews follow the drop: anyone who can see it on the map.
create function public.can_view_media(p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.drops d
    where (d.cover_path = p_path or d.preview_path = p_path)
      and d.hidden_at is null
      and (public.is_live(d) or public.has_claim(d.id))
  );
$$;
revoke all on function public.can_view_media(text) from public, anon, authenticated;
grant execute on function public.can_view_media(text) to anon, authenticated;

create function public.file_in_use(p_bucket text, p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.drops d
    where (p_bucket = 'audio' and d.audio_path = p_path)
      or (p_bucket = 'covers' and d.cover_path = p_path)
      or (p_bucket = 'previews' and d.preview_path = p_path)
  );
$$;
revoke all on function public.file_in_use(text, text) from public, anon, authenticated;
grant execute on function public.file_in_use(text, text) to authenticated;

create policy "artists upload covers and previews to their own folder" on storage.objects
  for insert to authenticated with check (
    bucket_id in ('covers', 'previews') and split_part(name, '/', 1) = auth.uid()::text
  );

create policy "covers and previews follow their drop" on storage.objects
  for select to anon, authenticated using (
    bucket_id in ('covers', 'previews')
    and (split_part(name, '/', 1) = auth.uid()::text or public.can_view_media(name))
  );

create policy "moderators can review any file" on storage.objects
  for select to authenticated using (
    bucket_id in ('audio', 'covers', 'previews') and public.is_admin()
  );

-- Lets the app tidy up after a failed upload, a replaced cover, or a deleted
-- account. Files a drop still points at can never be removed this way.
create policy "artists remove their own unused files" on storage.objects
  for delete to authenticated using (
    bucket_id in ('audio', 'covers', 'previews')
    and split_part(name, '/', 1) = auth.uid()::text
    and not public.file_in_use(bucket_id, name)
  );
