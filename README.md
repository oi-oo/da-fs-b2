# DA Filesystem — B2

Cloudflare Worker implementation of the DA Filesystem API backed by Backblaze B2 and direct D1 access.

## Source layout

All application source stays directly under `src/`:

- `index.ts` — Worker entry point and `/api` / `/raw` routing
- `api.ts` — DA HTTP API handling
- `filesystem.ts` — provider-independent filesystem behavior
- `storage.ts` — provider-independent storage contract
- `b2.ts` — Backblaze B2 adapter
- `database.ts` — direct D1 filesystem persistence
- `auth.ts` — service authentication
- `path.ts` — path normalization and resolution helpers
- `response.ts` — DA responses and filesystem errors
- `config.ts` — service configuration and environment types

## Architecture

`filesystem.ts` does not depend directly on Backblaze B2. It depends on the generic `Storage` contract. Provider-specific behavior belongs in the provider adapter.

Adding another provider should therefore be isolated to a new adapter such as `dropbox.ts`, plus the small provider-selection/configuration change needed to instantiate it.

B2 version history is an implementation detail of `b2.ts`. A logical filesystem delete asks the storage adapter to delete a path; the B2 adapter removes all B2 versions for that path.

D1 is accessed directly by this Worker. Rack is responsible for database management, while the service uses its own D1 binding for normal filesystem operations.

## Endpoints

- `POST /api` — JSON filesystem control operations
- `POST /raw` — raw file data upload/download
- `GET /` — simple service health response

The `/stream` interface is not implemented in this first code pass.
