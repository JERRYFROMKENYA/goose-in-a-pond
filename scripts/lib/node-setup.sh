#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# node-setup.sh — which Node this repo runs on, finding one, and getting one.
#
# Sourced, never run: it defines functions and does nothing else. Used by
# scripts/giap.sh (`giap.sh node`, and the UI build, install and doctor).
#
# The ranges below are not preferences. They are what the dependencies declare, read off the
# installed packages. The repo's range is the strictest of them: Electron 44 wants >= 22.12, and
# vitest wants "^22.12.0 || ^24.0.0 || >=26.0.0", which is what rules out the odd-numbered 23 and 25.
# The Matter controller is nearly inside it: matter.js 0.17 wants `>=20.19.0 <22.0.0 || >=22.13.0`
# (crates/pond-adapters-matter/src/server_setup.rs), so 22.12.x satisfies the range above and not the
# controller. node_version_matter_ok carries that hole.
#
# Building the web UI needs less: Vite wants "^20.19.0 || >=22.12.0". A server with only that (the
# Jetson) can still build the UI, so it is a separate question, node_version_ui_ok.
#
# Written for bash 3.2, the only bash on a stock macOS: no `declare -A`, no `mapfile`, no `${x,,}`.
# ─────────────────────────────────────────────────────────────────────────────

NODE_RANGE_TEXT='^22.12.0 || ^24.0.0 || >=26.0.0'
NODE_UI_RANGE_TEXT='^20.19.0 || >=22.12.0'

# Where downloaded Node versions live, and the file that remembers the one to use. Overridable so a
# test never touches the real home directory.
node_home()     { printf '%s' "${GIAP_NODE_HOME:-$HOME/.giap/node}"; }
node_dist_url() { printf '%s' "${GIAP_NODE_DIST_URL:-https://nodejs.org/dist}"; }
node_record_file() { printf '%s/.path' "$(node_home)"; }

# ── the range ────────────────────────────────────────────────────────────────

# Numeric parts of "v22.12.0" or "22.12.0". Empty when it is not a version.
_nv_major() { local v="${1#v}" m; m="${v%%.*}"; case "$m" in ''|*[!0-9]*) return 1 ;; esac; printf '%s' "$m"; }
_nv_minor() {
  local v="${1#v}" m
  case "$v" in *.*) ;; *) printf '0'; return 0 ;; esac    # "22" has no minor; ${v#*.} would return it whole
  m="${v#*.}"; m="${m%%.*}"
  case "$m" in ''|*[!0-9]*) printf '0'; return 0 ;; esac; printf '%s' "$m"
}
_nv_patch() {
  local v="${1#v}" m
  case "$v" in *.*.*) ;; *) printf '0'; return 0 ;; esac
  m="${v#*.}"; m="${m#*.}"; m="${m%%.*}"
  case "$m" in ''|*[!0-9]*) printf '0'; return 0 ;; esac; printf '%s' "$m"
}

# Negative, zero or positive, like a comparator.
_nv_cmp() {
  local a b i x y
  for i in major minor patch; do
    x="$(_nv_$i "$1")"; y="$(_nv_$i "$2")"
    if [ "$x" -ne "$y" ]; then printf '%s' "$((x - y))"; return 0; fi
  done
  printf '0'
}

# 0 when the version satisfies NODE_RANGE_TEXT.
node_version_ok() {
  local maj min
  maj="$(_nv_major "$1")" || return 1
  min="$(_nv_minor "$1")"
  if [ "$maj" -eq 22 ] && [ "$min" -ge 12 ]; then return 0; fi
  if [ "$maj" -eq 24 ]; then return 0; fi
  [ "$maj" -ge 26 ]
}

# 0 when the version can build the web UI (Vite's own floor), which is lower than the repo's range.
node_version_ui_ok() {
  local maj min
  maj="$(_nv_major "$1")" || return 1
  min="$(_nv_minor "$1")"
  if [ "$maj" -eq 20 ] && [ "$min" -ge 19 ]; then return 0; fi
  if [ "$maj" -eq 22 ] && [ "$min" -ge 12 ]; then return 0; fi
  [ "$maj" -ge 23 ]
}

