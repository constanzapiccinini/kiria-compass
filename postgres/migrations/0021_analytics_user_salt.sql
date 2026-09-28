-- ---------------------------------------------------------------------------
-- 0021 — a per-client salt for the analytics user hash (§2)
--
-- §2: "the analysis tables store a per-client salted hash of `created_by_user_id`,
-- never the raw id or an email." A hash with no salt is not much of a hash here — the
-- user-id space for one client is a handful of people, so an unsalted digest is
-- reversible by trying them all, and the whole point is that "which person asked this"
-- is not an analytics question.
--
-- **Why not an app secret.** `fusebase secret create` would be the sanctioned home for
-- an HMAC key, and it is what the app-secrets rules describe. But a secret's *value*
-- is set by a person in the UI after registration, so the feature would ship inert and
-- fail closed until someone remembered — and a rating control that silently refuses is
-- worse than one that works. A random per-client salt generated on first use needs no
-- operator step and is a real salt: it is not derivable from anything public.
--
-- **Why not reuse an existing secret.** Deriving the salt from `OPENAI_API_KEY` was the
-- tempting shortcut. Rotating that key would then silently split one person into two
-- across the rotation date, and nothing would look wrong.
--
-- **Why a separate migration from 0020.** 0020 is already applied to dev, and the
-- migration discipline is absolute: fixes are new tail versions, never rewrites of an
-- applied file. This is one column in its own version rather than a quiet edit.
--
-- Nullable and filled lazily by `lib/insights.ts` — a client that has never had a
-- rating or an embedding needs no salt, and generating one for all seven accounts up
-- front would be writing rows nothing reads.
-- ---------------------------------------------------------------------------

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS analytics_user_salt TEXT;

COMMENT ON COLUMN public.clients.analytics_user_salt IS
  'Random per-client salt for the analytics user hash. Generated on first use, never '
  'exposed by any route, and never sent to the client app. Rotating it deliberately '
  'orphans every existing hash for that client, which is the intended way to make old '
  'analytics rows unattributable.';
