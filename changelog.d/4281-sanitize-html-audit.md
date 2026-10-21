Upgrade sanitize-html to 2.18.1 to prevent discarded iframe fallbacks from
exhausting the stack or bypassing the configured nesting limit. Preserve the
existing braces mitigation's patch, scope and expiry; its refreshed lockfile
digest requires the owner's separate approval before it is committed.