# matter.js 0.17's engine range, `>=20.19.0 <22.0.0 || >=22.13.0`. The floor is a MINOR one (20.18
# satisfies "20+" and not matter.js) and there is a hole: 22.0 through 22.12. Keep this in step with
# meets_min_node in crates/pond-adapters-matter/src/server_setup.rs, which is what the server enforces.
node_version_matter_ok() {
  local maj min
  maj="$(_nv_major "$1")" || return 1
  min="$(_nv_minor "$1")"
  if [ "$maj" -eq 20 ]; then [ "$min" -ge 19 ]; return; fi
  if [ "$maj" -eq 22 ]; then [ "$min" -ge 13 ]; return; fi
  [ "$maj" -ge 21 ]
}

# A sentence for a person: why this Node cannot run the Matter controller. Empty when it can.
node_why_not_matter() {
  local maj min
  maj="$(_nv_major "$1")" || { printf 'there is no node to run it'; return 0; }
  min="$(_nv_minor "$1")"
  node_version_matter_ok "$1" && return 0
  if [ "$maj" -eq 22 ]; then
    printf 'matter.js excludes Node 22.0 through 22.12 (this is 22.%s); 22.13 or newer is fine' "$min"
  else
    printf 'matter.js needs Node 20.19 or newer'
  fi
}

# A sentence for a person: why this version is outside the range. Empty when it is inside.
node_why_not() {
  local maj min
  maj="$(_nv_major "$1")" || { printf 'that is not a Node version'; return 0; }
  min="$(_nv_minor "$1")"
  node_version_ok "$1" && return 0
  if [ "$maj" -lt 20 ]; then
    printf 'it is older than anything this repo runs on'
  elif [ "$maj" -lt 22 ]; then
    printf 'Electron 44 needs Node 22.12 or newer'
  elif [ "$maj" -eq 22 ]; then
    printf '22.%s is older than 22.12, the floor for Electron 44 and Vite 7' "$min"
  else
    # 23 and 25: current releases that never become long-term support.
    printf 'Node %s is an odd-numbered release, which the test runner (vitest) does not support: it wants 22.12+ in the 22 line, any 24, or 26 and up' "$maj"
  fi
}

# The major to install when none is present: the first number in .nvmrc, else 22.
node_preferred_major() {
  local root="${REPO_ROOT:-.}" m=""
  [ -f "$root/.nvmrc" ] && m="$(tr -cd '0-9.\n' < "$root/.nvmrc" | head -1 | cut -d. -f1)"
  case "$m" in ''|*[!0-9]*) m=22 ;; esac
  printf '%s' "$m"
}

# ── finding one that is already here ─────────────────────────────────────────

# One line per Node found, "version|bin-dir|where it came from": the one on PATH, and the ones the
# common version managers and this tool keep. The version is asked of the binary, not read off its
# path (volta's folders have no "v"), and a binary that will not run, or says nothing sensible, is
# skipped. Every glob is quoted up to its wildcard, so a home directory with a space in it is fine
# (fnm's folder on macOS, "Application Support", has one).
_node_emit() { # source, path to a node binary
  local v
  [ -x "$2" ] || return 0
  v="$("$2" --version 2>/dev/null)" || return 0
  _nv_major "$v" >/dev/null || return 0
  printf '%s|%s|%s\n' "$v" "$(dirname "$2")" "$1"
}
node_candidates() {
  local n
  if command -v node >/dev/null 2>&1; then _node_emit PATH "$(command -v node)"; fi
  for n in "${NVM_DIR:-$HOME/.nvm}"/versions/node/v*/bin/node; do _node_emit nvm "$n"; done
  for n in "${FNM_DIR:-$HOME/.local/share/fnm}"/node-versions/v*/installation/bin/node; do _node_emit fnm "$n"; done
  for n in "$HOME/Library/Application Support/fnm"/node-versions/v*/installation/bin/node; do _node_emit fnm "$n"; done
  for n in "${VOLTA_HOME:-$HOME/.volta}"/tools/image/node/*/bin/node; do _node_emit volta "$n"; done
  for n in "${ASDF_DATA_DIR:-$HOME/.asdf}"/installs/nodejs/*/bin/node; do _node_emit asdf "$n"; done
  for n in "$(node_home)"/v*/bin/node; do _node_emit download "$n"; done
}

