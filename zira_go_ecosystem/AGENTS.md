# Zira Go working agreement

This repository powers a live-style student, driver, and Admin platform. Preserve existing user data and do not use destructive Git or database operations unless the user explicitly requests them.

## Required change timeline

After every material code, UI, API, database, payment, security, or workflow change, update the persistent Admin **Platform change timeline** before declaring the work complete.

Use `recordPlatformChange` in `zira_go_admin_routes.js` with:

- a stable, unique `key` (normally date plus a concise feature name);
- actor set to the AI or developer making the update;
- the affected `area`;
- a short user-facing `title`;
- concise `details` explaining what changed and any relevant user impact.

The timeline is visible in Admin → Operations Desk and is part of the handoff record. Do not remove or bypass this requirement.
