-- Hand-written (plan M7, A1): threads sorted as a complaint before complained_at existed get
-- the sticky complaint mark, so a later "looks great" can't make them review-eligible.
UPDATE "threads" SET "complained_at" = coalesce("classified_at", "last_message_at", now()) WHERE "category" = 'complaint' AND "complained_at" IS NULL;