# The best Node that is inside the range, as one "version|bin-dir|source" line; nothing when none is.
# Best is the preferred major first, then the newest.
node_find_ok() {
  local pref best="" bv="" line v
  pref="$(node_preferred_major)"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    v="${line%%|*}"
    node_version_ok "$v" || continue
    if [ -z "$best" ]; then best="$line"; bv="$v"; continue; fi
    # prefer the preferred major over any other; within the same kind, the newer
    local pv_new pv_old
    pv_new=0; pv_old=0
    [ "$(_nv_major "$v")" = "$pref" ] && pv_new=1
    [ "$(_nv_major "$bv")" = "$pref" ] && pv_old=1
    if [ "$pv_new" -gt "$pv_old" ] || { [ "$pv_new" -eq "$pv_old" ] && [ "$(_nv_cmp "$v" "$bv")" -gt 0 ]; }; then
      best="$line"; bv="$v"
    fi
  done <<EOF
$(node_candidates)
EOF
  [ -n "$best" ] && printf '%s\n' "$best"
  return 0
}

# Remember where the right Node is, so scripts can use it whatever the shell's default is.
node_record() {
  local dir="$1" f
  f="$(node_record_file)"
  mkdir -p "$(dirname "$f")" 2>/dev/null || return 1
  printf '%s\n' "$dir" > "$f"
}

# Put the right Node on PATH for this process, if the one there is not it: first the one recorded,
# then any other that is already installed. Says which on stdout and in NODE_USE_NOTE (for a caller
# that has to run it in the current shell, where $(...) would lose the PATH change), or says nothing
# when PATH was fine. NODE_USE_FROM says where it came from: `recorded`, or where an installed one
# was found (nvm, fnm, volta, asdf, download); empty when PATH was fine. The pond takes the first two
# steps of this at its own start (crates/pond-server/src/node_path.rs), so it knows the recorded one
# and not the others. Returns 1 when no Node inside the range is to be had.
node_use_repo() {
  local cur dir f line
  NODE_USE_NOTE=""; NODE_USE_FROM=""
  cur="$(node --version 2>/dev/null)" || cur=""
  if [ -n "$cur" ] && node_version_ok "$cur"; then return 0; fi
  f="$(node_record_file)"
  if [ -f "$f" ]; then
    dir="$(head -1 "$f")"
    if [ -x "$dir/node" ] && node_version_ok "$("$dir/node" --version 2>/dev/null)"; then
      PATH="$dir:$PATH"; export PATH
      NODE_USE_NOTE="using node $("$dir/node" --version) from $dir (recorded by giap.sh node)"
      NODE_USE_FROM=recorded
      printf '%s\n' "$NODE_USE_NOTE"
      return 0
    fi
  fi
  line="$(node_find_ok)"
  if [ -n "$line" ]; then
    dir="$(printf '%s' "$line" | cut -d'|' -f2)"
    PATH="$dir:$PATH"; export PATH
    NODE_USE_FROM="$(printf '%s' "$line" | cut -d'|' -f3)"
    NODE_USE_NOTE="using node ${line%%|*} from $dir ($NODE_USE_FROM)"
    printf '%s\n' "$NODE_USE_NOTE"
    return 0
  fi
  return 1
}

