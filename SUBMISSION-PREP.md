# SUBMISSION-PREP — krater (LOCAL DRAFT, NOT SUBMITTED)

Track: `memecoins` (spec `p0-memecoins.md`). Deadline 2026-11-14T23:59:00Z.
No push, no remote, no tags, no X post, no submit. Local commit only.

## Judge quickstart (do X → see Y), MEASURED pre-Celesto-only

```
[BASELINE] 34/34 pass NODE_EXIT=0 WALL=524s
[A16]      34/34 pass NODE_EXIT=0 WALL=217s
[FINAL]    34/34 pass NODE_EXIT=0 WALL=217s
[OPTZ]     34/34 pass 0 fail NODE_EXIT=0 WALL=250s on 270,101 B
[NAMING]   34/34 pass 0 fail NODE_EXIT=0 WALL=233s
cargo check --workspace --target wasm32-unknown-unknown
                       -> Finished dev profile 2m19s, warnings=0
node --check (5 files) -> 5/5 OK
git diff --check        -> EXIT 0; NEW_SUPPRESSION_MARKERS=0
recompute counters 40000 calls -> {"gas":2,"yocto":2}
DEPLOY_OK 12776ms
```

Rejected rungs (NOT applied): `[COMBINED gufa]` 23 pass/11 fail NODE_EXIT=1,
`[F08]` 9/7 NODE_EXIT=1, `[F08R2]` 8/0 NODE_EXIT=1. wasm-opt `-all` UPHELD
with fresh nearcore `features.rs` whitelist. Every strictly-smaller candidate
fails whitelist/oracle/gating. 6 prototypes / 87 rungs.

Deploy-safe wasm: 301,496 → **270,101 B** (−10.4%), 106,060 instr, 43 contract
exports / 38 imports (only `__data_end` / `__heap_base` linker symbols absent),
panic strings preserved, byte-identical to applied optimizer output.

## Recordable demo outline (human records, human posts)

1. Mint a pool share against real NEP-141 reserve balances.
2. Trigger a taxed transfer / rebase, show the share price move and the
   dividend leg. One moment, visible result.
Q-012 video required when judges cannot open the demo. Tags @NEARProtocol,
#NEARHackathon. Main writes no post.

## Payload fields — ALL EMPTY, human supplies every value

| Field | Rule | Value |
|---|---|---|
| requestId | UUID, generated ONCE, reused on 400/503 | EMPTY |
| projectName | 2-80 chars | EMPTY |
| leadName | 2-80 chars | EMPTY |
| email | valid, <=160, max 2 submissions per address (Q-015) | EMPTY |
| size | `1` / `2 - 4` / `4 - 6` / `6 - 8` / `8+` | EMPTY |
| tracks | >=1 track id, each once; `memecoins` fits | EMPTY |
| nearAddress | 2-64 lowercase mainnet account the team creates | EMPTY |
| projectUrl | http(s), <=300, public repo, unique | EMPTY |
| demoUrl | http(s), <=300, published X post | EMPTY |
| idea | 20-2000 chars | EMPTY |
| consent | `true` only after verbatim notice + human yes | EMPTY |

Never add `website`. Print full JSON, wait for explicit yes. 201 saved;
400 fix `fields` + same requestId; 403 stop; 409 stop; 413 shorten; 503 retry
same requestId.

## Rules checklist

- Q-003: 7 pre-existing tags, none of the required pair; no README diff link.
  **Not satisfied**; local tags deliberately not created.
- Q-012 video required when judges cannot open the demo.
- Q-014 `LICENSE` present. Q-017 README "Quickstart" at line 31,
  "Executable spec" line 54, "Reproduce the numbers" line 67.
- Q-015 second project on same email must be named in README. Unresolved.
- Q-002/Q-005 origin disclosure: README "Origin and licence" line 148.

## Blockers (do not block submission)

Celesto `Trial credit is too low to start this sandbox` → clippy/fmt/
cargo-near-check BLOCKED-BY-CELESTO. Firecrawl credits BLOCKED. Exa MCP 402 →
direct REST. HELD: duplicate semver majors (`cargo update` exact failure).
BoxLite §6 **NOT RUN** for this worker; Main's `dRZq8KTjX2IJ` and W3Subrosa's
`uScD0lurFrem` MEASURED results cited, exact pending command in
`WAVE-3-krater.md` §16. No fabrication.

## Attestation

Nothing published, pushed, tagged, or submitted. No payload value invented.
