create table scans (
  id uuid default gen_random_uuid() primary key,
  filename text not null,
  saved_at timestamptz default now(),
  prompt_used text,
  extraction_fields jsonb,
  pdf_url text,
  thumbnail_data jsonb
);
