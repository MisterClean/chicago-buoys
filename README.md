# Chicago Buoys

Chicago Buoys is a small, source-backed social bot for Great Lakes buoy observations. It turns quality-controlled measurements into concise lake briefs, temperature-profile stories, sparse event posts, and—only when redistribution permission is documented—recent buoy-camera clips.

The codebase is station- and publisher-agnostic. Chicago buoy 45198 is the example configuration, and Bluesky is the first publisher adapter.

## Design goals

- Publish useful changes, not every telemetry row.
- Keep every statement traceable to source observations.
- Suppress stale, missing, suspect, and bad measurements.
- Keep forecasts and official warnings separate from observations.
- Prevent duplicate posts across retries and restarts.
- Run comfortably as short-lived jobs on a memory-constrained host.
- Keep handles, app passwords, sessions, and runtime state out of Git.

## Current capabilities

- GLOS ERDDAP ingestion with IOOS aggregate quality flags and temperature profiles.
- NOAA/NDBC real-time text fallback with field-level missingness.
- SQLite history, run health, media tracking, and publication idempotency.
- Morning and afternoon briefs with 24-hour comparisons.
- Wave-build, pressure-fall, rapid-cooling, and mixing event detection.
- Thermal-profile posts.
- Bluesky text, image, and multipart video publishing.
- Shadow mode that performs the full decision path without publishing.
- Camera ETag/freshness/size validation with a fail-closed rights gate.
- Docker, systemd, GHCR, and health-check deployment artifacts.

## Safety defaults

The example configuration uses `mode: shadow`, disables its publisher, and disables camera publishing. Camera media cannot be published unless all of the following are configured:

- `camera.enabled: true`
- `camera.rights.status: granted`
- a non-empty permission reference
- the required attribution

The Chicago camera owner currently states that its images and videos may not be redistributed without express prior permission. Do not enable the camera adapter until that permission has been obtained and recorded.

Event posts also default to `posting.eventsEnabled: false`. Keep them disabled until their thresholds have been backtested against a complete deployment season; ordinary briefs can be launched independently.

## Requirements

- Node.js 24 LTS
- npm 11+

No web framework, browser, Redis, Python, or `ffmpeg` is required.

## Local setup

```bash
npm ci
cp config.example.yaml config.yaml
npm run check
npm run dev -- doctor --config config.yaml
npm run dev -- tick --config config.yaml --dry-run
```

`config.yaml`, `.env`, SQLite files, sessions, and generated state are ignored by Git.

## Commands

```text
tick       Poll sources and evaluate every currently due editorial lane.
poll       Poll sources without publishing scheduled briefs.
brief      Render one morning or afternoon brief.
camera     Evaluate the camera opportunity and permission gates.
weekly     Render the current thermal-profile feature when sufficient data exists.
migrate    Create or migrate the SQLite database.
doctor     Validate configuration, database, and optionally live sources.
shadow     Poll and render previews without publishing.
```

Common options:

```text
--config PATH
--database PATH
--dry-run
--offline
--station KEY
--lane morning|afternoon
```

The `CHICAGO_BUOYS_CONFIG` and `DATABASE_PATH` environment variables provide runtime defaults.

## Configuration and secrets

Station metadata and editorial rules belong in YAML. Publisher credentials are referenced by environment-variable name:

```yaml
publishers:
  - id: primary-bluesky
    kind: bluesky
    enabled: false
    handleEnv: CHICAGO_BUOYS_BLUESKY_HANDLE
    appPasswordEnv: CHICAGO_BUOYS_BLUESKY_APP_PASSWORD
    expectedDidEnv: CHICAGO_BUOYS_BLUESKY_DID
    sessionPath: ./var/bluesky-session.json
```

Copy [`.env.example`](.env.example) for the variable names. Use a Bluesky app password, never the account's main password. Session files contain credentials and must remain private.

## Source precedence

1. GLOS `obs_98` supplies historical rows, profiles, and aggregate QC.
2. GLOS `obs_98_latest` is only a freshness marker.
3. NDBC supplies a durable surface-observation fallback.

The bot does not average disagreements. A bad or suspect GLOS flag cannot be bypassed by substituting the likely same sensor value from NDBC.

## Runtime model

Production runs a single `tick` every ten minutes under a systemd timer. Each invocation starts, ingests, decides, publishes at most the permitted work, records its result, and exits. A host-level `flock` serializes session refresh and SQLite writes.

See [deployment documentation](docs/deployment.md) for the container and Lightsail layout.

## Development

```bash
npm run typecheck
npm test
npm run build
npm run check
```

All network adapters accept injected clients so unit tests remain deterministic and offline.

## Data and safety notice

Buoy observations may be delayed, incomplete, corrected, or inaccurate. This project is an observation service, not a forecast, warning, or declaration that conditions are safe or unsafe. Consult current official National Weather Service marine products for forecasts and warnings.

## License

[MIT](LICENSE)
