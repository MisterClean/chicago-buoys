# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's security-advisory feature. Do not open a public issue containing credentials, access tokens, session files, private infrastructure details, or an exploitable vulnerability.

## Secrets

The repository must never contain:

- Bluesky handles tied to a private deployment configuration
- app passwords or main account passwords
- access or refresh JWTs
- generated session files
- SSH private keys
- production environment files

Runtime secrets belong in a root-owned environment file or an equivalent secret manager. Logs must not contain request authorization headers, session objects, or raw secret values.