# Report only, change nothing: is the shell's node inside the range, and if not, is one installed
# that would do. Returns 0 when the shell's node is fine. The caller supplies ok/warn/info.
node_report() {
  local cur line
  cur="$(node --version 2>/dev/null)" || cur=""
  if [ -n "$cur" ] && node_version_ok "$cur"; then
    ok "node $cur is inside $NODE_RANGE_TEXT"
    node_version_matter_ok "$cur" || warn "but it cannot run the Matter controller: $(node_why_not_matter "$cur")"
    return 0
  fi
  if [ -n "$cur" ]; then warn "node $cur on PATH is outside $NODE_RANGE_TEXT: $(node_why_not "$cur")"
  else warn "no node on PATH (this repo needs $NODE_RANGE_TEXT)"; fi
  line="$(node_find_ok)"
  if [ -n "$line" ]; then
    ok "but node ${line%%|*} is installed in $(printf '%s' "$line" | cut -d'|' -f3) and would do"
    info "in your own shell: $(node_how_to_use "${line%%|*}" "$(printf '%s' "$line" | cut -d'|' -f2)" "$(printf '%s' "$line" | cut -d'|' -f3)")"
  else
    info "none installed that would do; run 'bash scripts/giap.sh node' to get one"
  fi
  return 1
}

# What to type to use a Node found in `source`, for a person's own shell.
node_how_to_use() {
  local version="$1" dir="$2" source="$3"
  case "$source" in
    nvm)      printf 'nvm use %s' "${version#v}" ;;
    fnm)      printf 'fnm use %s' "${version#v}" ;;
    volta)    printf 'volta pin node@%s   (or put %s first on PATH)' "$(_nv_major "$version")" "$dir" ;;
    asdf)     printf 'asdf shell nodejs %s' "${version#v}" ;;
    *)        printf 'export PATH="%s:$PATH"' "$dir" ;;
  esac
}

# ── downloading one ──────────────────────────────────────────────────────────

# darwin-arm64, darwin-x64, linux-x64 or linux-arm64, in nodejs.org's names. Fails on anything else.
node_platform() {
  case "$(uname -s)/$(uname -m)" in
    Darwin/arm64)               printf 'darwin-arm64' ;;
    Darwin/x86_64)              printf 'darwin-x64' ;;
    Linux/x86_64)               printf 'linux-x64' ;;
    Linux/aarch64|Linux/arm64)  printf 'linux-arm64' ;;
    *) return 1 ;;
  esac
}

# SHA-256 of a file, whichever tool this machine has.
node_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else return 1; fi
}

# curl, https only (or file:// for a test's local copy of nodejs.org), with TLS 1.2 or newer.
_node_curl() {
  case "$(node_dist_url)" in
    file://*) curl -fsS --proto '=file' "$@" ;;
    *)        curl -fsS --proto '=https' --tlsv1.2 "$@" ;;
  esac
}

# "version|sha256|file" for the newest release of MAJOR that has a tarball for this platform, read
# from the release listing nodejs.org publishes next to every release: one text file per major line,
# always naming the newest, so no JSON has to be parsed.
node_latest_release() {
  local major="$1" platform="$2" listing line sha file ver
  listing="$(_node_curl "$(node_dist_url)/latest-v${major}.x/SHASUMS256.txt")" || return 1
  line="$(printf '%s\n' "$listing" | grep -E "  node-v[0-9]+\\.[0-9]+\\.[0-9]+-${platform}\\.tar\\.gz\$" | head -1)"
  [ -n "$line" ] || return 2
  sha="${line%% *}"; file="${line##* }"
  ver="${file#node-}"; ver="${ver%%-${platform}.tar.gz}"
  printf '%s|%s|%s\n' "$ver" "$sha" "$file"
}

