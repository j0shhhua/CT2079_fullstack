-- Additive application security state. Existing paid orders and QR signatures are preserved.
create table browser_sessions (
  token_hash text primary key,
  kind text not null check (kind in ('account','order')),
  user_id uuid references users(id) on delete cascade,
  order_id bigint references orders(id) on delete cascade,
  fresh_until timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  check ((kind='account' and user_id is not null and order_id is null) or
         (kind='order' and order_id is not null and user_id is null))
);
create index browser_sessions_user on browser_sessions(user_id);
create table recovery_challenges (
  id uuid primary key,
  order_id bigint references orders(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  code_hash text not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz
);
alter table users add column disabled boolean not null default false;
-- Retire the original publicly documented fixture accounts without deleting their orders/events.
update users set disabled=true where (split_part(lower(email),'@',1),referral_code) in
  (('ava.tan','REF-AVA'),('raj','REF-RAJ'),('mei','REF-MEI'),('kai','REF-KAI'));
create table request_limits (
  key text primary key,
  count int not null,
  expires_at timestamptz not null
);

alter table orders drop constraint orders_status_check;
alter table orders add constraint orders_status_check check
  (status in ('pending_payment','paid','payment_failed','refund_pending','cancelled'));
alter table orders add column payment_provider text;
alter table orders add column referral_user_id uuid references users(id);
alter table orders add column points_spent int not null default 0;
alter table orders add column promo_reserved boolean not null default false;
alter table tickets drop constraint tickets_status_check;
alter table tickets add constraint tickets_status_check check (status in ('reserved','valid','used','cancelled'));
drop index tickets_one_owner_per_seat;
create unique index tickets_one_owner_per_seat on tickets(event_id,seat) where status in ('reserved','valid','used');
alter table resale_listings drop constraint resale_listings_status_check;
alter table resale_listings add constraint resale_listings_status_check check (status in ('open','pending','sold','withdrawn'));
create unique index resale_one_active on resale_listings(ticket_id) where status in ('open','pending');

create table payment_jobs (
  id uuid primary key,
  request_key text unique not null,
  holder text not null,
  fingerprint text not null,
  kind text not null check (kind in ('purchase','resale','refund')),
  order_id bigint not null references orders(id),
  amount_cents bigint not null check (amount_cents >= 0),
  method text not null,
  payment_token text,
  payment_ref text,
  refund_ref text,
  checkout_url text,
  listing_id bigint references resale_listings(id),
  status text not null default 'pending' check (status in ('pending','done','failed')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now()
);
create index payment_jobs_pending on payment_jobs(next_attempt_at) where status='pending';
create table referral_rewards (
  referred_user_id uuid primary key references users(id),
  referrer_id uuid not null references users(id),
  order_id bigint unique not null references orders(id),
  created_at timestamptz not null default now()
);

-- Retire duplicate active queue entries before enforcing uniqueness.
update queue_entries q set status='done' where status in ('waiting','admitted') and exists
  (select 1 from queue_entries earlier where earlier.event_id=q.event_id and earlier.holder=q.holder
   and earlier.status in ('waiting','admitted') and earlier.id<q.id);
create unique index queue_one_active on queue_entries(event_id,holder) where status in ('waiting','admitted');
