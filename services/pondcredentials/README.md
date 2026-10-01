# pondcredentials

Serves Apple Music developer tokens to ponds so a household needs no Apple developer key.

- `token/` (`pond-apple-token`): signs the ES256 token from a MusicKit `.p8`. **Shared**: the pond's
  `crates/pond-api` depends on it by path, so the pond and the service sign identically.
- `server/` (`pondcredentials`): the HTTP service. One route, `POST /v1/musickit/developer-token`.

This is its own Cargo workspace on purpose: the pond's workspace pulls in the goose submodule and
every native engine, and this has to build in a small Docker image with only this directory copied in.

```bash
cd services/pondcredentials
cargo test
```

Design, threat model and what it does to the privacy picture: `docs/architecture/pondcredentials.md`.
How to deploy it: `deploy/pondcredentials/README.md`.
