# Deployment

Chicago Lake Pulse is deployed as a short-lived, non-root container launched by systemd. There is no resident application server and no source checkout on the host. GitHub Actions builds an immutable `linux/amd64` image, a manual workflow promotes it, and the Lightsail host resolves the promoted tag to a digest before deployment.

Publishing is disabled by default in both `config.example.yaml` and the example host environment. A deployment does not implicitly make the bot live.

## Runtime layout

The deployment uses these host paths:

```text
/etc/chicago-lake-pulse.env
/etc/chicago-lake-pulse-image.env
/etc/chicago-lake-pulse/config.yaml
/var/lib/chicago-lake-pulse/
  pulse.sqlite
  pulse.sqlite-wal
  pulse.sqlite-shm
  bluesky-session.json
  deploy-backups/
  deploy-shadow/
  deployments/
```

`/etc/chicago-lake-pulse.env` contains account-specific environment variables and must be `root:root` mode `0600`. `/etc/chicago-lake-pulse-image.env` is managed by the deployer and points to an immutable GHCR digest. `/etc/chicago-lake-pulse/config.yaml` is readable inside the container and should be `root:root` mode `0644`. The state directory is `1000:1000` mode `0700`, matching the unprivileged `node` user in the image.

The checked-in config is safe for an initial deployment. Before installing it on the host, change these paths:

```yaml
app:
  mode: shadow
  databasePath: /state/pulse.sqlite

publishers:
  - id: primary-bluesky
    kind: bluesky
    enabled: false
    sessionPath: /state/bluesky-session.json
```

Leave every camera's `enabled` value false and its rights status `not_granted` until written redistribution permission has been recorded. Camera publication has a separate gate from ordinary observation posts.

On this memory-constrained host, set `camera.maximumBytes` to `25000000`. The currently observed clip is well below that ceiling; a larger replacement will be skipped instead of risking an out-of-memory failure.

## Host prerequisites

The host needs Docker Engine, systemd, Bash, `curl`, `jq`, `sqlite3`, and `flock` from `util-linux`. It must be able to make outbound HTTPS requests to GHCR, GLOS, NOAA, Freeboard's media bucket, and Bluesky. No inbound application port is opened.

The GHCR package must be public for the tokenless host deployer. The deployer deliberately does not store GitHub credentials on the server.

Install the host files from a trusted checkout:

```bash
sudo install -d -m 0700 -o 1000 -g 1000 /var/lib/chicago-lake-pulse
sudo install -d -m 0755 -o root -g root /etc/chicago-lake-pulse
sudo install -m 0644 -o root -g root config.example.yaml /etc/chicago-lake-pulse/config.yaml
sudo install -m 0600 -o root -g root deploy/examples/chicago-lake-pulse.env /etc/chicago-lake-pulse.env

sudo install -m 0755 -o root -g root deploy/bin/deploy-chicago-lake-pulse /usr/local/sbin/deploy-chicago-lake-pulse
sudo install -m 0755 -o root -g root deploy/bin/check-chicago-lake-pulse /usr/local/sbin/check-chicago-lake-pulse
sudo install -m 0644 -o root -g root deploy/systemd/* /etc/systemd/system/
```

Edit the installed config to use the `/state` paths shown above. Fill the Bluesky handle and app password only in `/etc/chicago-lake-pulse.env`; do not put them in the repository, image, unit files, shell history, or GitHub Actions variables.

Validate and load the unit files:

```bash
sudo systemd-analyze verify /etc/systemd/system/chicago-lake-pulse*.service /etc/systemd/system/chicago-lake-pulse*.timer
sudo systemctl daemon-reload
sudo systemctl enable --now chicago-lake-pulse.timer chicago-lake-pulse-deploy.timer
```

The main timer safely skips runs until the deployer creates `/etc/chicago-lake-pulse-image.env`. Enable the health timer only after the first successful tick has created and populated the database:

```bash
sudo systemctl enable --now chicago-lake-pulse-health.timer
```

## Schedules and limits

The main timer runs at minutes 04, 14, 24, 34, 44, and 54 UTC, plus a small randomized delay. This is shortly after the buoy's expected ten-minute observation boundary and is offset from other bot workloads on the host. The application decides which editorial opportunity is due and uses SQLite idempotency records to make boot catch-up safe.

The container has:

- A 192 MiB memory limit and 256 MiB memory-plus-swap limit.
- A 128 MiB V8 heap ceiling.
- A 64-process limit and 0.75-CPU ceiling.
- A 64 MiB, non-executable `/tmp` tmpfs for bounded transient files.
- No Linux capabilities, no privilege escalation, and a read-only root filesystem.
- No published ports and no persistent media volume.
- Journald logging instead of Docker JSON log files.

The current camera clip is well below the recommended 25 MB ceiling. The current media boundary holds one clip in memory and uses zero-copy views for multipart upload, so the lower host-specific ceiling is important. Store only ETags, hashes, timestamps, and post receipts in SQLite; never persist the media itself.

