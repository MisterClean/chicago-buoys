# Contributing

Contributions are welcome. Please keep adapters small, deterministic, and testable without live network access.

Before opening a pull request, run:

```bash
npm ci
npm run check
```

New observation sources should preserve native units and raw provenance before normalization. New publisher adapters should implement the canonical publisher interface rather than leaking platform-specific rules into the editorial layer. Any media-source contribution must document redistribution rights and remain disabled by default when those rights are unclear.
