-- =====================================================================
-- Livery Forge - Supabase database setup
-- ---------------------------------------------------------------------
-- HOW TO USE (beginner friendly):
--   1. Open your project on https://supabase.com
--   2. Left menu -> "SQL Editor" -> "New query"
--   3. Paste this WHOLE file and press "Run".
--   It is safe to run again later (it only adds what is missing).
--
-- What it creates:
--   profiles        one row per account (username, role: user/creator/both)
--   cloud_projects  your livery projects, so they come back after reinstalling
--   listings        the Livery Forge Marketplace
--   reviews         star ratings + comments on listings
--   favorites       "hangar" of liveries a user liked
--   library         liveries a user downloaded (re-install after reinstall)
--   follows         users following creators
--   storage buckets project-files (private) and marketplace (public)
--
-- Security: Row Level Security (RLS) is ON for every table, so people can
-- only change their own data, even though the app uses the public anon key.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- PROFILES
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  username      text unique not null check (username ~ '^[a-z0-9_]{3,24}$'),
  display_name  text not null default '' check (char_length(display_name) <= 60),
  role          text not null default 'user' check (role in ('user', 'creator', 'both')),
  bio           text not null default '' check (char_length(bio) <= 600),
  website       text not null default '' check (char_length(website) <= 200),
  avatar_url    text not null default '',
  accent_color  text not null default '#3b82f6' check (accent_color ~ '^#[0-9a-fA-F]{6}$'),
  home_airport  text not null default '' check (char_length(home_airport) <= 8),
  favorite_aircraft text not null default '' check (char_length(favorite_aircraft) <= 80),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles are public" on public.profiles;
create policy "profiles are public" on public.profiles
  for select using (true);

drop policy if exists "users update own profile" on public.profiles;
create policy "users update own profile" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- Create a profile automatically when someone signs up.
-- The app sends username, display_name and role in the sign-up metadata.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  wanted  text := lower(coalesce(new.raw_user_meta_data ->> 'username', ''));
  r       text := coalesce(new.raw_user_meta_data ->> 'role', 'user');
  final   text;
begin
  if r not in ('user', 'creator', 'both') then r := 'user'; end if;
  wanted := regexp_replace(wanted, '[^a-z0-9_]', '', 'g');
  if char_length(wanted) < 3 or exists (select 1 from public.profiles where username = wanted) then
    final := 'pilot_' || substr(replace(new.id::text, '-', ''), 1, 10);
  else
    final := left(wanted, 24);
  end if;
  insert into public.profiles (id, username, display_name, role)
  values (new.id, final,
          left(coalesce(new.raw_user_meta_data ->> 'display_name', final), 60),
          r);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Lets the sign-up form check a username before creating the account.
