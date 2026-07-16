-- Add question type + numeric answer storage for TITA (Type-In-The-Answer) questions.
-- MCQ is the existing behaviour (options + correct_index); TITA has no options and
-- an exact numeric/text answer. TITA rows are loaded is_active=false and are NOT
-- served by the match flow until the numeric-input question type is built end-to-end
-- (get_match_question must omit options for TITA; submit_answer needs an exact-match
-- scoring branch that skips the option-shuffle/correct_index machinery).
alter table questions
  add column if not exists qtype        text not null default 'mcq' check (qtype in ('mcq','tita')),
  add column if not exists answer_value text;

comment on column questions.qtype is 'mcq = options+correct_index (served today); tita = numeric answer_value, held inactive until the numeric-input engine ships';
comment on column questions.answer_value is 'exact expected answer for tita questions (string; numeric or short text). null for mcq';
