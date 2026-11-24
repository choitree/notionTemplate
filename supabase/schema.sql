-- 가계부 캘린더: 로그인 사용자별 데이터 저장
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 Run 하세요. 여러 번 실행해도 안전합니다.

create table if not exists public.ledgers (
  owner      uuid primary key references auth.users (id) on delete cascade default auth.uid(),
  data       jsonb       not null default '{}'::jsonb,
  version    bigint      not null default 1,
  updated_at timestamptz not null default now()
);

comment on table public.ledgers is '사용자별 가계부 데이터 (거래·일정·카테고리·설정 전체 JSON). version은 동시 수정 감지용';

-- 행 수준 보안: 로그인한 본인 행만 읽기·쓰기 가능
alter table public.ledgers enable row level security;

drop policy if exists "ledgers_select_own" on public.ledgers;
drop policy if exists "ledgers_insert_own" on public.ledgers;
drop policy if exists "ledgers_update_own" on public.ledgers;
drop policy if exists "ledgers_delete_own" on public.ledgers;

create policy "ledgers_select_own" on public.ledgers
  for select to authenticated using ((select auth.uid()) = owner);

create policy "ledgers_insert_own" on public.ledgers
  for insert to authenticated with check ((select auth.uid()) = owner);

create policy "ledgers_update_own" on public.ledgers
  for update to authenticated using ((select auth.uid()) = owner) with check ((select auth.uid()) = owner);

create policy "ledgers_delete_own" on public.ledgers
  for delete to authenticated using ((select auth.uid()) = owner);

-- 로그인하지 않은 요청(anon)은 테이블에 접근하지 못하게
revoke all on public.ledgers from anon;
grant select, insert, update, delete on public.ledgers to authenticated;
