-- AuctionLens guild sharing. Run once against the Neon database (Vercel > Storage >
-- your database > Query, or psql). Safe to run again.

create table if not exists groups (
    id          uuid primary key default gen_random_uuid(),
    name        text not null,
    join_code   text not null unique,
    created_at  timestamptz not null default now()
);

-- One row per installed companion. The token itself is never stored, only its hash.
create table if not exists members (
    id          uuid primary key default gen_random_uuid(),
    group_id    uuid not null references groups(id) on delete cascade,
    token_hash  text not null unique,
    label       text,
    created_at  timestamptz not null default now(),
    last_seen   timestamptz
);

-- The guild's merged history: one row per item per market, in the addon's own codec
-- (see server/lib/sync/payload.js). `daily` holds up to 90 days.
create table if not exists items (
    group_id    uuid not null references groups(id) on delete cascade,
    market      text not null,
    item_key    text not null,
    latest      text not null default '',
    daily       text not null default '',
    last_day    integer,
    updated_at  timestamptz not null default now(),
    primary key (group_id, market, item_key)
);

-- One row per finished upload, for the group's scan log page (public/index.html).
-- Added 2026-11-13: on an existing database, running this whole file again adds it.
create table if not exists upload_log (
    id          bigserial primary key,
    group_id    uuid not null references groups(id) on delete cascade,
    member_id   uuid references members(id) on delete set null,
    label       text,
    market      text not null,
    items       integer not null,
    full_upload boolean not null default false,
    last_scan   bigint not null default 0,
    created_at  timestamptz not null default now()
);
create index if not exists upload_log_recent on upload_log (group_id, created_at desc);
create index if not exists upload_log_member on upload_log (member_id, market, created_at desc);

-- How far each member's uploads for a market reach: the next upload sends only newer days.
create table if not exists uploads (
    member_id   uuid not null references members(id) on delete cascade,
    market      text not null,
    through_day integer not null,
    last_scan   bigint not null default 0,
    updated_at  timestamptz not null default now(),
    primary key (member_id, market)
);
