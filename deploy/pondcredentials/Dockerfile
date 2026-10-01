# The build context is services/pondcredentials (see compose.yaml): the goose submodule and every
# native engine of the pond stay out of it. Images are pinned by digest like deploy/remote-access.
FROM rust:1.94.1-slim-bookworm@sha256:cf9dd0ec73e75f827fe59123fff9dc65af1a1c8363c3c31ee8d7f8ad0b6a5fb2 AS build
# aws-lc-rs, the crypto behind jsonwebtoken, compiles C with cmake. These packages are the one
# unpinned input to the build; a rebuild picks up whatever Debian ships for them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends cmake gcc g++ make perl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY token/ token/
COPY server/ server/
RUN cargo build --release --locked -p pondcredentials
FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f
COPY --from=build /src/target/release/pondcredentials /pondcredentials
ENTRYPOINT ["/pondcredentials"]
