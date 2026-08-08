-- Storage bucket for actual intake form files (PDFs etc.), for the screener
-- web app to read from directly.
--
-- Public bucket: anyone with an object's URL can download it, matching the
-- already-public nature of form_url in the `forms` table. Only the
-- service_role key can upload/replace/delete files (no write policies are
-- defined here), consistent with how scripts/load_data.py is the only writer
-- of table data.

insert into storage.buckets (id, name, public)
values ('intake-forms', 'intake-forms', true)
on conflict (id) do nothing;

-- Points a program's `forms` row at its file in the intake-forms bucket
-- (e.g. '<program_id>/intake.pdf'), separate from form_url which is the
-- administering agency's own (external) link.
alter table forms add column if not exists storage_path text;
