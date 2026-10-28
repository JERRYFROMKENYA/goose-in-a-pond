# The context space

One store, one multimodal index and one set of background agents for everything a pond learns about
its household, from the household's phones, its home and its conversations. The model and the household
search the same space, and each sees only what its principal may see.

**Status: DESIGNED 2026-10-28.** Current-state claims were checked against `main` at `f8831d73` and,
where marked, measured on the nano that day. No code has changed. It replaces the memory, summary,
index, suggestion and proactive-review systems; section 2 lists what goes. It cuts across PAI-1, -2,
-3, -6, -7 and -8, so [the PAI checklist](./pai/00-checklist.md) governs every phase.

---

## 0. The rules this design keeps

These bind every phase. A phase that breaks one is wrong however good it looks.

1. **Counter-phase.** Indexing and agent work run only when the pond is not serving the household.
   A turn, a voice session or a wake word stops them within one batch. The one exception is the
   query embed a turn needs for its own retrieval.
2. **Deny by default.** Retrieval filters by the caller's principal in SQL before anything is scored.
   A guest sees nothing. An agent reads as the member it works for.
3. **Propose, do not act** (PAI-7). Agents write items and proposals. Only a member's approval turns a
   proposal into an action.
4. **Nothing leaves the household in plaintext, and personal data does not leave at all.** Phones send
   to their own pond and nowhere else. Push wakes carry no content.
5. **The KV prefix is untouched.** Per-turn context rides `<system-context>` in the user message.
6. **Every derived item names its sources.** Deleting a source deletes what was derived only from it,
   and destroying a media item's key destroys its bytes everywhere.
7. **Every number is an Orin measurement or says it is not.**

---

## 1. Why one space

Today the pond keeps five separate systems for what it knows:

- memories (`memory_fragments`, batch extraction, consolidation);
- conversation summaries (`sessions.rolling_summary`);
- an index over three corpora (`Corpus::{Memory, Context, Summary}` in `pond_vectors.db`);
- suggestions (`suggestion_queue`);
- proactive review (`drafts` and proposals).

Each has its own writer, scope filter, deletion path and lane job. A fact the household told the
pond, an email it read and a suggestion it made are three kinds of row with three privacy stories.

Measured on the nano on 2026-10-28:

- The embedder is fastembed `all-MiniLM-L6-v2` (384 dimensions, English-only).
- 25 memory vectors and 40 summary vectors exist, and nothing else is indexed.
- The nomic GGUF (146 MB) has been on disk since 14 Aug and is never loaded, because
  `embedding_provider = fastembed`.
- Context items are reachable only through `giap-context`, which ships off.

**What changes:**

- Every piece of knowledge becomes an **item** with:
  - an owner and an audience;
  - its provenance;
  - one vector in one multimodal space.
- Memories, summaries, emails, photos, camera events and suggestions are item *kinds*, not systems.
- Lifecycles stop being implied by which table a row sits in. Each kind declares its own (section 3.2).

This reverses the personal-context index's decision "one index, separate stores", deliberately. Its
reason was that "a merged store cannot be unmerged". A `kind` column with a declared lifecycle per
kind is unmerged by construction, and it buys:

- one retrieval path;
- one scope filter;
- one deletion path;
- one consent view;
- one interface for every agent.

The index's other decisions stand:

- vectors live in `pond_vectors.db` and hold no text;
- staleness is a `LEFT JOIN`, not a queue;
- every vector carries its `model_id`;
- faces stay out.

---

## 2. What this replaces

