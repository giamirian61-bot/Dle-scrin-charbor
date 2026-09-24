# Stream Harbor — VPS Migration Plan

## Target architecture

YouTube <- RTMPS <- FFmpeg worker <- persistent local media/cache <- Stream Harbor supervisor

Persistent paths:
- /srv/stream-harbor/app
- /srv/stream-harbor/media
- /srv/stream-harbor/cache
- /srv/stream-harbor/logs
- /srv/stream-harbor/state

## Minimum production target

- Ubuntu 24.04 LTS
- 4+ physical/dedicated CPU threads preferred
- 8+ GB RAM
- 200+ GB NVMe/SSD minimum; 500 GB preferred
- 1 Gbit/s uplink
- >= 32 TB/month outbound or unmetered
- Full root / SSH
- systemd available
- Static public IPv4
- Provider firewall / DDoS protection

## Migration sequence

1. Provision server and secure SSH.
2. Install Node.js LTS, FFmpeg, ffprobe, git, nginx/caddy, jq, curl.
3. Clone repository to /srv/stream-harbor/app.
4. Create dedicated Linux user streamharbor.
5. Create persistent media/cache/state/log directories.
6. Copy secrets into root-readable environment file; never commit them.
7. Point MEDIA_DIR and STREAM_CACHE_DIR to persistent server paths.
8. Install systemd unit with Restart=always.
9. Add health endpoint monitoring.
10. Test one private YouTube stream.
11. Kill worker process and verify automatic worker recovery.
12. Restart Stream Harbor service and verify same broadcast recovery.
13. Reboot whole VPS and verify service + stream recovery.
14. Run 2 streams, then 3, then 8.
15. Measure CPU, RAM, disk I/O, network TX, dropped frames, speed.
16. Only after burn-in, begin public pilot streams.

## Rules during migration

- Do not change existing YouTube stream keys unless necessary.
- No bucket/http playback as the 24/7 loop source.
- FFmpeg loops only local persistent files.
- Keep Railway as fallback/staging until VPS passes burn-in.
- Never delete original bucket media during migration.
- Secrets stay outside Git.
- All production changes must be reversible by Git commit / service rollback.

## Burn-in acceptance criteria

- Worker crash recovers automatically.
- Service restart recovers automatically.
- Full VPS reboot recovers automatically.
- No repeated resets to beginning every 10–15 seconds.
- YouTube ingest remains stable after recovery.
- 3-stream test runs clean before scaling to 8.
- 24-hour test with no unexplained worker exits before public pilot.
