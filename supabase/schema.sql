-- AminFinance — Supabase schema
--
-- Mirrors the Dexie stores in client/src/lib/db/index.ts. Every table is
-- scoped by user_id and locked behind row-level security, so a user's rows
-- are unreachable from any session but their own.
--
-- Money is numeric, never float: 0.1 + 0.2 must equal 0.3 in a ledger.
-- Timestamps stay epoch-ms bigint to match the client types exactly, so no
-- conversion layer can drift between the browser and the database.

-- ---------------------------------------------------------------- transactions

create table if not exists public.transactions (
  id            text primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,
  symbol        text not null,
  asset_class   text not null check (asset_class in ('stock', 'crypto', 'commodity')),
  type          text not null check (type in ('buy', 'sell')),
  quantity      numeric not null check (quantity > 0),
  price         numeric not null check (price >= 0),
  fee           numeric not null default 0 check (fee >= 0),
  currency      text not null,
  timestamp     bigint not null,
  source        text not null check (source in ('manual', 'binance', 'csv')),
  external_id   text,
  notes         text,
  created_at    timestamptz not null default now()
);

-- The portfolio view loads one user's trades newest-first; this index is what
-- keeps that from scanning every row in the table.
create index if not exists transactions_user_time_idx
  on public.transactions (user_id, timestamp desc);

-- A Binance re-sync must not double-post fills it already imported. Partial,
-- because manual and CSV rows have no external id and would collide on null.
create unique index if not exists transactions_external_id_idx
  on public.transactions (user_id, external_id)
  where external_id is not null;

-- ------------------------------------------------------------------ snapshots

create table if not exists public.snapshots (
  user_id          uuid not null references auth.users (id) on delete cascade,
  timestamp        bigint not null,
  total_value      numeric not null,
  total_cost_basis numeric not null,
  primary key (user_id, timestamp)
);

-- --------------------------------------------------------------------- budget

create table if not exists public.budget (
  id         text primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       text not null check (kind in ('income', 'expense', 'deduction')),
  category   text not null,
  amount     numeric not null check (amount >= 0),
  currency   text not null,
  timestamp  bigint not null,
  month      text not null check (month ~ '^\d{4}-\d{2}$'),
  recurring  boolean not null default false,
  item_id    text,
  label      text,
  note       text,
  created_at timestamptz not null default now()
);

-- The month view is the primary query, and it always filters by kind on top
-- of the month. One composite index serves both without either scanning.
create index if not exists budget_user_month_kind_idx
  on public.budget (user_id, month, kind);

-- ------------------------------------------------------- row-level security
--
-- Without these policies the anon key would read every user's rows. RLS is
-- the only thing standing between a browser-held key and the whole table.

alter table public.transactions enable row level security;
alter table public.snapshots    enable row level security;
alter table public.budget       enable row level security;

create policy "own transactions" on public.transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own snapshots" on public.snapshots
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own budget" on public.budget
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
