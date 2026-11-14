-- Eventeaseplus PostgreSQL schema (PostgreSQL 15+). Run once: psql "$DATABASE_URL" -f db/schema.sql
create extension if not exists pgcrypto;

create table users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  phone text,
  password_hash text not null,
  role text not null check (role in ('customer','organiser','admin')),
  organiser_approved boolean not null default false,
  points int not null default 0 check (points >= 0),
  referral_code text unique,
  created_at timestamptz not null default now()
);
create unique index users_email_uq on users (lower(email));

-- Admin-editable parameters (no redeploy needed)
create table settings (key text primary key, value int not null);
insert into settings values ('hold_minutes', 8), ('refund_hours', 48), ('max_seats', 8);

create table events (
  id serial primary key,
  organiser_id uuid not null references users(id),
  title text not null,
  category text not null check (category in ('Concert','Theatre','Sports','Cultural')),
  starts_at timestamptz not null,
  venue text not null,
  location text not null,
  price_vip numeric(10,2) not null check (price_vip > 0),
  price_std numeric(10,2) not null check (price_std > 0),
  price_con numeric(10,2) not null check (price_con > 0),
  rows int not null default 8 check (rows between 3 and 26),   -- A-B VIP, middle Standard, last row Concession
  cols int not null default 10 check (cols between 1 and 30),
  status text not null default 'pending' check (status in ('pending','live','rejected','cancelled')),
  high_demand boolean not null default false,                    -- smart queue on/off
  created_at timestamptz not null default now()
);
create index events_status_start on events (status, starts_at);

create table promo_codes (
  code text primary key,
  percent int not null check (percent between 1 and 100),
  valid_until timestamptz,
  usage_limit int,
  used int not null default 0,
  active boolean not null default true
);
insert into promo_codes (code, percent) values ('EARLY10', 10);

-- Guests have user_id = null; they reopen orders with order id + email.
create table orders (
  id bigint generated always as identity (start with 1001) primary key,
  user_id uuid references users(id),
  buyer_name text not null,
  buyer_email text not null,
  buyer_phone text,
  event_id int not null references events(id),
  subtotal numeric(10,2) not null,
  discount numeric(10,2) not null default 0,
  total numeric(10,2) not null,
  promo_code text,
  payment_method text not null,           -- card | paynow | stripe | transfer | resale
  payment_ref text,                       -- Stripe PaymentIntent id or simulated ref
  status text not null default 'paid' check (status in ('paid','cancelled')),
  alert_channel text not null default 'email' check (alert_channel in ('email','sms','whatsapp')),
  reminded boolean not null default false,
  created_at timestamptz not null default now()
);
create index orders_email_idx on orders (lower(buyer_email));
create index orders_user_idx on orders (user_id);
create index orders_event_idx on orders (event_id);

create table tickets (
  id bigserial primary key,
  order_id bigint not null references orders(id),   -- current owner's order (changes on transfer/resale)
  event_id int not null references events(id),
  seat text not null,
  tier text not null check (tier in ('vip','std','con')),
  price numeric(10,2) not null,                      -- face value of the seat; also the resale price cap
  status text not null default 'valid' check (status in ('valid','used','cancelled')),
  qr_version int not null default 1,                 -- bumped on transfer/resale so old QR codes die
  used_at timestamptz,
  created_at timestamptz not null default now()
);
-- The database itself prevents double-selling a seat:
create unique index tickets_one_owner_per_seat on tickets (event_id, seat) where status in ('valid','used');
create index tickets_order_idx on tickets (order_id);

create table seat_holds (
  event_id int not null references events(id) on delete cascade,
  seat text not null,
  holder text not null,                              -- user uuid, or 'g:<guest token>'
  expires_at timestamptz not null,
  primary key (event_id, seat)
);

create table queue_entries (
  id bigserial primary key,
  event_id int not null references events(id),
  holder text not null,
  status text not null default 'waiting' check (status in ('waiting','admitted','done')),
  admitted_until timestamptz,
  joined_at timestamptz not null default now()
);
create index queue_event_idx on queue_entries (event_id, status, id);

create table resale_listings (
  id bigserial primary key,
  ticket_id bigint not null references tickets(id),
  seller_order_id bigint not null references orders(id),
  price numeric(10,2) not null check (price > 0),    -- app enforces price <= amount paid
  status text not null default 'open' check (status in ('open','sold','withdrawn')),
  created_at timestamptz not null default now()
);
create unique index resale_one_open on resale_listings (ticket_id) where status = 'open';

create table loyalty_ledger (
  id bigserial primary key,
  user_id uuid not null references users(id),
  delta int not null,
  reason text not null,
  order_id bigint references orders(id),
  created_at timestamptz not null default now()
);

create table notifications (
  id bigserial primary key,
  user_id uuid,
  email text,
  phone text,
  channel text not null,
  subject text,
  body text not null,
  status text not null,                              -- sent | logged | failed
  created_at timestamptz not null default now()
);

create table fraud_flags (
  id bigserial primary key,
  kind text not null,
  detail text,
  user_id uuid,
  order_id bigint,
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);