create or replace function public.username_available(name text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select lower(name) ~ '^[a-z0-9_]{3,24}$'
     and not exists (select 1 from public.profiles where username = lower(name));
$$;
grant execute on function public.username_available(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- CLOUD PROJECTS (your private livery projects)
-- ---------------------------------------------------------------------
create table if not exists public.cloud_projects (
  user_id     uuid not null references auth.users (id) on delete cascade,
  id          text not null check (id ~ '^[a-z0-9][a-z0-9-]{5,63}$'),
  name        text not null default '',
  aircraft    text not null default '',
  data        jsonb not null default '{}'::jsonb,   -- project.json
  files       jsonb not null default '{}'::jsonb,   -- { "rel/path": { "sha1": "...", "size": 123 } }
  total_bytes bigint not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.cloud_projects enable row level security;

drop policy if exists "owner reads projects" on public.cloud_projects;
create policy "owner reads projects" on public.cloud_projects
  for select using (auth.uid() = user_id);
drop policy if exists "owner inserts projects" on public.cloud_projects;
create policy "owner inserts projects" on public.cloud_projects
  for insert with check (auth.uid() = user_id);
drop policy if exists "owner updates projects" on public.cloud_projects;
create policy "owner updates projects" on public.cloud_projects
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "owner deletes projects" on public.cloud_projects;
create policy "owner deletes projects" on public.cloud_projects
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- MARKETPLACE LISTINGS
-- ---------------------------------------------------------------------
create table if not exists public.listings (
  id                uuid primary key default gen_random_uuid(),
  creator_id        uuid not null references public.profiles (id) on delete cascade,
  project_id        text not null default '',
  package_name      text not null check (package_name ~ '^[a-z0-9-]{3,120}$'),
  title             text not null check (char_length(title) between 3 and 120),
  aircraft          text not null default '',
  aircraft_folder   text not null default '',
  short_description text not null default '' check (char_length(short_description) <= 300),
  description       text not null default '' check (char_length(description) <= 20000),
  changelog         text not null default '' check (char_length(changelog) <= 10000),
  license           text not null default '' check (char_length(license) <= 2000),
  registration      text not null default '',
  version           text not null default '1.0.0',
  tags              text[] not null default '{}',
  modular           boolean not null default false,
  file_path         text not null,
  file_size         bigint not null default 0,
  thumbnail_path    text not null default '',
  screenshots       text[] not null default '{}',
  status            text not null default 'published' check (status in ('published', 'hidden')),
  downloads         integer not null default 0,
  rating_avg        numeric(3, 2) not null default 0,
  rating_count      integer not null default 0,
  favorites_count   integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (creator_id, package_name)
);

create index if not exists listings_created_idx on public.listings (created_at desc);
create index if not exists listings_downloads_idx on public.listings (downloads desc);

alter table public.listings enable row level security;

drop policy if exists "published listings are public" on public.listings;
create policy "published listings are public" on public.listings
  for select using (status = 'published' or creator_id = auth.uid());

-- Only accounts with role creator/both may publish.
drop policy if exists "creators insert own listings" on public.listings;
create policy "creators insert own listings" on public.listings
  for insert with check (
    creator_id = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('creator', 'both'))
  );
drop policy if exists "creators update own listings" on public.listings;
create policy "creators update own listings" on public.listings
  for update using (creator_id = auth.uid()) with check (creator_id = auth.uid());
drop policy if exists "creators delete own listings" on public.listings;
create policy "creators delete own listings" on public.listings
  for delete using (creator_id = auth.uid());

-- Creators may not fake their download / rating numbers. Only our own
-- functions (which set lf.internal) can change those columns.
create or replace function public.protect_listing_stats()
returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('lf.internal', true), '') <> '1' then
    if tg_op = 'INSERT' then
      new.downloads := 0; new.rating_avg := 0; new.rating_count := 0; new.favorites_count := 0;
    else
      new.downloads := old.downloads; new.rating_avg := old.rating_avg;
      new.rating_count := old.rating_count; new.favorites_count := old.favorites_count;
      new.creator_id := old.creator_id;
    end if;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists listings_protect_stats on public.listings;
create trigger listings_protect_stats
  before insert or update on public.listings
  for each row execute function public.protect_listing_stats();

-- ---------------------------------------------------------------------
-- REVIEWS (1-5 stars)
-- ---------------------------------------------------------------------
create table if not exists public.reviews (
  listing_id uuid not null references public.listings (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  rating     smallint not null check (rating between 1 and 5),
  comment    text not null default '' check (char_length(comment) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (listing_id, user_id)
);

alter table public.reviews enable row level security;

drop policy if exists "reviews are public" on public.reviews;
create policy "reviews are public" on public.reviews for select using (true);
drop policy if exists "users write own reviews" on public.reviews;
create policy "users write own reviews" on public.reviews
  for insert with check (
    user_id = auth.uid()
    and not exists (select 1 from public.listings l where l.id = listing_id and l.creator_id = auth.uid())
  );
drop policy if exists "users update own reviews" on public.reviews;
create policy "users update own reviews" on public.reviews
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "users delete own reviews" on public.reviews;
create policy "users delete own reviews" on public.reviews
  for delete using (user_id = auth.uid());

create or replace function public.refresh_listing_rating()
returns trigger language plpgsql security definer set search_path = public as $$
declare lid uuid := coalesce(new.listing_id, old.listing_id);
begin
  perform set_config('lf.internal', '1', true);
  update public.listings l set
    rating_avg   = coalesce((select round(avg(rating)::numeric, 2) from public.reviews where listing_id = lid), 0),
    rating_count = (select count(*) from public.reviews where listing_id = lid)
  where l.id = lid;
  perform set_config('lf.internal', '', true);
  return null;
end;
$$;

drop trigger if exists reviews_refresh_rating on public.reviews;
create trigger reviews_refresh_rating
  after insert or update or delete on public.reviews
  for each row execute function public.refresh_listing_rating();

-- ---------------------------------------------------------------------
-- FAVORITES ("My hangar")
-- ---------------------------------------------------------------------
create table if not exists public.favorites (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  listing_id uuid not null references public.listings (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, listing_id)
);

alter table public.favorites enable row level security;
drop policy if exists "users manage own favorites" on public.favorites;
create policy "users manage own favorites" on public.favorites
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.refresh_favorites_count()
returns trigger language plpgsql security definer set search_path = public as $$
declare lid uuid := coalesce(new.listing_id, old.listing_id);
begin
  perform set_config('lf.internal', '1', true);
  update public.listings set favorites_count = (select count(*) from public.favorites where listing_id = lid) where id = lid;
  perform set_config('lf.internal', '', true);
  return null;
end;
$$;

drop trigger if exists favorites_refresh_count on public.favorites;
create trigger favorites_refresh_count
  after insert or delete on public.favorites
  for each row execute function public.refresh_favorites_count();

-- ---------------------------------------------------------------------
-- LIBRARY (what a user downloaded - survives reinstalling the app)
-- ---------------------------------------------------------------------
create table if not exists public.library (
  user_id       uuid not null references public.profiles (id) on delete cascade,
  listing_id    uuid not null references public.listings (id) on delete cascade,
  version       text not null default '',
  downloaded_at timestamptz not null default now(),
  primary key (user_id, listing_id)
);

alter table public.library enable row level security;
drop policy if exists "users read own library" on public.library;
create policy "users read own library" on public.library
  for select using (user_id = auth.uid());
drop policy if exists "users delete own library" on public.library;
create policy "users delete own library" on public.library
  for delete using (user_id = auth.uid());

-- Called by the app when a download starts. Counts each user only once.
create or replace function public.record_download(p_listing uuid)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_version text;
  inserted  boolean := false;
  total     integer;
begin
  if auth.uid() is null then raise exception 'Not logged in'; end if;
  select version into v_version from public.listings where id = p_listing and status = 'published';
  if not found then raise exception 'Listing not found'; end if;

  insert into public.library (user_id, listing_id, version)
  values (auth.uid(), p_listing, v_version)
  on conflict (user_id, listing_id) do update set version = excluded.version, downloaded_at = now()
  returning (xmax = 0) into inserted;

  perform set_config('lf.internal', '1', true);
  if inserted then
    update public.listings set downloads = downloads + 1 where id = p_listing returning downloads into total;
  else
    select downloads into total from public.listings where id = p_listing;
  end if;
  perform set_config('lf.internal', '', true);
  return total;
end;
$$;
grant execute on function public.record_download(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- FOLLOWS (follow your favourite creators)
-- ---------------------------------------------------------------------
create table if not exists public.follows (
  follower_id uuid not null references public.profiles (id) on delete cascade,
  creator_id  uuid not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, creator_id),
  check (follower_id <> creator_id)
);

alter table public.follows enable row level security;
drop policy if exists "follows are public" on public.follows;
create policy "follows are public" on public.follows for select using (true);
drop policy if exists "users follow" on public.follows;
create policy "users follow" on public.follows
  for insert with check (follower_id = auth.uid());
drop policy if exists "users unfollow" on public.follows;
create policy "users unfollow" on public.follows
  for delete using (follower_id = auth.uid());

-- Creator stats for profile pages.
create or replace view public.creator_stats
with (security_invoker = true) as
select p.id,
       p.username,
       (select count(*) from public.listings l where l.creator_id = p.id and l.status = 'published') as listings,
       (select coalesce(sum(downloads), 0) from public.listings l where l.creator_id = p.id and l.status = 'published') as downloads,
       (select count(*) from public.follows f where f.creator_id = p.id) as followers
from public.profiles p;

grant select on public.creator_stats to anon, authenticated;

-- ---------------------------------------------------------------------
-- STORAGE BUCKETS
--   project-files  (private) <user id>/<project id>/<file>
--   marketplace    (public)  <user id>/<listing package>/<file>
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('project-files', 'project-files', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('marketplace', 'marketplace', true)
on conflict (id) do nothing;

drop policy if exists "lf project files: owner read" on storage.objects;
create policy "lf project files: owner read" on storage.objects
  for select to authenticated
  using (bucket_id = 'project-files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "lf project files: owner insert" on storage.objects;
create policy "lf project files: owner insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'project-files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "lf project files: owner update" on storage.objects;
create policy "lf project files: owner update" on storage.objects
  for update to authenticated
  using (bucket_id = 'project-files' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'project-files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "lf project files: owner delete" on storage.objects;
create policy "lf project files: owner delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'project-files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "lf marketplace: public read" on storage.objects;
create policy "lf marketplace: public read" on storage.objects
  for select
  using (bucket_id = 'marketplace');

drop policy if exists "lf marketplace: owner insert" on storage.objects;
create policy "lf marketplace: owner insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'marketplace' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "lf marketplace: owner update" on storage.objects;
create policy "lf marketplace: owner update" on storage.objects
  for update to authenticated
  using (bucket_id = 'marketplace' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'marketplace' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "lf marketplace: owner delete" on storage.objects;
create policy "lf marketplace: owner delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'marketplace' and (storage.foldername(name))[1] = auth.uid()::text);