| Today | Becomes | Phase |
|---|---|---|
| Batch extraction (`BatchExtractionService`, lane job `MemoryExtraction`) | Conversation agent (6.2) | P3 |
| Dedup and ranking (`memory_relevance.rs`) | One ranker in the unified retriever. Dedup moves to Consolidation, with a threshold measured on EmbeddingGemma 2 | P3 |
| Consolidation (lane job, plus `POST /memory/consolidate`, which bypasses the lane) | Consolidation agent, lane only | P3 |
| Cleanup and decay (a 6-hour SQL timer) | The lifecycle per kind (3.2), enforced by one sweep | P1 |
| Per-turn recall (`topical_memories`), by brute-force cosine over `memory_fragments.embedding`, not the index | The unified retriever, over the index | P3 |
| Rolling summaries (`session_summary.rs`, lane job `SummaryRefresh`) and titling | Written by the Conversation agent; `hydrate_goose_session` reads them as today | P3 |
| Three corpora, plus vectors stored on `memory_fragments` and `context_items` with no `model_id` | One index keyed by item, with vectors stored only there | P1, P2 |
| Startup backfill (no idle gate) and the `IndexMaintenance` lane job | The embedding slot (5.2) | P2 |
| `IngestPipeline`'s inline embed on every bus event | Ingest (6.1), with embedding deferred to the slot | P1 |
| `giap-memory` and `giap-context` (`recall`, `search_context`) | One tool group (section 9) | P3 |
| Suggestion generation (lane job; pull only through `GET /suggestions`) and the template suggestors | Proposal agent, with delivery to the phone | P5 |
| Proactive review (`drafts` with origin `proactive`) and reminder proposals | Proposal agent. Accepted reminders stay in `reminders`, as approved commitments | P5 |
| Quiet compaction | Stays. It works on goose's live conversation, not on knowledge | n/a |

**Unwired code to delete in P1.** `memory_graph.rs` and the `memory_edges` table, whose foreign
key names a nonexistent `memories(id)`; the settings `memory_graph_enabled` and
`memory_extraction_first_pass_at`, which nothing reads; `AppState.mcp_memory`;
`session_messages.embedding`; and context retention's `purge_expired`, which nothing calls.

**Defects that go with the old systems**, each verified 2026-10-28:

- The `giap-memory` tools search at `ProfileScope::Household`, so one member's turn reads and can
  forget another member's memories. This is the open PAI-1 gap.
- MCP `save_memory` writes `profile_id: None` (`pond-mcp-server/src/memory.rs`), which makes a
  member's own save visible to the whole household.
- Turn recall and `search_context` read the vector BLOBs on source rows. Only `recall` reads the
  index, so a long context item, which has no BLOB, cannot be found semantically.
- The `SuggestionGeneration` job has no cancel watcher, so it runs on when someone starts talking.

**Tests that read source as text** and change with these phases:

- `index_chokepoints_are_wired.rs`, `redaction_chokepoints_are_wired.rs` (its memory half),
  `proactive_reviewer_is_wired.rs` and `background_writers_are_not_activity.rs` in `pond-infra`;
- `context_pipeline_is_wired.rs` and the two `context_producer_tracks_*` tests in `pond-core`;
- the inline `<system-context>` envelope tests in `goose_agent.rs`.

Each is rewritten to guard the new chokepoint, never deleted without a replacement.

---

## 3. The store

### 3.1 Items

`pond_system.db`, one table plus links. Text is stored after redaction (the existing chokepoint).

