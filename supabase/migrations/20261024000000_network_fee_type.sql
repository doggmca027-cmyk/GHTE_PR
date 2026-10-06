-- Phase 2: a treasury entry type for blockchain network fees (gas paid when the platform moves crypto, e.g. a provider
-- top-up in TON). Its own migration: PostgreSQL cannot use a new enum value in the transaction that adds it.
alter type public.treasury_transaction_type_enum add value if not exists 'network_fee';