# Download, verify and unpack Node MAJOR into $(node_home)/vX.Y.Z, and point `current` at it.
# Prints the bin directory on success. Nothing is left half-done: the tarball is unpacked beside
# its destination and moved into place only after its SHA-256 matches the published one.
# Returns 1 for no network or no release, 2 for an unsupported platform, 3 for a checksum mismatch.
# Honours DRY_RUN=true by saying what it would do and touching nothing.
node_download() {
  local major="$1" platform rel ver sha file dest tmp url got home
  platform="$(node_platform)" || { echo "no official Node build for $(uname -s)/$(uname -m)" >&2; return 2; }
  home="$(node_home)"
  if [ "${DRY_RUN:-false}" = true ]; then
    echo "would fetch $(node_dist_url)/latest-v${major}.x/SHASUMS256.txt, then download the $platform tarball of the newest Node $major into $home, check its SHA-256, and unpack it" >&2
    return 0
  fi
  rel="$(node_latest_release "$major" "$platform")" || {
    echo "could not read Node $major's release listing from $(node_dist_url) for $platform" >&2; return 1; }
  ver="${rel%%|*}"; rel="${rel#*|}"; sha="${rel%%|*}"; file="${rel#*|}"
  dest="$home/$ver"

  if [ -x "$dest/bin/node" ] && [ "$("$dest/bin/node" --version 2>/dev/null)" = "$ver" ]; then
    ln -sfn "$dest" "$home/current" 2>/dev/null
    printf '%s/bin\n' "$dest"
    return 0
  fi

  mkdir -p "$home" || return 1
  tmp="$(mktemp -d "$home/.tmp.XXXXXX")" || return 1
  url="$(node_dist_url)/latest-v${major}.x/$file"
  echo "downloading $file from $(node_dist_url) ..." >&2
  if ! _node_curl -L -o "$tmp/$file" "$url"; then
    rm -rf "$tmp"; echo "the download failed" >&2; return 1
  fi
  got="$(node_sha256 "$tmp/$file")" || { rm -rf "$tmp"; echo "no sha256sum or shasum to check the download with" >&2; return 1; }
  if [ "$got" != "$sha" ]; then
    rm -rf "$tmp"
    echo "CHECKSUM MISMATCH for $file: nodejs.org lists $sha, the download is $got. Nothing was installed." >&2
    return 3
  fi
  tar -xzf "$tmp/$file" -C "$tmp" || { rm -rf "$tmp"; echo "could not unpack $file" >&2; return 1; }
  local unpacked="$tmp/${file%.tar.gz}"
  [ -x "$unpacked/bin/node" ] || { rm -rf "$tmp"; echo "the archive has no bin/node" >&2; return 1; }
  rm -rf "$dest"
  mv "$unpacked" "$dest" || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
  ln -sfn "$dest" "$home/current" 2>/dev/null
  printf '%s/bin\n' "$dest"
}

# ── installing through a version manager the person already has ───────────────

# Which managers this machine has, one per line, in the order they are tried.
node_managers() {
  local nvmdir="${NVM_DIR:-$HOME/.nvm}"
  [ -s "$nvmdir/nvm.sh" ] && echo nvm
  command -v fnm >/dev/null 2>&1 && echo fnm
  command -v volta >/dev/null 2>&1 && echo volta
  return 0
}

# Install Node MAJOR with `manager`. nvm is a shell function, so it is loaded in a shell of its own.
# Honours DRY_RUN=true. The caller finds the result with node_find_ok.
node_manager_install() {
  local manager="$1" major="$2" nvmdir="${NVM_DIR:-$HOME/.nvm}"
  if [ "${DRY_RUN:-false}" = true ]; then
    case "$manager" in
      nvm)   echo "would run: nvm install $major" >&2 ;;
      fnm)   echo "would run: fnm install $major" >&2 ;;
      volta) echo "would run: volta install node@$major" >&2 ;;
    esac
    return 0
  fi
  case "$manager" in
    nvm)   bash -c ". \"\$1\" >/dev/null 2>&1 && nvm install \"\$2\"" _ "$nvmdir/nvm.sh" "$major" ;;
    fnm)   fnm install "$major" ;;
    volta) volta install "node@$major" ;;
    *)     return 1 ;;
  esac
}

# ── putting it together ──────────────────────────────────────────────────────

