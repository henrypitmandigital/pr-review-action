# pr-review

Shared PR-Agent review for a set of repositories. A collaborator comments
`/review` on a pull request and PR-Agent posts a review through OpenRouter,
using the repository's owner-accepted baseline reviewer or a cheaper reviewer
that has qualified on that repository's own labelled cases.

Each repository keeps three short workflows and one config directory; every
control lives here, versioned, so all repositories get the same behaviour.

## What it does

| Action | Trigger in the calling repo | Secrets | Purpose |
|---|---|---|---|
| `review` | `issue_comment` (`created`) | `OPENROUTER_API_KEY` | Authorise the commenter, choose the reviewer, run PR-Agent once. |
| `renew` | daily `schedule` + `workflow_dispatch` | `OPENROUTER_API_KEY`, `TYPESAFE_API_KEY` | Every 14 days, research and evaluate a cheaper qualified reviewer. |
| `checks` | `pull_request` on config changes | none | Validate config, fixtures and `.pr_agent.toml`; free catalog price plan. |
| `calibrate` (optional) | `workflow_dispatch` | both, for `calibrate` mode | `plan`: free list of current candidates and prices. `calibrate`: evaluate the price reference and two production families on the suite within an explicit budget (at most $10). Records evidence in `calibration.json`; never changes the reviewer. |

Controls carried by every repository:

- **Commenter authorisation before any checkout.** Only `/review`, alone or
  followed by exactly the Claude Code attribution footer, from a human with
  write, maintain or admin permission. The permission lookup is bound to the
  comment author's account id (survives login renames) and fails closed. A
  re-run never buys another review.
- **Trusted code only.** The review reads the repository's config from the
  default-branch event commit, never PR code. PR-Agent reads the PR through
  the GitHub API and never executes it.
- **PR-Agent hardening.** No fallback models, retries, model routing, global
  or per-directory settings, auto-approval or automatic tools; inference
  failure fails the job; run details are shown in the review.
- **Cost ceilings.** Every call is priced from a fresh OpenRouter catalog and
  must sit under the repository ceiling, the reviewer's own ceiling and the
  price of the reference model. A repository variable can lower the ceiling,
  never raise it.
- **Reviewer renewal.** An atomic, non-fast-forward claim on an orphan data
  branch (`pr-review-policy`, holding only review records) prevents duplicate
  spend. A challenger replaces the baseline only after passing every case in
  the repository's adjudicated suite; until the suite is marked ready the
  baseline keeps reviewing.

## Onboarding a repository

1. **Allow access (only if you host these actions in a private repository).**
   In the repository holding these actions: Settings → Actions → General →
   Access → "Accessible from repositories owned by the user". Private callers
   cannot use private actions until this is set; public actions need nothing.
2. **Secrets.** Add `OPENROUTER_API_KEY` (and `TYPESAFE_API_KEY` for renewal)
   as repository secrets, or environment secrets if the job uses an
   environment.
3. **Config.** Copy [`examples/config.json`](examples/config.json) to
   `.github/pr-review/config.json` and set `repository`. Fields:

   | Field | Default | Meaning |
   |---|---|---|
   | `repository` | required | `owner/name`; binds fixtures and readiness to this repo. |
   | `max_call_usd` | `0.2` | Repository per-call ceiling. |
   | `state_branch` | `pr-review-policy` | Reviewer data branch. |
   | `baseline.model`, `baseline.created` | required | Owner-accepted OpenRouter model and its exact catalog version. |
   | `baseline.input_tokens` | `32000` | Input budget for the baseline. |
   | `baseline.max_call_usd` | `0.05` | Owner-approved ceiling for this exact baseline. |
   | `baseline.estimated_call_usd` | ceiling | Last known call price; describes a retired baseline during research. |
   | `baseline.reasoning` | `"off"` | `"off"` or `"default"` (use the challenger reasoning budget). |
   | `challenger.max_call_usd` | `0.010112` | Ceiling for automatically researched replacements. |
   | `challenger.input_tokens` / `output_tokens` / `reasoning_tokens` | `32000` / `8192` / `2048` | Evaluated profile; output tokens apply to every review. |

4. **Fixtures (optional until you want renewal to qualify challengers).**
   `.github/pr-review/fixtures/cases.json`, `historical-pool.json` and
   `qualification.json` (`{"schema":1,"repository":"owner/name","ready":true}`
   once the owner has adjudicated them). Without them the baseline reviews and
   renewal records research only.
5. **Optional controls.**
   - `review` and `renew` take `authorize-only: 'true'` for a secret-free job
     that checks the requester before an approval-gated `environment` job; that
     job calls the action again in full, so the requester is re-checked after
     approval.
   - `renew` also accepts `/review-policy` and `/review-policy-resume <run id>`
     PR comments (exact text, write permission). Resuming continues a cycle
     whose trusted run failed before inference and never replays a paid call
     (`actions: read` needed). Dispatch input `resume-run-id` does the same.
   - `renew` takes `package-manager: pnpm` where npm must not be used (pnpm
     must already be on PATH).
6. **Workflows.** Copy the three files in [`examples/`](examples/) into
   `.github/workflows/` and replace `OWNER` with the account hosting these
   actions. Adjust `runs-on`, `environment` or timeouts as the
   repository's own rules require; the actions do not depend on them.
7. **`.pr_agent.toml` (optional).** Native PR-Agent settings; the `checks`
   action rejects unknown keys and values that disagree with the config.

## Versioning

Callers pin `@v1` (or a full commit SHA). Changes land on `main` through pull
requests with green CI; `v1` moves only to a reviewed `main` commit, and a
breaking change gets `v2`. Changing reviewer code, the evaluated profile or a
repository's fixtures changes the stored fingerprints, so an existing
qualified policy is ignored and the baseline reviews until the next renewal.

## Development

```sh
npm ci --ignore-scripts
npm test          # node --test against test/example + observer checks
npx biome check .
```
