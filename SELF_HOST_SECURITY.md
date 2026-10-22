# Stream Harbor: self-hosting and recovery playbook

This document is a **migration checklist, not a request to deploy**. It does not authorize restarting streams, changing live credentials, or deleting Railway resources.

## Goal

Stream Harbor controller, FFmpeg workers, media, and persistent state must be recoverable without Railway, GitHub, or an active AI connection. GitHub remains optional for source code delivery, never a runtime dependency.

## Dependency inventory

- Controller: Node.js/Express (`server.js`), persistent media and slot state under `MEDIA_DIR`.
- Worker: `stream-node.js`, `CONTROLLER_URL`, `WORKER_AGENT_TOKEN`.
- Media: S3-compatible storage using `BUCKET`, `BUCKET_ENDPOINT`, `BUCKET_REGION`, `BUCKET_ACCESS_KEY_ID`, and `BUCKET_SECRET_ACCESS_KEY`.
- Dashboard: static assets served by the controller; the detailed system endpoint is protected by `requireOwner`.
- Encryption dependency: saved stream key secrets derive their AES-GCM encryption key from `OWNER_TOKEN`. **Never rotate this value before a tested migration of encrypted records**.
- Provider-neutral CORS: set `PUBLIC_ORIGIN=https://your-controlled-domain.example` on a self-hosted controller. On Railway the existing `RAILWAY_PUBLIC_DOMAIN` can still provide the origin.

## Before cutover

1. Verify the actual standalone server and identify which FFmpeg processes and video files it currently owns. Do not assume Railway and a separate VPS share storage or state.
2. Preserve a consistent, encrypted copy of the media index, stream configurations, slot state, relevant application configuration, and every needed media file. Handle secrets separately in a secure vault, not Git.
3. Record backup sizes, file hashes, ownership and permissions. **Restore a copy into an isolated test environment** and verify that it starts without Railway.
4. Choose an independent S3-compatible endpoint (e.g. a private self-hosted object store) or implement and test another media backend; changing env variables alone is not enough to replace stored objects.
5. Restrict management access using a private administration network, HTTPS, a VPN or equivalent authenticated gate. Expose only necessary upload/stream interfaces.
6. Provide unique service credentials; use separate accounts and least privileges for publishing, streaming and trading. Do not reuse `OWNER_TOKEN` or YouTube/Telegram keys between environments.
7. Set `PUBLIC_ORIGIN`, `CONTROLLER_URL`, and the new S3 values in the test environment. Confirm upload, read, prepare and stream state **without initiating a YouTube broadcast**.

## Controlled migration

1. Schedule cutover when no active broadcasts are running (and only with owner approval for stream interruption).
2. Take a final encrypted snapshot, compare counts and checksums, and verify read/write credentials in the destination.
3. Apply validated code and variables, verify health and an authenticated media listing, and confirm all desired slot states remain stopped.
4. Switch upstream routing/domain only after independent health and recovery tests pass.
5. Keep Railway unchanged as a short-term rollback until final verification. **Only then** revoke old credentials and remove provider-side resources, with explicit sign-off.

## Independent disaster recovery

- Maintain encrypted versioned backups in at least two distinct failure domains; a second file on the same VPS disk is not offsite backup.
- Test restoration on a spare server on a regular schedule, including encrypted stream key recovery.
- Protect recovery keys separately from the server and the remote administration PC.
- Avoid exposing S3 admin ports or automation bridges directly to the Internet.
- Keep a documented minimal build/deploy procedure that can run from an offline checkout and trusted container images.

## Out of scope for automatic actions

Never start or stop YouTube broadcasts, overwrite active slot state, auto-merge migration PRs, delete provider storage, rotate `OWNER_TOKEN` without migration, or restart the production controller without a validated recovery path.