# Get a Node inside the range in hand, and remember it. The caller supplies say/ok/warn/bad/info/note,
# confirm and run (giap.sh has them; the tests define their own).
#
#   node_ensure [method] [major]      method: auto (the default), download, nvm, fnm or volta
#
# In order: the Node on PATH, if it is fine; else one already installed somewhere (a version manager,
# or an earlier download of this tool), which is recorded and needs no download; else an install,
# through a manager the person already has or by downloading from nodejs.org, and only after asking.
# Returns 0 with a usable Node recorded, 1 otherwise.
node_ensure() {
  local method="${1:-auto}" major="${2:-}" cur line ver dir src m dl_dir
  [ -n "$major" ] || major="$(node_preferred_major)"

  cur="$(node --version 2>/dev/null)" || cur=""
  if [ "$method" = auto ] && [ -n "$cur" ] && node_version_ok "$cur"; then
    ok "node $cur is inside $NODE_RANGE_TEXT"
    node_version_matter_ok "$cur" || warn "but it cannot run the Matter controller: $(node_why_not_matter "$cur")"
    return 0
  fi
  if [ -n "$cur" ]; then
    warn "node $cur on PATH is outside $NODE_RANGE_TEXT: $(node_why_not "$cur")"
  else
    warn "no node on PATH (this repo needs $NODE_RANGE_TEXT)"
  fi

  if [ "$method" = auto ]; then
    line="$(node_find_ok)"
    if [ -n "$line" ]; then
      ver="${line%%|*}"; dir="$(printf '%s' "$line" | cut -d'|' -f2)"; src="$(printf '%s' "$line" | cut -d'|' -f3)"
      ok "found node $ver in $src ($dir), inside the range; nothing to download"
      if [ "${DRY_RUN:-false}" = true ]; then note "dry run: not recording it"; else
        node_record "$dir" && note "recorded, so giap.sh, the scripts here and the pond (from its next start) use it whatever your shell's default is"
      fi
      info "in your own shell: $(node_how_to_use "$ver" "$dir" "$src")"
      return 0
    fi
  fi

  case "$method" in
    auto)
      m="$(node_managers | head -1)"; [ -n "$m" ] || m=download ;;
    nvm|fnm|volta|download) m="$method" ;;
    *) bad "unknown method: $method (use auto, download, nvm, fnm or volta)"; return 1 ;;
  esac
  if [ "$m" != download ] && ! node_managers | grep -qx "$m"; then
    bad "$m is not installed on this machine"; return 1
  fi

  if [ "$m" = download ]; then
    info "No Node inside the range is installed. I can download Node $major (about 45 MB) from $(node_dist_url)"
    info "into $(node_home), checked against the SHA-256 that nodejs.org publishes for it."
    confirm "Download Node $major?" || return 1
    dl_dir="$(node_download "$major")"; local rc=$?
    if [ "$rc" -ne 0 ]; then bad "the download did not complete; nothing was installed"; return 1; fi
    if [ "${DRY_RUN:-false}" = true ]; then ok "dry run: nothing was changed"; return 0; fi
    dir="$dl_dir"; src=download
  else
    info "No Node inside the range is installed. I can install Node $major with $m."
    confirm "Install Node $major with $m?" || return 1
    node_manager_install "$m" "$major" || { bad "$m could not install Node $major"; return 1; }
    if [ "${DRY_RUN:-false}" = true ]; then ok "dry run: nothing was changed"; return 0; fi
    line="$(node_find_ok)"
    [ -n "$line" ] || { bad "$m finished, but no Node inside the range turned up"; return 1; }
    dir="$(printf '%s' "$line" | cut -d'|' -f2)"; src="$m"
  fi

  ver="$("$dir/node" --version 2>/dev/null)" || { bad "the installed node does not run"; return 1; }
  node_version_ok "$ver" || { bad "installed node $ver is outside the range, which should not happen"; return 1; }
  ok "node $ver is ready in $dir"
  node_record "$dir" && note "recorded, so giap.sh, the scripts here and the pond (from its next start) use it"
  info "in your own shell: $(node_how_to_use "$ver" "$dir" "$src")"
  return 0
}

# npm ci in both packages that have a lockfile, with the right Node first on PATH. The Electron binary
# is fetched by pond-desktop's postinstall.
node_install_deps() {
  local root="${REPO_ROOT:-.}" d
  node_use_repo >/dev/null 2>&1
  for d in pond-desktop extensions/music; do
    [ -f "$root/$d/package-lock.json" ] || { warn "$d has no package-lock.json; skipped"; continue; }
    info "$d: npm ci  (the desktop's postinstall also downloads the Electron binary, about 100 MB)"
    ( cd "$root/$d" && run npm ci ) || { bad "npm ci failed in $d"; return 1; }
  done
  ok "dependencies installed"
}
