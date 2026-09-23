# Last reply time

Shows `Last reply: … GMT+3` in Pi's status area after an agent run containing assistant text fully settles. Tool-only runs do not update it.

The timestamp is stored as a custom session entry and restored from the active branch when the session resumes. It is not injected into the model's context.

The timezone is intentionally fixed to `Etc/GMT-3` (GMT+3), preserving the original personal `last-reply-time.ts` behavior. Change that constant in `index.ts` if desired. No tools or commands are added.
