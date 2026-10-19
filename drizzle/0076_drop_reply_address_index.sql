-- Check 30 P4's messages_mailbox_reply_address_idx shipped in 0070 and is already on the shared
-- database. Dropped again here because main's notesForThreads (no ORDER BY) reads same-second
-- inbound emails in index order with it and picks the wrong note (CI old-code-new-schema).
-- Dropping an index never breaks old code. It can return, additively, once main carries the
-- tie-break (PR #14).
DROP INDEX IF EXISTS "messages_mailbox_reply_address_idx";