-- Backend tests. Prints "ok" or "not ok" per check; run.sh counts them.
\set ON_ERROR_STOP on
set client_min_messages = notice;

create schema t;
grant usage on schema t to public;

create function t.login(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'none', false);
  perform set_config('request.jwt.claim.sub', p_uid::text, false);
  perform set_config('role', 'authenticated', false);
end;
$$;

create function t.logout() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', false);
  perform set_config('request.jwt.claim.sub', '', false);
end;
$$;

create function t.anon() returns void language plpgsql as $$
begin
  perform t.logout();
  perform set_config('role', 'anon', false);
end;
$$;

create function t.eq(p_name text, p_got text, p_want text) returns void language plpgsql as $$
begin
  if p_got is not distinct from p_want then
    raise notice 'ok - %', p_name;
  else
    raise notice 'not ok - % (got %, want %)', p_name, p_got, p_want;
  end if;
end;
$$;

-- Passes only if the statement is refused by permissions or RLS.
create function t.denied(p_name text, p_sql text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise notice 'not ok - % (was allowed)', p_name;
exception when insufficient_privilege then
  raise notice 'ok - %', p_name;
end;
$$;

-- Passes only if the statement is refused by a table check.
create function t.rejected(p_name text, p_sql text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise notice 'not ok - % (was allowed)', p_name;
exception when check_violation then
  raise notice 'ok - %', p_name;
end;
$$;

create function t.visible(p_drop uuid) returns text language plpgsql as $$
declare n bigint;
begin
  select count(*) into n from public.drops where id = p_drop;
  return n::text;
end;
$$;

-- Fixtures: artist, listener, second listener, and a drop in central Johannesburg.
insert into auth.users (id, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000a', '{"display_name": "Carlhinos Test"}'),
  ('00000000-0000-0000-0000-00000000000b', '{}'),
  ('00000000-0000-0000-0000-00000000000c', '{}');

insert into storage.objects (bucket_id, name) values
  ('audio', '00000000-0000-0000-0000-00000000000a/song.mp3');

-- Distance maths ------------------------------------------------------------
do $$
declare d double precision;
begin
  d := public.distance_m(51.5074, -0.1278, 48.8566, 2.3522);
  perform t.eq('London to Paris is about 343.5 km', (d between 343000 and 344500)::text, 'true');
  d := public.distance_m(0, 179.9995, 0, -179.9995);
  perform t.eq('distance across the date line is about 111 m', (d between 110 and 112)::text, 'true');
  perform t.eq('distance to the same point is 0', public.distance_m(10, 20, 10, 20)::text, '0');
end;
$$;

-- Profiles ------------------------------------------------------------------
do $$
declare
  a constant uuid := '00000000-0000-0000-0000-00000000000a';
  b constant uuid := '00000000-0000-0000-0000-00000000000b';
  n bigint;
begin
  perform t.eq('sign-up creates a profile with the chosen name',
    (select display_name from public.profiles where id = a), 'Carlhinos Test');
  perform t.eq('sign-up without a name gets Anonymous',
    (select display_name from public.profiles where id = b), 'Anonymous');

  perform t.login(b);
  update public.profiles set display_name = 'Changed by B' where id = a;
  get diagnostics n = row_count;
  perform t.eq('users cannot rename someone else', n::text, '0');
  update public.profiles set display_name = 'Listener B' where id = b;
  get diagnostics n = row_count;
  perform t.eq('users can rename themselves', n::text, '1');
  perform t.logout();
end;
$$;

-- Creating drops ------------------------------------------------------------
do $$
declare
  a constant uuid := '00000000-0000-0000-0000-00000000000a';
  b constant uuid := '00000000-0000-0000-0000-00000000000b';
  ok_cols constant text := '(title, lat, lng, audio_path, rights_confirmed)';
begin
  perform t.anon();
  perform t.denied('signed-out visitors cannot create drops',
    format($q$insert into public.drops %s values ('x', 0, 0, 'x/y.mp3', true)$q$, ok_cols));

  perform t.login(a);
  perform t.denied('artists cannot point a drop at another artist''s audio',
    format($q$insert into public.drops %s values ('x', 0, 0, '%s/stolen.mp3', true)$q$, ok_cols, b));
  perform t.denied('artists cannot create a drop in someone else''s name',
    format($q$insert into public.drops (artist_id, title, lat, lng, audio_path, rights_confirmed)
              values ('%s', 'x', 0, 0, '%s/a.mp3', true)$q$, b, b));
  perform t.denied('artists cannot set the moderation flag when creating',
    format($q$insert into public.drops (title, lat, lng, audio_path, rights_confirmed, hidden_at)
              values ('x', 0, 0, '%s/a.mp3', true, null)$q$, a));
  perform t.rejected('a drop needs the rights confirmation',
    format($q$insert into public.drops %s values ('x', 0, 0, '%s/a.mp3', false)$q$, ok_cols, a));
  perform t.rejected('latitude must be on Earth',
    format($q$insert into public.drops %s values ('x', 91, 0, '%s/a.mp3', true)$q$, ok_cols, a));
  perform t.rejected('radius cannot be smaller than GPS can resolve',
    format($q$insert into public.drops (title, lat, lng, radius_m, audio_path, rights_confirmed)
              values ('x', 0, 0, 5, '%s/a.mp3', true)$q$, a));
  perform t.logout();
end;
$$;

-- A valid drop through the same route clients use.
do $$
declare
  a constant uuid := '00000000-0000-0000-0000-00000000000a';
  new_id uuid;
begin
  perform t.login(a);
  insert into public.drops (title, lat, lng, audio_path, rights_confirmed)
  values ('Client drop', 1, 1, a || '/client.mp3', true)
  returning id into new_id;
  perform t.eq('artists can create a drop, owned by them',
    (select artist_id::text from public.drops where id = new_id), a::text);
  perform t.logout();
end;
$$;

-- Fixture drops with fixed ids. Live spot is central Johannesburg, radius 50 m.
insert into public.drops (id, artist_id, title, lat, lng, radius_m, audio_path, opens_at, closes_at, hidden_at, rights_confirmed)
values
  ('00000000-0000-0000-0000-000000000d01', '00000000-0000-0000-0000-00000000000a', 'Live', -26.2041, 28.0473, 50,
   '00000000-0000-0000-0000-00000000000a/song.mp3', now() - interval '1 day', null, null, true),
  ('00000000-0000-0000-0000-000000000d02', '00000000-0000-0000-0000-00000000000a', 'Closed', -26.2041, 28.0473, 50,
   '00000000-0000-0000-0000-00000000000a/closed.mp3', now() - interval '2 days', now() - interval '1 day', null, true),
  ('00000000-0000-0000-0000-000000000d03', '00000000-0000-0000-0000-00000000000a', 'Future', -26.2041, 28.0473, 50,
   '00000000-0000-0000-0000-00000000000a/future.mp3', now() + interval '1 day', null, null, true),
  ('00000000-0000-0000-0000-000000000d04', '00000000-0000-0000-0000-00000000000a', 'Hidden', -26.2041, 28.0473, 50,
   '00000000-0000-0000-0000-00000000000a/hidden.mp3', now() - interval '1 day', null, now(), true),
  ('00000000-0000-0000-0000-000000000d05', '00000000-0000-0000-0000-00000000000a', 'Closes later', -26.2041, 28.0473, 50,
   '00000000-0000-0000-0000-00000000000a/later.mp3', now() - interval '1 day', null, null, true);

-- What clients can see and read --------------------------------------------
do $$
declare
  a constant uuid := '00000000-0000-0000-0000-00000000000a';
  b constant uuid := '00000000-0000-0000-0000-00000000000b';
  live constant uuid := '00000000-0000-0000-0000-000000000d01';
  closed constant uuid := '00000000-0000-0000-0000-000000000d02';
  future constant uuid := '00000000-0000-0000-0000-000000000d03';
  hidden constant uuid := '00000000-0000-0000-0000-000000000d04';
begin
  perform t.anon();
  perform t.eq('signed-out visitors see live drops', t.visible(live), '1');
  perform t.eq('signed-out visitors do not see closed drops', t.visible(closed), '0');
  perform t.eq('signed-out visitors do not see future drops', t.visible(future), '0');
  perform t.eq('signed-out visitors do not see hidden drops', t.visible(hidden), '0');
  perform t.denied('signed-out visitors cannot read audio paths', 'select audio_path from public.drops');
  perform t.denied('signed-out visitors cannot call claim_drop',
    format($q$select public.claim_drop('%s', 0, 0, 5)$q$, live));
  perform t.denied('signed-out visitors cannot read claims', 'select * from public.claims');

  perform t.login(b);
  perform t.denied('listeners cannot read audio paths directly', 'select audio_path from public.drops');
  perform t.denied('listeners cannot read the moderation flag', 'select hidden_at from public.drops');
  perform t.denied('select * on drops is refused', 'select * from public.drops');
  perform t.denied('listeners cannot add claims directly',
    format($q$insert into public.claims (user_id, drop_id) values ('%s', '%s')$q$, b, live));
  perform t.denied('the distance helper is not exposed', 'select public.distance_m(0, 0, 0, 0)');
  perform t.denied('the sign-up trigger is not exposed', 'select public.handle_new_user()');

  perform t.login(a);
  perform t.eq('artists see their own future drops', t.visible(future), '1');
  perform t.eq('artists see their own hidden drops', t.visible(hidden), '1');
  perform t.eq('my_drops lists an artist''s drops', (select count(*)::text from public.my_drops()), '6');
  perform t.login(b);
  perform t.eq('my_drops is empty for someone else', (select count(*)::text from public.my_drops()), '0');
  perform t.logout();
end;
$$;

-- Editing drops ------------------------------------------------------------
do $$
declare
  a constant uuid := '00000000-0000-0000-0000-00000000000a';
  b constant uuid := '00000000-0000-0000-0000-00000000000b';
  live constant uuid := '00000000-0000-0000-0000-000000000d05';
  n bigint;
begin
  perform t.login(b);
  update public.drops set radius_m = 5000 where id = live;
  get diagnostics n = row_count;
  perform t.eq('listeners cannot edit an artist''s drop', n::text, '0');

  perform t.login(a);
  update public.drops set title = 'Closes later!' where id = live;
  get diagnostics n = row_count;
  perform t.eq('artists can edit their own drop', n::text, '1');
  perform t.denied('artists cannot clear the moderation flag',
    format($q$update public.drops set hidden_at = null where id = '%s'$q$, live));
  perform t.denied('artists cannot swap the audio',
    format($q$update public.drops set audio_path = 'x' where id = '%s'$q$, live));
  perform t.denied('artists cannot give a drop away',
    format($q$update public.drops set artist_id = '%s' where id = '%s'$q$, b, live));
  perform t.denied('artists cannot delete a drop listeners may own',
    format($q$delete from public.drops where id = '%s'$q$, live));
  perform t.logout();
end;
$$;

-- Claiming -----------------------------------------------------------------
do $$
declare
  b constant uuid := '00000000-0000-0000-0000-00000000000b';
  c constant uuid := '00000000-0000-0000-0000-00000000000c';
  live constant uuid := '00000000-0000-0000-0000-000000000d01';
  closed constant uuid := '00000000-0000-0000-0000-000000000d02';
  future constant uuid := '00000000-0000-0000-0000-000000000d03';
  hidden constant uuid := '00000000-0000-0000-0000-000000000d04';
  lat constant double precision := -26.2041;
  lng constant double precision := 28.0473;
  -- One degree of latitude is about 111,195 m.
  lat_60m constant double precision := -26.2041 + 60 / 111195.0;
  lat_40m constant double precision := -26.2041 + 40 / 111195.0;
  r jsonb;
begin
  perform t.login(b);
  r := public.claim_drop(live, lat_60m, lng, 5);
  perform t.eq('60 m from a 50 m zone is too far', r ->> 'status', 'too_far');
  perform t.eq('too_far reports the distance', r ->> 'distance_m', '60');
  perform t.eq('a failed claim adds nothing', (select count(*)::text from public.claims), '0');
  perform t.eq('the song is not in the library yet', (select count(*)::text from public.my_library()), '0');

  r := public.claim_drop(live, -33.9249, 18.4241, 5);
  perform t.eq('Cape Town is too far from Johannesburg', r ->> 'status', 'too_far');

  perform t.eq('a faked location is refused',
    public.claim_drop(live, lat, lng, 5, true) ->> 'status', 'simulated_location');
  perform t.eq('a very rough fix is refused',
    public.claim_drop(live, lat, lng, 150) ->> 'status', 'low_accuracy');
  perform t.eq('NaN latitude is refused',
    public.claim_drop(live, 'NaN', lng, 5) ->> 'status', 'invalid_location');
  perform t.eq('out-of-range longitude is refused',
    public.claim_drop(live, lat, 200, 5) ->> 'status', 'invalid_location');
  perform t.eq('missing accuracy is refused',
    public.claim_drop(live, lat, lng, null) ->> 'status', 'invalid_location');
  perform t.eq('negative accuracy is refused',
    public.claim_drop(live, lat, lng, -1) ->> 'status', 'invalid_location');
  perform t.eq('NaN accuracy is refused',
    public.claim_drop(live, lat, lng, 'NaN') ->> 'status', 'invalid_location');
  perform t.eq('an unknown drop is not available',
    public.claim_drop(gen_random_uuid(), lat, lng, 5) ->> 'status', 'not_available');
  perform t.eq('a closed drop is not available',
    public.claim_drop(closed, lat, lng, 5) ->> 'status', 'not_available');
  perform t.eq('a future drop is not available',
    public.claim_drop(future, lat, lng, 5) ->> 'status', 'not_available');
  perform t.eq('a hidden drop is not available',
    public.claim_drop(hidden, lat, lng, 5) ->> 'status', 'not_available');
  perform t.eq('still nothing claimed', (select count(*)::text from public.claims), '0');

  perform t.eq('40 m from a 50 m zone claims the song',
    public.claim_drop(live, lat_40m, lng, 5) ->> 'status', 'claimed');
  perform t.eq('the claim is saved', (select count(*)::text from public.claims), '1');
  perform t.eq('claiming again is harmless, even from far away',
    public.claim_drop(live, -33.9249, 18.4241, 5) ->> 'status', 'already_claimed');
  perform t.eq('there is still one claim', (select count(*)::text from public.claims), '1');
  perform t.eq('the song is in the library', (select title from public.my_library()), 'Live');
  perform t.eq('the library shows the artist name',
    (select artist_name from public.my_library()), 'Carlhinos Test');
  perform t.eq('the library gives the audio path',
    (select audio_path from public.my_library()), '00000000-0000-0000-0000-00000000000a/song.mp3');

  perform t.login(c);
  perform t.eq('other listeners cannot see that claim', (select count(*)::text from public.claims), '0');
  perform t.eq('other listeners'' libraries stay empty', (select count(*)::text from public.my_library()), '0');
  perform t.logout();
end;
$$;

-- Audio access --------------------------------------------------------------
do $$
declare
  a constant uuid := '00000000-0000-0000-0000-00000000000a';
  b constant uuid := '00000000-0000-0000-0000-00000000000b';
  c constant uuid := '00000000-0000-0000-0000-00000000000c';
  song constant text := '00000000-0000-0000-0000-00000000000a/song.mp3';
begin
  perform t.anon();
  perform t.eq('signed-out visitors cannot reach the audio',
    (select count(*)::text from storage.objects where name = song), '0');
  perform t.login(c);
  perform t.eq('listeners who have not claimed cannot reach the audio',
    (select count(*)::text from storage.objects where name = song), '0');
  perform t.login(b);
  perform t.eq('the listener who claimed can reach the audio',
    (select count(*)::text from storage.objects where name = song), '1');
  perform t.login(a);
  perform t.eq('the artist can reach their own audio',
    (select count(*)::text from storage.objects where name = song), '1');

  insert into storage.objects (bucket_id, name) values ('audio', a || '/upload.mp3');
  perform t.eq('artists can upload to their own folder',
    (select count(*)::text from storage.objects where name = a || '/upload.mp3'), '1');
  perform t.denied('artists cannot upload to someone else''s folder',
    format($q$insert into storage.objects (bucket_id, name) values ('audio', '%s/x.mp3')$q$, b));
  perform t.login(b);
  perform t.denied('claimers cannot overwrite the audio',
    format($q$insert into storage.objects (bucket_id, name) values ('audio', '%s/song2.mp3')$q$, a));
  perform t.logout();
end;
$$;

-- A closed drop stays with those who claimed it ------------------------------
do $$
declare
  b constant uuid := '00000000-0000-0000-0000-00000000000b';
  c constant uuid := '00000000-0000-0000-0000-00000000000c';
  later constant uuid := '00000000-0000-0000-0000-000000000d05';
begin
  perform t.login(b);
  perform t.eq('a claim works before the drop closes',
    public.claim_drop(later, -26.2041, 28.0473, 5) ->> 'status', 'claimed');
  perform t.logout();

  update public.drops set opens_at = now() - interval '2 days', closes_at = now() - interval '1 hour' where id = later;

  perform t.login(b);
  perform t.eq('claimers still see a closed drop', t.visible(later), '1');
  perform t.eq('claimers keep a closed drop in their library',
    (select count(*)::text from public.my_library()), '2');
  perform t.login(c);
  perform t.eq('others no longer see a closed drop', t.visible(later), '0');
  perform t.eq('others can no longer claim a closed drop',
    public.claim_drop(later, -26.2041, 28.0473, 5) ->> 'status', 'not_available');
  perform t.logout();
end;
$$;

-- Moderation takedown -------------------------------------------------------
update public.drops set hidden_at = now() where id = '00000000-0000-0000-0000-000000000d01';

do $$
declare
  a constant uuid := '00000000-0000-0000-0000-00000000000a';
  b constant uuid := '00000000-0000-0000-0000-00000000000b';
  live constant uuid := '00000000-0000-0000-0000-000000000d01';
  song constant text := '00000000-0000-0000-0000-00000000000a/song.mp3';
begin
  perform t.login(b);
  perform t.eq('a takedown hides the drop from claimers', t.visible(live), '0');
  perform t.eq('a takedown removes it from the library',
    (select count(*)::text from public.my_library() where drop_id = live), '0');
  perform t.eq('a takedown stops playback',
    (select count(*)::text from storage.objects where name = song), '0');
  perform t.login(a);
  perform t.eq('the artist can still reach their own audio',
    (select count(*)::text from storage.objects where name = song), '1');
  perform t.logout();
end;
$$;

-- Bucket setup --------------------------------------------------------------
select t.eq('the audio bucket is private', public::text, 'false') from storage.buckets where id = 'audio';

-- ===========================================================================
-- Features (20261108000000_features.sql)
-- ===========================================================================

create function t.denied_fn(p_name text, p_sql text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise notice 'not ok - % (was allowed)', p_name;
exception when insufficient_privilege or raise_exception then
  raise notice 'ok - %', p_name;
end;
$$;

insert into auth.users (id, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000d', '{}'),
  ('00000000-0000-0000-0000-00000000000e', '{"display_name": "Leaving Artist"}');

insert into public.trails (id, artist_id, title) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000000a', 'City trail');

-- f01 limited to 2 copies, f02 hidden pin with a riddle, f03 private with a code,
-- f04 and f05 make up the trail, f06 is the trail's bonus track.
insert into public.drops (id, artist_id, title, lat, lng, radius_m, audio_path, rights_confirmed,
  max_claims, hide_pin, hint, access_code, trail_id, is_bonus, cover_path, preview_path, lyrics, message,
  opens_at)
values
  ('00000000-0000-0000-0000-000000000f01', '00000000-0000-0000-0000-00000000000a', 'Limited', -26.10, 28.05, 50,
   '00000000-0000-0000-0000-00000000000a/limited.mp3', true, 2, false, null, null, null, false,
   '00000000-0000-0000-0000-00000000000a/limited.jpg', '00000000-0000-0000-0000-00000000000a/limited.wav',
   'la la la', 'thanks for walking', now() - interval '1 hour'),
  ('00000000-0000-0000-0000-000000000f02', '00000000-0000-0000-0000-00000000000a', 'Secret', -26.20, 28.10, 50,
   '00000000-0000-0000-0000-00000000000a/secret.mp3', true, null, true, 'Under the big tree', null, null, false,
   null, null, null, null, now() - interval '1 hour'),
  ('00000000-0000-0000-0000-000000000f03', '00000000-0000-0000-0000-00000000000a', 'Party', -26.30, 28.15, 50,
   '00000000-0000-0000-0000-00000000000a/party.mp3', true, null, false, null, 'GIG2026', null, false,
   null, null, null, null, now() - interval '1 hour'),
  ('00000000-0000-0000-0000-000000000f04', '00000000-0000-0000-0000-00000000000a', 'Trail one', -26.40, 28.20, 50,
   '00000000-0000-0000-0000-00000000000a/t1.mp3', true, null, false, null, null,
   '00000000-0000-0000-0000-0000000000f1', false, null, null, null, null, now() - interval '1 hour'),
  ('00000000-0000-0000-0000-000000000f05', '00000000-0000-0000-0000-00000000000a', 'Trail two', -26.41, 28.21, 50,
   '00000000-0000-0000-0000-00000000000a/t2.mp3', true, null, false, null, null,
   '00000000-0000-0000-0000-0000000000f1', false, null, null, null, null, now() - interval '1 hour');
insert into public.drops (id, artist_id, title, audio_path, rights_confirmed, trail_id, is_bonus, opens_at)
values ('00000000-0000-0000-0000-000000000f06', '00000000-0000-0000-0000-00000000000a', 'Bonus',
  '00000000-0000-0000-0000-00000000000a/bonus.mp3', true, '00000000-0000-0000-0000-0000000000f1', true,
  now() - interval '1 hour');

insert into storage.objects (bucket_id, name) values
  ('covers', '00000000-0000-0000-0000-00000000000a/limited.jpg'),
  ('previews', '00000000-0000-0000-0000-00000000000a/limited.wav'),
  ('audio', '00000000-0000-0000-0000-00000000000a/limited.mp3'),
  ('audio', '00000000-0000-0000-0000-00000000000a/bonus.mp3'),
  ('audio', '00000000-0000-0000-0000-00000000000a/unused.mp3');

-- Hidden pins ---------------------------------------------------------------
do $$
declare
  secret constant uuid := '00000000-0000-0000-0000-000000000f02';
  d public.drops;
begin
  select * into d from public.drops where id = secret;
  perform t.eq('a hidden pin gets a rough area', (d.area_lat is not null and d.area_m >= 400)::text, 'true');
  perform t.eq('the claim zone fits inside the rough area',
    (public.distance_m(d.lat, d.lng, d.area_lat, d.area_lng) + d.radius_m <= d.area_m)::text, 'true');
  perform t.eq('the rough area is not the exact spot', (d.area_lat <> d.lat or d.area_lng <> d.lng)::text, 'true');
end;
$$;

do $$
declare
  b constant uuid := '00000000-0000-0000-0000-00000000000b';
  secret constant uuid := '00000000-0000-0000-0000-000000000f02';
  m record;
begin
  perform t.anon();
  perform t.denied('exact locations are not readable from the table', 'select lat, lng from public.drops');
  perform t.denied('lyrics are not readable from the table', 'select lyrics from public.drops');
  perform t.denied('access codes are not readable from the table', 'select access_code from public.drops');
  select * into m from public.map_drops() where id = secret;
  perform t.eq('the map shows a hidden pin as an area', m.exact::text, 'false');
  perform t.eq('the map gives the hidden pin''s riddle', m.hint, 'Under the big tree');
  perform t.eq('the map does not give the exact spot of a hidden pin', (m.lat <> -26.20 or m.lng <> 28.10)::text, 'true');
  perform t.eq('the map gives exact spots for normal pins',
    (select lat::text from public.map_drops() where id = '00000000-0000-0000-0000-000000000f01'), '-26.1');

  perform t.login(b);
  perform t.eq('a hidden pin is revealed close by',
    (select lat::text from public.reveal_nearby(-26.2005, 28.10, 10) where id = secret), '-26.2');
  perform t.eq('a hidden pin stays hidden from 1 km away',
    (select count(*)::text from public.reveal_nearby(-26.209, 28.10, 10) where id = secret), '0');
  perform t.eq('a rough location reveals nothing',
    (select count(*)::text from public.reveal_nearby(-26.20, 28.10, 150) where id = secret), '0');
  perform t.eq('a faked location reveals nothing',
    (select count(*)::text from public.reveal_nearby(-26.20, 28.10, 10, true) where id = secret), '0');
  perform t.eq('a hidden pin can still be claimed on the spot',
    public.claim_drop(secret, -26.20, 28.10, 5) ->> 'status', 'claimed');
  perform t.eq('after claiming, the map shows the exact spot',
    (select exact::text from public.map_drops() where id = secret), 'true');
  perform t.logout();
end;
$$;

-- Private drops -------------------------------------------------------------
do $$
declare
  a constant uuid := '00000000-0000-0000-0000-00000000000a';
  b constant uuid := '00000000-0000-0000-0000-00000000000b';
  party constant uuid := '00000000-0000-0000-0000-000000000f03';
begin
  perform t.anon();
  perform t.eq('a private drop is not on the map without the code',
    (select count(*)::text from public.map_drops() where id = party), '0');
  perform t.eq('a private drop is not in the table without the code', t.visible(party), '0');
  perform t.eq('the right code shows a private drop, in any case',
    (select count(*)::text from public.map_drops(array['gig2026']) where id = party), '1');
  perform t.eq('a wrong code shows nothing',
    (select count(*)::text from public.map_drops(array['NOPE']) where id = party), '0');

  perform t.login(b);
  perform t.eq('claiming a private drop without the code looks like it does not exist',
    public.claim_drop(party, -26.30, 28.15, 5) ->> 'status', 'not_available');
  perform t.eq('claiming a private drop with the code works',
    public.claim_drop(party, -26.30, 28.15, 5, false, array['NOPE', ' gig2026 ']) ->> 'status', 'claimed');
  perform t.eq('a claimed private drop stays on the map without the code',
    (select count(*)::text from public.map_drops() where id = party), '1');
  perform t.login(a);
  perform t.eq('artists see their own private drops on the map',
    (select count(*)::text from public.map_drops() where id = party), '1');
  perform t.rejected('codes must be 4 to 20 letters or numbers',
    format($q$update public.drops set access_code = 'ab' where id = '%s'$q$, party));
  perform t.logout();
end;
$$;

-- Limited editions ----------------------------------------------------------
do $$
declare
  b constant uuid := '00000000-0000-0000-0000-00000000000b';
  c constant uuid := '00000000-0000-0000-0000-00000000000c';
  d constant uuid := '00000000-0000-0000-0000-00000000000d';
  limited constant uuid := '00000000-0000-0000-0000-000000000f01';
  r jsonb;
begin
  perform t.login(b);
  r := public.claim_drop(limited, -26.10, 28.05, 5);
  perform t.eq('the first claimer gets copy 1', r ->> 'edition', '1');
  perform t.eq('the claim reports the edition size', r ->> 'max_claims', '2');
  perform t.login(c);
  perform t.eq('the second claimer gets copy 2',
    public.claim_drop(limited, -26.10, 28.05, 5) ->> 'edition', '2');
  perform t.login(d);
  perform t.eq('a third claimer finds it sold out',
    public.claim_drop(limited, -26.10, 28.05, 5) ->> 'status', 'sold_out');
  perform t.eq('the map shows how many were claimed',
    (select claims_count::text from public.map_drops() where id = limited), '2');
  perform t.login(b);
  perform t.eq('the library shows the copy number',
    (select edition::text from public.my_library() where drop_id = limited), '1');
  perform t.eq('the library gives claimers the lyrics',
    (select lyrics from public.my_library() where drop_id = limited), 'la la la');
  perform t.eq('the library gives claimers the artist''s message',
    (select message from public.my_library() where drop_id = limited), 'thanks for walking');
  perform t.logout();
end;
$$;

-- Trails and bonus tracks ---------------------------------------------------
do $$
declare
  a constant uuid := '00000000-0000-0000-0000-00000000000a';
  b constant uuid := '00000000-0000-0000-0000-00000000000b';
  trail constant uuid := '00000000-0000-0000-0000-0000000000f1';
  bonus constant uuid := '00000000-0000-0000-0000-000000000f06';
  r jsonb;
begin
  perform t.anon();
  perform t.eq('a bonus track is not on the map', (select count(*)::text from public.map_drops() where id = bonus), '0');
  perform t.eq('the trail is listed with its size',
    (select o.total::text from public.trails_overview() o where o.id = trail), '2');

  perform t.login(b);
  perform t.eq('a bonus track cannot be claimed like a normal drop',
    public.claim_drop(bonus, 0, 0, 5) ->> 'status', 'not_available');
  perform t.eq('one trail drop found',
    public.claim_drop('00000000-0000-0000-0000-000000000f04', -26.40, 28.20, 5) ->> 'status', 'claimed');
  r := public.claim_trail_bonus(trail);
  perform t.eq('the bonus stays locked until the trail is complete', r ->> 'status', 'locked');
  perform t.eq('locked reports how many are left', r ->> 'remaining', '1');
  perform t.eq('progress shows 1 of 2', (select o.found::text from public.trails_overview() o where o.id = trail), '1');
  perform public.claim_drop('00000000-0000-0000-0000-000000000f05', -26.41, 28.21, 5);
  perform t.eq('finishing the trail unlocks the bonus',
    public.claim_trail_bonus(trail) ->> 'status', 'claimed');
  perform t.eq('the bonus is in the library',
    (select is_bonus::text from public.my_library() where drop_id = bonus), 'true');
  perform t.eq('the bonus audio can be played',
    (select count(*)::text from storage.objects where name = a || '/bonus.mp3'), '1');

  perform t.login(a);
  insert into public.trails (title) values ('Mine');
  perform t.eq('artists can create trails', (select count(*)::text from public.trails where artist_id = a), '2');
  perform t.login(b);
  perform t.denied('artists cannot add drops to someone else''s trail',
    format($q$insert into public.drops (title, lat, lng, audio_path, rights_confirmed, trail_id)
              values ('x', 0, 0, '%s/x.mp3', true, '%s')$q$, b, trail));
  perform t.denied('artists cannot use someone else''s cover',
    format($q$insert into public.drops (title, lat, lng, audio_path, rights_confirmed, cover_path)
              values ('x', 0, 0, '%s/x.mp3', true, '%s/limited.jpg')$q$, b, a));
  perform t.logout();
end;
$$;

-- Covers, previews and cleanup ----------------------------------------------
do $$
declare
  a constant uuid := '00000000-0000-0000-0000-00000000000a';
  b constant uuid := '00000000-0000-0000-0000-00000000000b';
  n bigint;
begin
  perform t.anon();
  perform t.eq('anyone can see the cover of a live drop',
    (select count(*)::text from storage.objects where name = a || '/limited.jpg'), '1');
  perform t.eq('anyone can hear the preview of a live drop',
    (select count(*)::text from storage.objects where name = a || '/limited.wav'), '1');
  perform t.eq('the full audio is still private',
    (select count(*)::text from storage.objects where name = a || '/limited.mp3'), '0');
  perform t.login(b);
  perform t.denied('listeners cannot upload covers to an artist''s folder',
    format($q$insert into storage.objects (bucket_id, name) values ('covers', '%s/x.jpg')$q$, a));
  insert into storage.objects (bucket_id, name) values ('covers', b || '/mine.jpg');
  perform t.eq('artists can upload covers to their own folder',
    (select count(*)::text from storage.objects where name = b || '/mine.jpg'), '1');

  perform t.login(a);
  delete from storage.objects where name = a || '/bonus.mp3';
  get diagnostics n = row_count;
  perform t.eq('files a drop uses cannot be removed', n::text, '0');
  delete from storage.objects where name = a || '/unused.mp3';
  get diagnostics n = row_count;
  perform t.eq('unused files can be removed', n::text, '1');
  perform t.login(b);
  delete from storage.objects where name = a || '/limited.jpg';
  get diagnostics n = row_count;
  perform t.eq('others cannot remove an artist''s files', n::text, '0');
  perform t.logout();
end;
$$;

-- Follows -------------------------------------------------------------------
do $$
declare
  a constant uuid := '00000000-0000-0000-0000-00000000000a';
  b constant uuid := '00000000-0000-0000-0000-00000000000b';
  c constant uuid := '00000000-0000-0000-0000-00000000000c';
begin
  perform t.login(b);
  insert into public.follows (artist_id) values (a);
  perform t.eq('listeners can follow an artist', (select count(*)::text from public.my_follows()), '1');
  perform t.eq('artist_info shows the follow', (public.artist_info(a) ->> 'following'), 'true');
  perform t.eq('the feed shows the artist''s public drops',
    (select count(*)::text from public.following_feed() where title = 'Limited'), '1');
  perform t.eq('the feed leaves out private drops',
    (select count(*)::text from public.following_feed() where title = 'Party'), '0');
  perform t.rejected('you cannot follow yourself',
    format($q$insert into public.follows (artist_id) values ('%s')$q$, b));
  perform t.login(c);
  perform t.eq('others cannot see who you follow', (select count(*)::text from public.follows), '0');
  perform t.eq('artist_info counts followers', (public.artist_info(a) ->> 'followers'), '1');
  perform t.denied('you cannot follow on someone else''s behalf',
    format($q$insert into public.follows (follower_id, artist_id) values ('%s', '%s')$q$, b, a));
  perform t.login(b);
  delete from public.follows where artist_id = a;
  perform t.eq('listeners can unfollow', (select count(*)::text from public.my_follows()), '0');
  perform t.logout();
end;
$$;

-- Reports and moderation ----------------------------------------------------
insert into public.admins (user_id) values ('00000000-0000-0000-0000-00000000000c');

do $$
declare
  a constant uuid := '00000000-0000-0000-0000-00000000000a';
  b constant uuid := '00000000-0000-0000-0000-00000000000b';
  c constant uuid := '00000000-0000-0000-0000-00000000000c';
  limited constant uuid := '00000000-0000-0000-0000-000000000f01';
  rid uuid;
begin
  perform t.anon();
  perform t.denied('signed-out visitors cannot report',
    format($q$insert into public.reports (drop_id, reason) values ('%s', 'x')$q$, limited));
  perform t.login(b);
  insert into public.reports (drop_id, reason) values (limited, 'Not their song');
  perform t.denied('reporters cannot read reports', 'select * from public.reports');
  perform t.eq('a listener is not a moderator', public.is_admin()::text, 'false');
  perform t.denied_fn('listeners cannot list reports', 'select * from public.admin_reports()');
  perform t.denied_fn('listeners cannot take drops down',
    format($q$select public.admin_set_hidden('%s', true)$q$, limited));
  perform t.login(a);
  perform t.denied_fn('artists cannot take drops down either',
    format($q$select public.admin_set_hidden('%s', true)$q$, limited));

  perform t.login(c);
  perform t.eq('a moderator is recognised', public.is_admin()::text, 'true');
  select report_id into rid from public.admin_reports() where drop_id = limited;
  perform t.eq('moderators see the report', (rid is not null)::text, 'true');
  perform t.eq('moderators can hear the reported audio',
    (select count(*)::text from storage.objects where name = a || '/limited.mp3'), '1');
  perform public.admin_set_hidden(limited, true);
  perform t.eq('a takedown removes the drop from the map',
    (select count(*)::text from public.map_drops() where id = limited), '0');
  perform public.admin_set_hidden(limited, false);
  perform t.eq('undoing a takedown brings it back',
    (select count(*)::text from public.map_drops() where id = limited), '1');
  perform public.admin_resolve_report(rid);
  perform t.eq('reports can be marked resolved',
    (select (resolved_at is not null)::text from public.admin_reports() where report_id = rid), 'true');
  perform t.logout();
end;
$$;

-- Account deletion ----------------------------------------------------------
insert into public.drops (id, artist_id, title, lat, lng, audio_path, rights_confirmed, opens_at) values
  ('00000000-0000-0000-0000-000000000e01', '00000000-0000-0000-0000-00000000000e', 'Kept', -26.5, 28.3,
   '00000000-0000-0000-0000-00000000000e/kept.mp3', true, now() - interval '1 hour'),
  ('00000000-0000-0000-0000-000000000e02', '00000000-0000-0000-0000-00000000000e', 'Unclaimed', -26.5, 28.3,
   '00000000-0000-0000-0000-00000000000e/unclaimed.mp3', true, now() - interval '1 hour');
insert into storage.objects (bucket_id, name) values
  ('audio', '00000000-0000-0000-0000-00000000000e/kept.mp3');

do $$
declare
  b constant uuid := '00000000-0000-0000-0000-00000000000b';
  e constant uuid := '00000000-0000-0000-0000-00000000000e';
  kept constant uuid := '00000000-0000-0000-0000-000000000e01';
begin
  perform t.login(b);
  perform public.claim_drop(kept, -26.5, 28.3, 5);
  perform t.anon();
  perform t.denied('signed-out visitors cannot delete accounts', 'select public.delete_my_account()');

  perform t.login(e);
  perform public.delete_my_account();
  perform t.logout();
  perform t.eq('deleting an account removes the user',
    (select count(*)::text from auth.users where id = e), '0');
  perform t.eq('drops nobody claimed are removed',
    (select count(*)::text from public.drops where id = '00000000-0000-0000-0000-000000000e02'), '0');
  perform t.eq('claimed drops close',
    (select (closes_at <= now())::text from public.drops where id = kept), 'true');

  perform t.login(b);
  perform t.eq('listeners keep songs from a deleted artist',
    (select artist_name from public.my_library() where drop_id = kept), 'Former artist');
  perform t.eq('and can still play them',
    (select count(*)::text from storage.objects where name = e || '/kept.mp3'), '1');
  perform t.logout();
end;
$$;

select t.eq('the covers bucket is private', public::text, 'false') from storage.buckets where id = 'covers';
select t.eq('the previews bucket is private', public::text, 'false') from storage.buckets where id = 'previews';

-- Radio stations ------------------------------------------------------------
insert into auth.users (id, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000f', '{"display_name": "Radio Leaver"}');

do $$
declare
  a constant uuid := '00000000-0000-0000-0000-00000000000a';
  b constant uuid := '00000000-0000-0000-0000-00000000000b';
  c constant uuid := '00000000-0000-0000-0000-00000000000c';
  d constant uuid := '00000000-0000-0000-0000-00000000000d';
  s uuid;
  r jsonb;
  track1 constant text := '00000000-0000-0000-0000-00000000000a/radio1.mp3';
  track2 constant text := '00000000-0000-0000-0000-00000000000a/radio2.mp3';
begin
  perform t.login(a);
  insert into public.stations (title, lat, lng, radius_m, rights_confirmed)
  values ('Joburg Radio', -26.2041, 28.0473, 500, true) returning id into s;
  insert into storage.objects (bucket_id, name) values ('station-audio', track1), ('station-audio', track2);
  insert into public.station_tracks (station_id, position, title, audio_path, duration_s) values
    (s, 0, 'One', track1, 180), (s, 1, 'Two', track2, 200);
  perform t.eq('artists see their own playlist', (select jsonb_array_length(public.my_stations() -> 0 -> 'tracks'))::text, '2');
  perform t.eq('owners tune in from anywhere',
    public.tune_in(s, 0, 0, 5000) ->> 'status', 'tuned');
  perform t.rejected('stations need the rights box ticked',
    format('insert into public.stations (title, lat, lng, rights_confirmed) values (%L, 0, 0, false)', 'No'));

  perform t.anon();
  perform t.eq('signed-out visitors see stations on the map',
    (select count(*)::text from public.map_stations() where id = s), '1');
  perform t.eq('the map does not say signed-out visitors own it',
    (select mine::text from public.map_stations() where id = s), 'false');
  perform t.denied_fn('signed-out visitors cannot tune in', format('select public.tune_in(%L, -26.2041, 28.0473, 5)', s));
  perform t.denied('signed-out visitors cannot read playlists', 'select 1 from public.station_tracks');

  perform t.login(b);
  perform t.eq('listeners cannot read playlists directly',
    (select count(*)::text from public.station_tracks), '0');
  perform t.eq('station audio is private before tuning in',
    (select count(*)::text from storage.objects where name = track1), '0');
  r := public.tune_in(s, -26.21, 28.0473, 5);
  perform t.eq('too far from the station', r ->> 'status', 'too_far');
  perform t.eq('and how far', r ->> 'distance_m', '656');
  perform t.eq('rough locations are refused', public.tune_in(s, -26.2014, 28.0473, 200) ->> 'status', 'low_accuracy');
  perform t.eq('faked locations are refused', public.tune_in(s, -26.2014, 28.0473, 5, true) ->> 'status', 'simulated_location');
  perform t.eq('broken locations are refused', public.tune_in(s, 'NaN', 28.0473, 5) ->> 'status', 'invalid_location');
  perform t.eq('no pass after a refused tune-in',
    (select count(*)::text from storage.objects where name = track1), '0');
  r := public.tune_in(s, -26.2014, 28.0473, 120);
  perform t.eq('inside the zone tunes in', r ->> 'status', 'tuned');
  perform t.eq('with the playlist in order', r -> 'tracks' -> 1 ->> 'title', 'Two');
  perform t.eq('and the clock', (r ? 'now' and r ? 'started_at')::text, 'true');
  perform t.eq('off air until the artist goes live', r ->> 'on_air', 'false');
  perform t.eq('tuned-in listeners can play the station audio',
    (select count(*)::text from storage.objects where bucket_id = 'station-audio'), '2');
  perform t.denied_fn('nobody gets a live ticket while off air', format('select public.live_pass(%L)', s));
  perform t.denied_fn('listeners cannot put a station on air', format('select public.station_heartbeat(%L, true)', s));
  perform t.denied('listeners cannot add tracks to someone else''s station',
    format('insert into public.station_tracks (station_id, title, audio_path, duration_s) values (%L, %L, %L, 10)',
      s, 'Mine', b || '/x.mp3'));
  update public.stations set title = 'Hijacked' where id = s;
  delete from public.stations where id = s;
  perform t.denied('listeners cannot read the live flag', 'select live_seen_at from public.stations');

  perform t.login(d);
  perform t.eq('other listeners still have no pass',
    (select count(*)::text from storage.objects where bucket_id = 'station-audio'), '0');

  perform t.login(a);
  perform t.eq('listeners cannot rename or delete stations',
    (select title from public.stations where id = s), 'Joburg Radio');
  perform public.station_heartbeat(s, true);
  perform t.eq('the owner gets a host ticket', public.live_pass(s) ->> 'role', 'host');
  perform t.eq('the map shows it on air', (select on_air::text from public.map_stations() where id = s), 'true');
  delete from storage.objects where name = track2;
  perform t.eq('station audio in a playlist stays',
    (select count(*)::text from storage.objects where name = track2), '1');

  perform t.login(b);
  perform t.eq('tuned-in listeners get a listener ticket while on air', public.live_pass(s) ->> 'role', 'listener');
  perform t.login(d);
  perform t.denied_fn('listeners without a pass get no live ticket', format('select public.live_pass(%L)', s));

  perform t.logout();
  update public.station_passes set expires_at = now() - interval '1 second' where user_id = b;
  perform t.login(b);
  perform t.eq('an expired pass stops the music',
    (select count(*)::text from storage.objects where bucket_id = 'station-audio'), '0');
  perform t.denied_fn('and the live ticket', format('select public.live_pass(%L)', s));
  perform public.tune_in(s, -26.2014, 28.0473, 5);

  perform t.logout();
  update public.stations set live_seen_at = now() - interval '2 minutes' where id = s;
  perform t.login(b);
  perform t.eq('a broadcaster gone quiet for 90 seconds is off air',
    (select on_air::text from public.map_stations() where id = s), 'false');

  perform t.login(a);
  delete from public.station_tracks where audio_path = track2;
  delete from storage.objects where name = track2;
  perform t.eq('station audio out of the playlist can be deleted',
    (select count(*)::text from storage.objects where name = track2), '0');
  perform public.station_heartbeat(s, true);

  perform t.login(b);
  perform t.denied_fn('listeners cannot take stations down', format('select public.admin_set_station_hidden(%L, true)', s));
  perform t.login(c);
  perform t.eq('moderators see stations', (select count(*)::text from public.admin_stations() where id = s), '1');
  perform public.admin_set_station_hidden(s, true);
  perform t.login(b);
  perform t.eq('a taken-down station is off the map', (select count(*)::text from public.map_stations() where id = s), '0');
  perform t.eq('and cannot be tuned', public.tune_in(s, -26.2014, 28.0473, 5) ->> 'status', 'not_available');
  perform t.eq('and its audio stops', (select count(*)::text from storage.objects where bucket_id = 'station-audio'), '0');
  perform t.login(a);
  perform t.denied_fn('and its owner cannot go live', format('select public.station_heartbeat(%L, true)', s));
  perform t.login(c);
  perform public.admin_set_station_hidden(s, false);
  perform t.logout();
end;
$$;

do $$
declare
  f constant uuid := '00000000-0000-0000-0000-00000000000f';
  s uuid;
begin
  perform t.login(f);
  insert into public.stations (title, lat, lng, rights_confirmed) values ('Leaving FM', 0, 0, true) returning id into s;
  insert into storage.objects (bucket_id, name) values ('station-audio', f || '/leave.mp3');
  insert into public.station_tracks (station_id, title, audio_path, duration_s) values (s, 'Bye', f || '/leave.mp3', 60);
  perform public.retire_my_drops();
  perform t.eq('closing an account removes its stations',
    (select count(*)::text from public.stations where owner_id = f), '0');
  delete from storage.objects where name = f || '/leave.mp3';
  perform t.eq('so their audio can be cleaned up',
    (select count(*)::text from storage.objects where name = f || '/leave.mp3'), '0');
  perform t.logout();
end;
$$;

select t.eq('the station audio bucket is private', public::text, 'false') from storage.buckets where id = 'station-audio';
