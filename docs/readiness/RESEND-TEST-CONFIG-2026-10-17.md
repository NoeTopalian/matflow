# Resend — configuration checklist for the isolated real-email test (17 Oct 2026)

Branch `feat/email-test-isolation`. Production is unchanged. Secrets are reported by presence and scope only. "Verified" means checked on 17 Oct 2026 as stated; "Blocked" names who can unblock it. The test is **not complete** until all five success conditions at the end hold.

## What Resend's official documentation says (read 17 Oct 2026, ~19:10 UK)
| Topic | Documented | Source |
|---|---|---|
| Test sender | The `resend.dev` domain "is only available for testing purposes and can only send emails to the email address associated with your Resend account"; anything else returns 403 "You can only send testing emails to your own email address". | *403 Error Using resend.dev Domain* (knowledge base) |
| Possible conflict | The *Domains* page says "You must add and verify at least one domain to send emails with Resend." If the test team refuses the `resend.dev` sender, this test is **blocked** (a domain needs DNS changes, which are not authorised). | *Verified Domains* |
| Permitted recipient | Therefore exactly one: the address you sign in to Resend with. | as above |
| Test addresses | `delivered@`, `bounced@`, `complained@`, `suppressed@resend.dev` (with `+label`); they "count against your account's sending quota". **Not used in this test.** | *Send Test Emails*, *What email addresses to use for testing?* |
| Teams | "Resend allows multiple teams to be managed under a single email address. Each team is distinct, with its own API keys, billing, and usage." Switch teams from the team name at the top left. The page I read does not describe the create-team control, so the step below does not name one. | *Managing Teams* |
| API key permissions | Created "with a name, permission, and optional domain restriction". A Sending-access key calling any other endpoint gets `401 restricted_api_key` "This API key is restricted to only send emails"; `Full access` is needed for anything else. "You cannot view or edit an API key value after it has been created." | *Manage API keys*, *Errors* |
| Webhook events | `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`, `email.suppressed` (also `opened`, `clicked`, `received`, `scheduled`, which this app ignores). | *Event Types* |
| Signature verification | Signing secret on the webhook details page; verify with the raw request body ("Some frameworks parse the request as JSON and then stringify it, and this will also break the signature verification"); headers `svix-id`, `svix-timestamp`, `svix-signature`. | *Verify Webhooks Requests* |
| Retries | Immediately, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h. An endpoint that keeps failing is disabled automatically and the team is emailed. Messages can be replayed from the dashboard. | *Retries and Replays* |
| **Not documented** | Whether a retry reuses the same `svix-id`, and the timestamp tolerance (5 minutes is the `svix` library's own default). The handler does not depend on either: it is idempotent on the stored status, and the tolerance is enforced by the library. | — |

## Facts from this codebase
- The only call into Resend is `sendEmail` in `lib/email.ts` (one `to`, no cc/bcc, To/Cc/Bcc extra headers dropped). Pinned by `tests/unit/email-test-allowlist.test.ts` and `tests/unit/sec-d-mail-holds.test.ts`.
- Sending policy: unset and unrecognised `EMAIL_DELIVERY` are OFF everywhere. `test` sends only to `EMAIL_TEST_RECIPIENTS` everywhere. `on` is open only on the Vercel production deployment. Pinned by `tests/unit/email-sending-policy-table.test.ts`.
- The password-reset email carries a **6-digit code that expires in 2 minutes**, not a link. It is entered on the app's own reset screen, so the test opens that screen on the **isolated** app first.
- Webhook route: it requires a full `whsec_` secret (svix itself accepts weak ones) and refuses a declared `Content-Length` over 256 KB before reading. A streamed body is bounded by Vercel's request limit in production and, in this test, cut at 256 KB by the gate while it is read. A recent unknown email id gets 409 (retry); `email.suppressed` is stored as `bounced`.
- **Unresolved:** the test-branch `EmailLog` holds **440 rows `sent` in the 30 days to 17 Oct**, so earlier local runs reached a real Resend account through a key whose account is unknown. That key, found in local `.env` files, **must not be used**. The preflight compares the test key's fingerprint against every `RESEND_API_KEY` in the main checkout's and the worktree's `.env` files and refuses a match.

## Production configuration — observed vs unknown
- **Observed (17 Oct 15:50 UTC):** public `GET /api/tenant/totalbjj` and `/ironpathbjj` returned `emailDelivery: "off"`.
- **Observed (17 Oct, `vercel env ls`):** the variable names `EMAIL_DELIVERY`, `RESEND_API_KEY` (Production only) and `RESEND_FROM` (Production + Preview) exist. `EMAIL_TEST_RECIPIENTS`, `RESEND_WEBHOOK_SECRET` and `CRON_SECRET` exist in no environment.
- **Unknown:** the value of `EMAIL_DELIVERY` (Vercel hides it), and which Resend account the production key belongs to. "Email off" is how the deployed code behaved at that moment. It does not prove what the variable holds.
- **Inference, not observation:** under the deployed code (`e954482`), `"off"` is reported for any value other than unset, empty or `on`. Under this branch's code, every value other than exactly `on` (or `test`, which needs a list) sends nothing. `EMAIL_TEST_RECIPIENTS` does not exist in production, so `test` would also send nothing. This holds only if the hidden value is not `on`; to know, read the value in Vercel.

## Isolation for the first real test
| Layer | Isolated by | Checked by |
|---|---|---|
| Resend | A **separate team** (its own API keys, billing and usage); the webhook is registered in that team only | Noe creates the key and webhook there. The preflight confirms the key is Sending-access and differs from every local key. The test team's dashboard shows the one email afterwards |
| Credentials | Private file `%LOCALAPPDATA%\matflow-verify\email-test-isolation\email-test.env`, outside every git checkout; accepted keys only; values never printed | `extraEnv()` in `.claude/skills/matflow-verify-local/scripts/env.mjs` (refuses files inside git, unknown keys, malformed lines) |
| App | Local production build of this branch (`server.mjs`), `VERCEL_ENV` removed, `EMAIL_DELIVERY=test` | `server.mjs start` prints the build commit |
| Database | Neon **test** branch (`ep-hidden-salad`); production refused by host guard | `assertTestUrl` in `env.mjs` |
| Club | Synthetic `mfv-…` club from `fixture.mjs`; member 2 temporarily holds Noe's address | `email-real-test.mjs teardown` removes the club and reports any row still holding the address (must be 0) |
| Inbound | `webhook-gate.mjs` on 127.0.0.1:3995 forwards **only** `POST /api/webhooks/resend`, bounded at 256 KB while reading, Svix headers only; the tunnel points at the gate, never the app | `tests/unit/webhook-gate.test.ts` (runs the real script) |
| Recipients | `EMAIL_TEST_RECIPIENTS` = exactly one address (Noe's); the preflight refuses more than one, `resend.dev`, Sean/Total BJJ, placeholders | `email-real-test.mjs preflight`; `blocked` proves an unlisted address is refused before Resend with the real key loaded |
| Provider requests | `resend-relay.mjs` on 127.0.0.1:4598 between the app and Resend. It counts every request, forwards only `POST /emails` to the one listed address with no cc or bcc, and forwards at most one | `tests/unit/resend-relay.test.ts`; `blocked` (0 requests) and `verify` (exactly 1) read its counter |
| Duplicate sends | See "Duplicate sends — what is and is not protected" below. For this test, the relay's one-send limit is the guard | `tests/unit/email-test-allowlist.test.ts`, `tests/unit/resend-relay.test.ts` |

## Duplicate sends — what is and is not protected (checked 19 Oct)
- **Idempotency key:** `sendEmail` sends the EmailLog row id as Resend's `Idempotency-Key`. Resend's docs say a request repeating the same key within 24 hours returns the first response and is not sent again. That deduplicates **only a repeat of the same key**.
- **Application repeats are not deduplicated:** every `sendEmail` call creates a **new** EmailLog row (there is no parameter to reuse one), so it also gets a **new** key. A person clicking again, a browser resending, or a route called twice sends a **second email**.
- **No automatic retries:** nothing in MatFlow retries a send, and the Resend SDK (6.20.0) has no retry of its own. The key therefore protects only a retry that might be added later and reuses the row; today it never fires.
- **Repeats guarded elsewhere:** "Add member" returns the member already created when its request id repeats, and Stripe webhooks are claimed by event id, so a redelivery is skipped.
- **Lost response — still a risk:** if Resend accepts a send but the reply never reaches MatFlow, the row is recorded `failed` with no provider id. That email's webhook events then get 409 for 15 minutes and are ignored after that. A person asking again gets a second email.
- **This test:** the relay forwards at most one email, so a second attempt is refused at the relay and never reaches Resend.

## Verification record (kept separate from the isolated-test result)
- **Full suite, head `5693431b`, 19 Oct: NOT GREEN.** 1 failed, 7005 passed, 617 skipped. The failure is `tests/unit/member-hold.test.ts` › "pauses Stripe (void, resumes_at) FIRST…", which got 400 where it expected 200. It is **reproduced on the base `e954482f`** (1 failed / 17 passed in that file) in a throwaway worktree, and neither the test nor the hold code differs between base and branch. Cause: the test hard-codes a hold ending `2026-10-20` and runs on the real clock. Recorded as a separate production-readiness item; not fixed on this branch.
- **Isolated test:** SIMULATED dry run on `5693431b`, with a local stand-in in place of Resend, passed B0–B2, V1–V5, code reuse refused and expired code refused. Teardown left 0 rows. **REAL provider result: not yet run.**

## Steps (one at a time; never paste a key, secret or address into chat)
1. **Test team and sender.** In Resend, create a separate team for testing (free; do not upgrade). Check that its Domains page has no domain: the sender is then Resend's testing sender, and the only possible recipient is the address you sign in with. Read the team's sending limits on its Usage page.
2. **API key.** Check that the team name at the top left reads **MatFlow Testing**. Then go to API keys and create a key named `matflow-local-test` with **Sending access** and no domain restriction. Copy it once; Resend will not show it again. Check that this team's API keys list shows `matflow-local-test` as never used.
   - **Pre-send ownership check.** Resend's API-keys page shows "the last time you used an API key". After the preflight's read-only call with the key (no email), refresh that page in MatFlow Testing. If `matflow-local-test` now shows as used, the key belongs to this team. Resend does not document whether a refused (restricted) call counts as use; if the page doesn't change, ownership rests on the post-send proof (V2 and the team's Emails page).
3. **Private file.** In Notepad, create `%LOCALAPPDATA%\matflow-verify\email-test-isolation\email-test.env`:
   ```
   EMAIL_DELIVERY=test
   EMAIL_TEST_RECIPIENTS=<the address you sign in to Resend with>
   RESEND_API_KEY=<the key from step 2>
   RESEND_FROM=MatFlow Test <onboarding@resend.dev>
   RESEND_BASE_URL=http://127.0.0.1:4598
   ```
   The last line routes every provider request through the local counting relay (`resend-relay.mjs`). It forwards only `POST /emails`, only to the one listed address with no cc or bcc, and only once.
   (The webhook secret line is added in step 6.) Say "file ready". I run `email-real-test.mjs preflight --before-webhook` and report each check by label.
4. **Local app, relay and gate.** I start the relay (upstream `https://api.resend.com`), create the synthetic club, start this branch's build on the test branch with your file, and start the gate. I then run `blocked`, which has three parts:
   - **B0, control.** The relay starts **disarmed**. A request for your listed address must reach it (+1 on the counter) and be refused there, so nothing reaches Resend and no email is sent. This proves the server runs in test mode, with the key, through the relay.
   - **B1 and B2.** An unlisted address must then make **zero** provider requests, and must not retire or mint any code.
   - **Arming.** Only if all of that passes is the relay armed. From then on it forwards exactly one email, and its instance id ties every counter to this run.
5. **Tunnel.** Approve installing `cloudflared` (`winget install Cloudflare.cloudflared`). Then run `cloudflared tunnel --url http://127.0.0.1:3995` and keep the window open. **Use port 3995 (the gate), never 3991 (the app).**
6. **Webhook.** With the team name reading **MatFlow Testing**, add a webhook with the URL `https://<the trycloudflare address>/api/webhooks/resend` and the seven `email.*` events above. Copy its signing secret into the file's last line, then say "secret added". Before that, confirm on MatFlow Testing's Webhooks page that the endpoint is listed there, with the seven events. I restart the app with the secret and rerun the preflight in full. The secret proves the team after the send: an event signed by any other team fails verification (401), so a `delivered` row (V2) can only come from MatFlow Testing's webhook.
7. **Your authorisation and the one email.** I show the masked recipient and the final preflight. You confirm the address and say "send". You then open `https://localhost:3993/login?club=<slug>` (the local certificate is self-signed; your browser will warn), choose "Forgot password", enter your address **once** and enter the code within 2 minutes with a new password.
8. **Verify and clean up.** I run `verify`, then:
   - you stop `cloudflared` and disable the test webhook in Resend;
   - I stop the app and the gate, and run `teardown`;
   - you delete the private file, or keep it for another run; that is your call.

**Success** requires all five:
- the email arrives;
- its code resets the password on the isolated app (`V3`);
- a genuine signed Resend event moves that one EmailLog row to `delivered` (`V2`);
- no address other than yours reaches Resend (`B1`, `V1`, `V5`);
- cleanup leaves the tunnel and gate stopped, the webhook disabled, and no row holding your address.

## Kept unresolved: production test mode
Production is never put into `test` mode by this work.
- **M-1 is closed (19 Oct).** forgot-password, magic-link request, bulk invite, kiosk waiver and owner approval now ask `canEmail(to)` before retiring or minting anything. A blocked address keeps the code or link it already holds and gets nothing new.

Before production is ever put into test mode, two gaps from the 17 Oct review must still be closed:
- **L-4:** the login page still offers email to everyone.
- **L-6:** with a list but no key, the production boot check refuses to start.

Production activation needs your commercial go-ahead and explicit approval.