## Image lifecycle

`.github/workflows/ci.yml` checks pull requests, compiles and tests with Node 24, builds the runtime image, exercises the CLI, and rejects an unpacked image larger than 250 MB.

`.github/workflows/publish.yml` runs after a push to `main`. It repeats the checks and publishes only an immutable tag of the form:

```text
ghcr.io/misterclean/chicago-lake-pulse:sha-<full-commit-sha>
```

The image includes OCI source and revision labels plus provenance and an SBOM. Its Node 24 Alpine base is pinned to an immutable digest in the Dockerfile. It is not production merely because it was pushed.

`.github/workflows/promote.yml` is a manual workflow. Give it a full, lowercase 40-character commit SHA. It verifies that the candidate exists and points the `production` tag at that already-built image. Configure the repository's `production` GitHub Environment to require approval.

The host polls `production` every 15 minutes. It resolves the tag through GHCR's registry API, pins the digest, and performs the following checks before switching the image pointer:

1. Refuse the pull if less than 2 GiB is free.
2. Verify the image is `linux/amd64` and has the expected source and commit labels.
3. Stop new bot timer activations and defer if a run is still active.
4. Make a consistent SQLite backup.
5. Apply migrations to a disposable database copy.
6. Reject schema removals or incompatible column changes.
7. Run offline diagnostics and a networked, publishing-disabled tick against the copy.
8. Apply the expand-only migration to production and run offline diagnostics.
9. Atomically update the image pointer and run one normal cycle.
10. Restore the previous image pointer if that cycle fails.

The production database remains expanded during a code rollback, so migrations must remain backward-compatible. Destructive migrations require a separate, explicitly reviewed maintenance procedure.

To deploy a known digest without waiting for the polling timer:

```bash
sudo /usr/local/sbin/deploy-chicago-lake-pulse --digest sha256:<64-hex-character-digest>
```

## Shadow validation and going live

Keep the installed config in `app.mode: shadow` with the publisher disabled for the initial validation period. Inspect generated intents, source freshness, and logs:

```bash
sudo systemctl start chicago-lake-pulse.service
sudo journalctl -u chicago-lake-pulse.service --since today --no-pager
sudo sqlite3 -readonly /var/lib/chicago-lake-pulse/pulse.sqlite \
  "SELECT id, command, started_at, finished_at, status, error FROM runs ORDER BY id DESC LIMIT 20;"
sudo sqlite3 -readonly /var/lib/chicago-lake-pulse/pulse.sqlite \
  "SELECT kind, status, created_at, error FROM publication_intents ORDER BY id DESC LIMIT 20;"
```

Before going live:

1. Confirm scheduled text and timestamps against the source dashboards.
2. Confirm stale, partial, duplicate, and corrected rows behave correctly.
3. Confirm camera publishing remains disabled.
4. Put a valid app password in the host env file.
5. Change the publisher's `enabled` value to true and `app.mode` to `live` in the host config.
6. Start one manual service cycle and inspect its receipt before relying on the timer.

Turning ordinary posts live does not authorize camera publication. Camera config and the deployment gates must remain disabled until written permission exists.

## Health and operations

The hourly health check verifies:

- Timer state and immutable local image availability.
- Secret and state-directory permissions.
- SQLite `quick_check` and database size.
- A successful `tick` in the previous 35 minutes.
- No three consecutive failed ticks.
- No publication stuck for more than 30 minutes.
- No container running past ten minutes.
- At least 1.5 GiB free disk, with a warning below 2 GiB.

Useful commands:

```bash
systemctl list-timers --all 'chicago-lake-pulse*'
sudo systemctl status chicago-lake-pulse.service chicago-lake-pulse-deploy.service chicago-lake-pulse-health.service
sudo journalctl -u chicago-lake-pulse.service -u chicago-lake-pulse-deploy.service -u chicago-lake-pulse-health.service --since today --no-pager
sudo /usr/local/sbin/check-chicago-lake-pulse
```

The deployer retains five SQLite deployment backups, twenty small deployment metadata files, the current image, and one rollback image. It removes only an exact superseded Chicago Lake Pulse image reference; it never performs a broad Docker prune.

Operational data should be retained for about 400 days unless longer backtesting is explicitly required. Use incremental auto-vacuum and periodic `PRAGMA optimize`; avoid frequent full `VACUUM`, which needs temporary disk space. Do not retain downloaded video.

## Rollback

Each deployment metadata file in `/var/lib/chicago-lake-pulse/deployments` records `IMAGE`, `PREVIOUS_IMAGE`, and the corresponding database backup. To roll back code, stop the timer, atomically replace the image pointer with the recorded immutable previous image, start one service cycle, then restart the timer.

Do not restore a database backup merely to roll back code: migrations are expand-only and the old code remains compatible. Restore a database only for confirmed corruption and only after checking whether posts were delivered after the backup, because reverting the publication ledger can allow duplicate posts.