| Column | Meaning |
|---|---|
| `id` | UUIDv7, so ids are time-ordered and agent cursors are a single high-water mark |
| `kind` | `message`, `conversation`, `fact`, `entity`, `event`, `media`, `notification`, `mail`, `home_event`, `visit`, `suggestion`, `trait` |
| `source_id`, `external_id` | Unique together. Ingest is idempotent on them, as `IngestPipeline` already is on `source:external_id` |
| `owner_profile_id` | The member it belongs to. Must be set unless `audience = household` (a `CHECK`), so no private item can lose its owner (PAI-1's lesson) |
| `audience` | `private` (default) or `household`. Sharing a private item with named members is a row in `item_shares` |
| `sensitivity` | `PrivacySensitivity`, as today |
| `modality` | `text`, `image`, `audio`, `video` |
| `observed_at`, `valid_until` | When it happened, and when it stops mattering (events, suggestions) |
| `title`, `body` | Redacted text. `body` is the OCR or caption text for media, when there is any |
| `blob_id` | Encrypted media bytes (section 7) |
| `state` | `active`, `superseded`, `dismissed`, `accepted` |
| `produced_by` | `ingest` or `agent:<name>@<version>`, so a bad agent version's output can be found and withdrawn |
| `confidence` | For derived items |

`item_links(from_id, to_id, relation)` records `derived_from`, `evidence_for`, `mentions`,
`same_as` and `supersedes`.

### 3.2 Lifecycle per kind

The lifecycle is declared once in `pond-core` (policy), not in each writer.

| Kind | Who writes | Default audience | Retention | On source deletion |
|---|---|---|---|---|
| `message`, `conversation` | chat | private | Until the conversation is deleted | n/a |
| `fact`, `entity`, `trait` | agents, the model's own save | private | Until superseded or deleted | Deleted when its last `evidence_for` source goes |
| `media`, `notification`, `mail`, `visit` | ingest | private | Per source setting | n/a: these are sources |
| `home_event` | ingest | household | 7 days, as `sensor_readings` is today, unless an agent cites it | n/a |
| `event` | ingest, agents | private | Until `valid_until` + 30 days | Deleted when derived only from deleted sources |
| `suggestion` | agents | private | Until decided or `valid_until` | Withdrawn |

Approved actions do not cascade. A reminder the member accepted is their commitment, not derived
data, which is the existing decision.

### 3.3 The index

`pond_vectors.db` keeps its shape: `(item_id, model_id, modality, dims, vector)`, with no text.

- **Staleness.** An item needs a vector when no row exists for the current `model_id`
  (`needs_embedding` already works this way). Changing the model refills the index in idle time.
- **Vectors are personal data.** Inversion attacks such as Vec2Text reconstruct short inputs from
  their embeddings. Vectors are encrypted at rest like their items, and retrieval joins them to
  live, scope-filtered items.

---

## 4. Embedding: EmbeddingGemma 2

EmbeddingGemma 2 (released 2026-10-06, Apache 2.0, built on Gemma 4) puts text, code, images, audio
and video in one 768-dimension space, with Matryoshka cuts to 512, 256 and 128, and has an 8,192-token
context. Google's page gives 740M parameters in total and a 270M text model; news reports add a 170M
vision encoder and a 300M audio encoder, loadable separately. None of this is measured on the Orin
yet; that is phase P0.

What it buys here:

- **Pictures become searchable without the chat model's vision encoder.** The Orin declares no
  picture support until an encoder is measured there (`device_budget::DEVICE_MEASURED_VISION`). An
  image vector answers "find the screenshot of that restaurant" anyway.
- **One space for every modality.** A text question finds a photo, a voice note or a camera clip.
- **Over 100 languages.** A memory said in Swahili or Sheng is found by a question asked in English.

How it runs:

| Part | When it is loaded | On the turn path? |
|---|---|---|
| Text encoder | Resident if the device budget allows; otherwise loaded per batch, and the turn falls back to keyword recall | Yes: one query embed per turn, measured against the warm TTFT |
| Vision encoder | Per batch, in idle time, when free RAM covers it | No |
| Audio encoder | Per batch, in deep idle | No |

- Store 768 dimensions. A 256-dimension prefilter is not worth having below about 50,000 vectors.
- Use the model card's task prompts word for word, on both the query side and the document side.
- On the nano, 518 MB was free while E4B served (measured 2026-10-28). That is the whole budget for
  every encoder. `device_budget.rs` gets one measured constant per encoder before any of them ships.

---

## 5. Counter-phase scheduling

The pond has one GPU, one memory bus and six cores the language model also wants. Indexing that
overlaps a turn slows the turn, so the two never overlap.

### 5.1 States

| State | Entered when | Background work allowed |
|---|---|---|
| Serving | A turn is in flight, or a voice session or wake capture is active | None. Only the turn's own query embed |
| Settling | For a measured interval after the last serving signal, because follow-ups cluster | None starts. Running work finishes its batch and stops |
| Idle | Settling has passed | The embedding slot and the inference lane, in batches |
| Deep idle | The household's quiet hours, learned from 14 days of activity, and no one present | Heavy work: media backfill, audio, profile synthesis, consolidation, re-embedding after a model change |

Presence signals are the desktop in focus, a phone in the foreground (the existing heartbeat), a
voice session, and `BusEvent::Presence` from the camera.

### 5.2 Two slots, one governor

- **The inference lane** stays the only slot that runs the LLM, with its existing rules: one job at
  a time, a new turn cancels the job, and quiet passes stand.
- **The embedding slot** is new. It runs one batch at a time and is sized so a batch finishes within
  a measured bound (the target is 250 ms on the Orin for text). It checks the governor between
  batches. It may overlap a lane job, because both are background work, but never a turn.
- **Encoders are loaded per state.** The vision encoder loads in idle only when free RAM covers its
  measured budget, and it unloads when serving starts or the batch ends.
- **There is no queue.** The embedding slot finds work by the staleness join. Each agent keeps a
  cursor, `agent_cursors(agent, last_item_id)`, so a crash or restart resumes where it stopped.

Deliberate shares are the one priority: a screenshot a member sends on purpose is embedded at the
next idle moment, ahead of any backfill.

---

## 6. Agents

### 6.1 Ingest is a pipeline, not an agent

Each step runs without an LLM:

1. Receive from a route or connector, and resolve the principal (the paired device's member).
2. Normalise to an item, with an encrypted blob for media.
3. Minimise and redact. This is the existing chokepoint, which also drops one-time codes and 2FA
   notifications.
4. Deduplicate on `(source_id, external_id)`, and on the content hash for media.
5. Persist the item and its blob in one transaction.
6. Publish `BusEvent::Ingest` (PAI-8 P8, which does not exist yet).

### 6.2 The agents

Each agent is declared in `pond-core`: its trigger, principal rule, the kinds it reads, the kinds it
writes, its tool allow-list and its budget. Each runs on the PAI-6 orchestrator inside the inference
lane, and everything it produces is an item with provenance.

| Agent | Replaces | Trigger | Reads | Writes |
|---|---|---|---|---|
| Conversation | Memory extraction, summary refresh, titling | A conversation quiet for a measured interval | The conversation's new messages | Facts with evidence links, the conversation's summary and title |
| Understanding | New | New non-chat items past its cursor | The item and its nearest neighbours | Facts, entities, events and links |
| Consolidation | Consolidation | Deep idle, daily | One member's facts | Merges and supersessions. A contradiction becomes a question for the member |
| Profile | New | Deep idle, weekly | Facts, entities, visits, and decided suggestions | Traits, each with its evidence |
| Proposal | Suggestion generation, proactive review | Ingest bursts, time of day, presence, home events | The context around the trigger | Suggestions |
| Planner | New | An accepted suggestion, or a request ("plan Saturday") | Events, places, calendar | Draft itineraries and schedule entries, as proposals |

Per-turn retrieval replaces `topical_memories` (`goose_agent.rs`). It runs one scored search across
every kind the caller may see and fills `<system-context>` within PAI-3's budget.

### 6.3 Untrusted content

Mail, notifications, web pages and text read from screenshots can carry instructions aimed at the
model. Every agent that reads them follows four rules:

1. It has no tool with a side effect, and no network tool, because a fetch is an exfiltration
   channel.
2. Its output is items and proposals only.
3. A proposal shows the member which items it came from before they approve it.
4. Untrusted text reaches the model inside a data block, never as instructions.

### 6.4 Four flows

1. **Screenshot to outing.** A member shares a screenshot of a restaurant from their phone. The
   phone sends it with its OCR text. The pond stores an image item owned by that member and embeds
   it at the next idle moment. Understanding writes a `place` entity linked to the image. On Friday
   evening, Proposal finds the place, a free Saturday on the member's calendar and the travel time.
   The member's phone shows "Lunch at the place you saved on Tuesday? You're free from 12." Accepting
   makes Planner write a schedule entry.
2. **Mail to reminder.** IMAP delivers a school email. Understanding writes an `event` ("sports day,
   Friday 14:00"), and Proposal offers a reminder to both parents, because the event's audience is
   household.
3. **Home routine.** `home_event` items show the porch light switched off by hand at about 23:00 on
   twelve of fourteen nights. Proposal offers an automation, which the member approves. Nothing is
   automated until then.
4. **Recall.** A member says "Mama ana mzio wa karanga" in a conversation. Conversation writes a fact
   with that conversation as its evidence. A week later the member asks in English "what is mum
   allergic to?", and retrieval finds it.

---

## 7. From the phone to the pond

The phone app already has a proposal for its half,
[`docs/PHONE-CONTEXT.md`](https://github.com/jarida-io/goose-on-the-go/blob/main/docs/PHONE-CONTEXT.md)
(2026-10-16, nothing built). Its pipeline (collectors, reducer, outbox, sync over a proven route
only) is kept. This design adds media, the envelope and the wakes.

### 7.1 What exists

| Exists | Missing |
|---|---|
| CPace pairing, SPKI-pinned HTTPS on :4443, the embedded tailnet node off the LAN | `POST /api/v1/context/ingest` (`SourceKind::Mobile` is `AwaitingIngestRoute`) |
| Photos picked in chat, stored as session attachments | Any media item: `ItemKind` is `Message`, `Event`, `Document`, `Location`, `Task`, and nothing stores blobs |
| FCM wakes with no content: `notification_id`, `category`, `wake` (`fcm_push_relay.rs`) | APNs. The phone appears not to act on a wake until it is opened |
| Token storage in SecureStore | Collectors, a share target, a persistent outbox, background work, resumable upload |

### 7.2 Sources

| Source | Android | iOS | Mode |
|---|---|---|---|
| Deliberate shares (screenshots, photos, links, text) | Share intent | Share extension | Eager |
| Screenshot and photo albums, per album | MediaStore | PhotoKit, limited library | Lazy: on Wi-Fi, while charging |
| Message and mail notifications, per app | `NotificationListenerService` | Not available to apps | Eager, text only |
| Calendar, contacts | Read on the phone | Read on the phone | Changes only. The pond pulls CalDAV itself where it can |
| Places | Visits, clustered on the phone | `CLVisit` | Visits only, never a raw trail |

The phone does the cheap perception, which keeps raw data on the phone and work off the pond:

- OCR, with ML Kit on Android and Apple's Vision framework on iOS;
- clustering locations into named places;
- thumbnails and content hashes;
- dropping one-time codes before they are sent.

### 7.3 Transport

1. **Envelope.** Each item is sealed on the phone with HPKE (RFC 9180) to the pond's ingest key and
   signed with the device's key (StrongBox or Secure Enclave). The pond's public key comes over the
   pinned pairing channel. Where the board's storage is fused (section 8), the private key never
   leaves the pond's hardware. The same bytes are then safe over the LAN, the tailnet, or a
   store-and-forward hop while the pond is away.
2. **Outbox.** The outbox is encrypted on the phone and keyed `(source, external_id)`. Media uploads
   in resumable chunks. The phone deletes its copy once the pond acknowledges a durable write.
3. **Route.** Sync uses only a route the connection manager has proven: local, or the tailnet. The
   pond never opens a public port.
4. **Identity.** The pond takes the member from the paired device. That needs
   `Principal.proven_profile_id` filled in the auth middleware; it is `None` on every path today
   (PAI-2's next step).

### 7.4 Back to the phone

- A suggestion travels as an FCM or APNs wake with no content.
- The phone then fetches `/notifications/pending` over its proven route and shows the suggestion
  itself. Google and Apple see only that a wake happened.
- iOS needs a Notification Service Extension or a silent push, which the phone doc notes needs the
  paid team.

---

## 8. Keeping it secret

### 8.1 What is true today

- `pond_system.db`, `pond_vectors.db` and `pond_logs.db` are plain SQLite (`db.rs`); SQLCipher is
  deferred (PAI-2 section 3.4).
- Only `secrets.json` is encrypted, with XChaCha20-Poly1305 (`secret_crypto.rs`), under a key file
  that sits beside it on the same disk.
- Face embeddings, camera snapshots and the TLS key are plaintext files.
- No hardware key is used anywhere.
- PAI-2 says an Orin Nano devkit exposes no fTPM. That is true of an *unfused* board. Jetson Linux r36
  documents OP-TEE, LUKS disk encryption and an fTPM for Orin, but all of them root in the EKB. The
  EKB's key must be burned into the OemK1 or OemK2 fuse, and an unfused board uses NVIDIA's public
  test keys, which protect nothing.

### 8.2 Key hierarchy

| Layer | Protects | Key |
|---|---|---|
| Root | Everything below | Jetson: in the EKB under a fused OemK1, released by OP-TEE. Mac: a Secure Enclave key, through the Keychain. Unfused board: a key file, and the UI says so |
| Disk | The data partition | LUKS, through Jetson Linux disk encryption, unlocked by the root at boot |
| Database | `pond_system.db`, `pond_vectors.db` | SQLCipher, keyed from the root. Ships only if its measured per-turn cost on the Orin is small; otherwise the disk layer carries it |
| Blob | Each media item | A random key per blob, wrapped by the root. Deleting the item destroys the key, so its bytes are gone from every copy and backup |
| Secrets | Connector tokens | The existing envelope, with its key moved under the root |
| Backup | Off-device copies | A household recovery key printed on the setup card. Without one, a dead board loses everything |

The pond never holds per-member keys. Every key lives in the same appliance, so per-member keys would
add complexity and no protection. Members are separated by the principal filter (rule 2).

### 8.3 What the household controls

- One switch per source and per member, and nothing collects until it is on.
- An activity view showing what was indexed and when, so automatic work is visible.
- "What the pond knows about me": traits and facts, each with its evidence, each deletable.
- Disconnecting a source deletes its items and says how many (PAI-8 rule 6).
- An export of everything a member owns.

---

## 9. Surfaces

**For the model.** One tool group replaces `giap-memory` and `giap-context`:

- `search_context(query, kinds?, since?)`, where results can be pictures;
- `get_item(id)`;
- `remember(fact)`, the model's own save.

One group in place of two shrinks the preamble. The tool block changes once at upgrade, so the
preamble snapshot is rebuilt once.

**For the household** (DESIGN.md governs every screen):

- **Search.** One box. Results of every kind, pictures inline, each saying where it came from.
- **Suggestions.** Each card states its reason and its evidence ("from your screenshot on Tuesday"),
  with three choices: *Add it*, *Not now*, *Not like this*. The last two teach Profile and Proposal.
- **Sources.** Each source with its state, item count and last sync, and pause and disconnect.
- **What the pond knows**, and **Activity**, as in 8.3.
- **On the phone:** "Send to pond" in the share sheet, suggestions as notifications, and decisions
  from the notification itself.
- **By voice:** "anything for me today?" reads the member's open suggestions.

---

## 10. Phases

Each phase is stamped `LANDED` and then `VERIFIED` on the Orin, as the checklist requires, and
deletes what it replaces in the same release.

| Phase | Builds | Deletes | Gate |
|---|---|---|---|
| P0 Measure | EmbeddingGemma 2 on the Orin: resident RAM per encoder, query-embed latency against the warm TTFT, and recall against MiniLM on `memory_reachability_corpus`, `personal_context_corpus`, a new Swahili and mixed-language set, and image queries. Pick the runtime (llama.cpp or ONNX Runtime) | Nothing | It fits the budget and beats MiniLM |
| P1 Store and keys | Items, links, lifecycle policy, blob store with per-blob keys, the key hierarchy behind a port (a key file until hardware lands). Migration from memories, summaries, context items and suggestions | The `Corpus` split. The old tables after a verified migration, a release later | A migration of the nano's real store, re-run against the same directory |
| P2 Scheduler | The governor, the embedding slot, the EmbeddingGemma 2 text encoder, re-embedding | Startup backfill, `index_maintenance` | No turn on the Orin measurably slower while indexing runs |
| P3 Agents | Conversation, Understanding, Consolidation, Profile. The unified retriever and tool group | Batch extraction, summary refresh, consolidation, `topical_memories`, `giap-memory`, `giap-context` | pai-bench PAI-3 and PAI-8 on the Orin |
| P4 Phone | `POST /context/ingest`, the share target, the outbox, wakes, APNs. Then OCR, visits, notifications and albums, each behind its own switch | The phone's chat-only photo path, as an ingest special case | A shared screenshot is found by a text search on the Orin |
| P5 Proposals | Proposal and Planner, delivery, feedback | Suggestion generation, proactive review | A real suggestion reaches a phone and is decided there |
| P6 Multimodal and home | Vision and audio encoders in idle time; `home_event` items from cameras, sensors and Matter | n/a | Encoders inside the measured budget |
| P7 Internet | IMAP IDLE in place of 30-minute polling, CalDAV, webhooks over the tailnet only and signed. Google and Microsoft accounts are PAI-8 P4 and P6 | n/a | A new email becomes a suggestion with no public port open |
| P8 Hardware root | LUKS and the EKB on fused boards, the Secure Enclave on the Mac, SQLCipher if P0's cost allows | The key file, on fused boards | `giap.sh doctor` reports where the root key lives |

Prerequisites from the checklist: fill `Principal.proven_profile_id` (PAI-2), and scope
`get_session_messages` and `get_session_attachment` by principal (PAI-1). P3 closes PAI-1's
`giap-memory` household-scope gap by construction.

---

## 11. Decisions owed

| # | Decision | Recommendation |
|---|---|---|
| 1 | Reverse "one index, separate stores" for one item store | Yes, for the reasons in section 1 |
| 2 | Fuse OemK1 on shipped ponds. It is irreversible, and a bad fuse file bricks the board | Yes for shipped units, after a rehearsal on a spare board; the nano stays unfused as a test device |
| 3 | SQLCipher on top of LUKS | Decide from P0's measured per-turn cost |
| 4 | Mail: subjects or bodies | Subjects, senders and dates first; bodies as their own phase (the index doc's open decision 2) |
| 5 | Can a guest see household items? | No. Guests see nothing, the rule PAI-8 already applies to context items |
| 6 | A household recovery key on the setup card | Yes. Without one, losing the board loses the household's data |
| 7 | iOS wakes need the paid Apple team | Needed before the phone can sync on iOS while closed |

---

## 12. PAI check (checklist section 2.2)

| Question | Answer |
|---|---|
| Does it move the KV prefix? | Once, when the tool group changes at upgrade. Per-turn context stays in `<system-context>` |
| Does it add preamble tokens? | No. One tool group replaces two |
| Can `profile_id` be `None`? | Only for household items, enforced by a `CHECK` on `audience` |
| New egress without the gate? | IMAP and CalDAV already gate themselves. Webhooks arrive over the tailnet. Push carries no content |
| A secret on `Settings`? | No. Keys sit under the root |
| Can a guest reach personal data? | No. Retrieval filters by principal before scoring |
| Does a turn block on an LLM call? | No. Only a query embed sits on the turn path, and it is measured |
| A side effect without approval? | No. Agents write items and proposals only |
