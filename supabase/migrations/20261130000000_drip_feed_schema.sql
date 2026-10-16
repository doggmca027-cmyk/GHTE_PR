-- Drip-feed, part 1: schema only.
--
-- orders.quantity stays the order's TOTAL amount; a drip-feed order splits it into `runs` deliveries of
-- quantity / runs, `interval` minutes apart. A plain order is runs = 1, interval = 0, so every existing row
-- and every current insert (which does not name these columns) keeps its meaning.
--
-- provider_services.is_dripfeed_enabled is the panel's own "dripfeed" flag from its services list (API v2),
-- written by sync-catalog. Nothing routes on it yet.

alter table public.orders
  add column if not exists runs integer not null default 1,
  add column if not exists interval integer not null default 0;

alter table public.orders drop constraint if exists orders_runs_check;
alter table public.orders add constraint orders_runs_check check (runs >= 1);
alter table public.orders drop constraint if exists orders_interval_check;
alter table public.orders add constraint orders_interval_check check (interval >= 0);

comment on column public.orders.runs is 'Drip-feed: number of deliveries (1 = a plain order). quantity is the total; each run is quantity / runs.';
comment on column public.orders.interval is 'Drip-feed: minutes between runs (0 for a plain order).';

alter table public.provider_services
  add column if not exists is_dripfeed_enabled boolean not null default false;

comment on column public.provider_services.is_dripfeed_enabled is 'The panel lists this service as drip-feed capable ("dripfeed" in its services list). Written by sync-catalog.';
