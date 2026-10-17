# Onboarding batch 1 — browser ledger (17 Oct 2026)

Production build of `0ba770ee7b568b25a27db79ae694760425adca88` (BUILD_ID `wJJLvN0cBcbq_JUYo-hMI`), `next start` behind a local TLS proxy, Neon **test** branch, isolated (no blob store, payment and mail keys invalid, EMAIL_DELIVERY=off). Two synthetic clubs, removed afterwards. Failures marked "injected in the browser" were simulated with Playwright request interception; "lost" rows let the request reach the server and replaced the answer. One uninterrupted run, 2026-10-16T23:43:07.269Z to 2026-10-16T23:47:05.780Z.

Totals: 8 NOTE, 47 PASS.

## empty — Empty club, first setup, desktop 1440×900, device zone Asia/Makassar

| Result | Check | Observed |
|---|---|---|
| NOTE | before | {"name":"<stamp> Empty Club","timezone":"Europe/London","logoSize":"md","logo":"<32-hex>","noLogo":true,"primaryColor":"#3b82f6","secondaryColor":"#2563eb","fontFamily":"'Inter', sans-serif","onboardingCompleted":false,"stripeConnected":false,"contactEmail":null,"onboardingAnswers":null,"classes":[],"ranks":[],"members":0,"tiers":0,"importJobs":0,"uploads":0,"schedules":0} |
| PASS | E1 first sign-in lands in setup | /onboarding |
| PASS | E2 device zone disclosed before it is saved | We'll set your club's time zone to Asia/Makassar, from this device. Change it any time in Settings → Waiver. |
| PASS | E3 failed step-1 save (500 injected in the browser; server not reached): message shown | ["We couldn't confirm that saved. Check your connection and try again.","We couldn't confirm that saved. Check your connection and try again."] |
| PASS | E4 failed step-1 save: still on step 1 with the typed name kept | {"heading":"Set up your gym","value":"<stamp> Renamed Gym"} |
| PASS | E33 failed save also shown beside the Continue button until dismissed or retried | {"notes":2,"dismissButtons":1} |
| PASS | E5 failed step-1 save: nothing written (by construction: the request never reached the server) | {"name":"<stamp> Empty Club","tz":"Europe/London"} |
| PASS | E6 retry sends name + device zone once | [{"name":"<stamp> Renamed Gym","timezone":"Asia/Makassar"}] |
| PASS | E7 saved values in the database | {"name":"<stamp> Renamed Gym","tz":"Asia/Makassar"} |
| PASS | E8 reload keeps the step (this tab) | 2 |
| PASS | E9 after reload the saved name is shown and the zone note says it stays | {"value":"<stamp> Renamed Gym","note":"Your club's time zone stays Asia/Makassar. Change it any time in Settings → Waiver."} |
| PASS | E10 unchanged step 1 sends nothing | [] |
| PASS | E11 double click on Continue moves one step | {"heading":"Set up your ranks","step":"3"} |
| PASS | E12 double click on Add: 5 BJJ ranks, each once, one step | {"ranks":["BJJ#0","BJJ#1","BJJ#2","BJJ#3","BJJ#4"],"posts":5,"step":"4"} |
| PASS | E13 Back then Add again: still 5 ranks; the server answered 409 to all five | {"ranks":["BJJ#0","BJJ#1","BJJ#2","BJJ#3","BJJ#4"],"statuses":[409,409,409,409,409]} |
| PASS | E14 removing a saved belt system is reported, not silently ignored | ["Belt systems and ranks you'd already saved stay as first saved, including any you removed or changed here. Change or delete them on the Ranks page."] |
| PASS | E15 partial success: one class saved, failure shown, step kept | {"classes":["Fundamentals"],"alerts":["“No-Gi” didn't save. Check your connection (or sign in again if you've been signed out), then press Save again — classes already saved won't be added twice.","Belt systems and ranks you'd already saved stay as first saved, including any you removed or changed here. Change or delete them on the Ranks page.","“No-Gi” didn't save. Check your connection (or sign  |
| PASS | E16 retry creates only the missing class | {"classes":["Fundamentals","No-Gi"],"posts":3,"schedules":2} |
| PASS | E17 Back then a double click on Save: no duplicate classes | {"classes":["Fundamentals","No-Gi"],"step":"5"} |
| PASS | E18 failed logo upload: message, step kept, nothing saved | {"alerts":["That logo didn't upload: Injected failure. Your current logo hasn't changed. Press Next to try again or choose a different file — or press Skip to move on without saving the rest of this page.","That logo didn't upload: Injected failure. Your current logo hasn't changed. Press Next to try again or choose a different file — or press Skip to move on without saving the rest of this page." |
| PASS | E19 retry: logo stored once and size saved | {"uploadsSent":1,"auditUploads":1,"logoSize":"lg"} |
| PASS | E20 Back then Next: no second upload, no settings write | {"uploads":0,"patches":0} |
| NOTE | E21 re-entry after reload: class drafts on step 4 | {"drafts":0} |
| PASS | E22 DOCUMENTED LIMIT: after a reload, re-adding the same class creates a second one (no cross-reload idempotency for classes) | ["Fundamentals","No-Gi","Fundamentals"] |
| PASS | E23 after a reload, re-adding the BJJ system creates nothing; the server answered 409 to all five | {"ranks":["BJJ#0","BJJ#1","BJJ#2","BJJ#3","BJJ#4"],"statuses":[409,409,409,409,409]} |
| PASS | E24 step 6 network failure: message, step kept | ["We couldn't confirm that saved. Check your connection and try again.","We couldn't confirm that saved. Check your connection and try again."] |
| NOTE | E25 step 8 skipped automatically (authenticator already enrolled) | {"step":"9"} |
| PASS | E26 failed hand-off (no blob store, our 503) says the file was not sent and points to another option; Finish stays locked; Upload stays available | {"alert":"Your file wasn't sent: uploads aren't available right now. Choose another option above.","finishDisabled":true,"uploadEnabled":true} |
| NOTE | E27 (references are checked in csvref/E27b: Playwright cannot read multipart bodies with files) sends + jobs | {"sends":2,"sameRef":true,"refShape":false,"importJobs":0} |
| PASS | E28 failed completion (500 injected in the browser; server not reached): message, no ready screen, not recorded | {"alerts":["We couldn't finish setup. Nothing is lost — try again.","We couldn't finish setup. Nothing is lost — try again."],"heading":"Bring your members across","recorded":false} |
| PASS | E29 completion shown only once recorded | true |
| PASS | E30 banner offers both links with Settings targets | {"stripe":"/dashboard/settings?tab=revenue","members":"/dashboard/settings?tab=import"} |
| PASS | E31 Connect Stripe opens Settings → Revenue, never /onboarding | /dashboard/settings?tab=revenue |
| PASS | E32 Add your first members opens Settings → Import, never /onboarding | /dashboard/settings?tab=import |
| NOTE | after | {"name":"<stamp> Renamed Gym","timezone":"Asia/Makassar","logoSize":"lg","logo":"<32-hex>","noLogo":false,"primaryColor":"#3b82f6","secondaryColor":"#2563eb","fontFamily":"'Inter', sans-serif","onboardingCompleted":true,"stripeConnected":false,"contactEmail":null,"onboardingAnswers":{"size":"21–50","goals":[],"referral":"","referralOther":null},"classes":["Fundamentals","No-Gi","Fundamentals"],"ra |

## csvref — Empty club, step 9, hand-off reference captured in the page

| Result | Check | Observed |
|---|---|---|
| PASS | E27b retry of the same file carries the same reference; a different file gets a new one; nothing stored | {"sends":3,"sameOnRetry":true,"newForNewFile":true,"shapes":[true,true,true],"files":["first.csv","first.csv","second.csv"],"importJobs":0} |

## lost — Empty club, responses lost after the server applied the write

| Result | Check | Observed |
|---|---|---|
| PASS | L1 settings lost response: server applied it, owner told it could not be confirmed (not 'nothing changed'), retry is harmless | {"applied":"<stamp> Lost Response Gym","afterRetry":"<stamp> Lost Response Gym"} |
| PASS | L2 class lost response: the server created the class, the browser was told 500; the retry finds and adopts it — still one class | {"savedBeforeRetry":1,"afterRetry":1,"message":"“Lost Response Class” didn't save. Check your connection (or sign in again if you've been signed out), then press Save again — classes already saved won't be added twice.","classesBefore":3} |

## configured — Configured club (America/New_York, logo lg, answers, 3 members, 1 plan, 1 class, 1 rank), reopened setup, keyboard

| Result | Check | Observed |
|---|---|---|
| NOTE | before | {"name":"<stamp> Configured Club","timezone":"America/New_York","logoSize":"lg","logo":"<32-hex>","noLogo":false,"primaryColor":"#7c3aed","secondaryColor":"#2563eb","fontFamily":"'Inter', sans-serif","onboardingCompleted":true,"stripeConnected":false,"contactEmail":null,"onboardingAnswers":{"size":"21–50","goals":["Grow membership","Track attendance"],"referral":"friend","referralOther":null},"cla |
| PASS | C1 a set-up club signs in to the dashboard, not setup | /dashboard |
| PASS | C2 reopened setup shows the saved name and says the zone stays | {"name":"<stamp> Configured Club","note":"Your club's time zone stays America/New York. Change it any time in Settings → Waiver."} |
| PASS | C3 keyboard: Tab reaches Continue, Enter advances; unchanged step 1 sends nothing | {"reached":{"tabs":2,"tag":"BUTTON","label":null,"text":"Continue →"},"focusStyle":{"outline":"solid 3px","boxShadow":"rgba(124, 58, 237, 0.3) 0px 8px 24px 0px"}} |
| PASS | C4 keyboard: a discipline can be chosen with Space and the step advanced with Enter | {"picked":true,"adv":true} |
| PASS | C5 keyboard: Back is reachable and works | {"back":true} |
| PASS | C6 branding step passed untouched sends nothing | [] |
| PASS | C6b questionnaire prefilled from saved answers (21–50 shown selected); Next unchanged sends nothing | {"selected":"rgba(124, 58, 237, 0.12)","unselected":"rgba(255, 255, 255, 0.04)","patches":0} |
| PASS | C7 reopening setup (steps 1-6) changed nothing: name, zone, logo, logo size, colours, questionnaire answers, data | {"timezone":"America/New_York","logoSize":"lg","name":"<stamp> Configured Club"} |
| NOTE | writes | ["POST /api/auth/callback/credentials ","POST /api/auth/totp/verify code"] |

## mobile — Configured club, 390×844 touch

| Result | Check | Observed |
|---|---|---|
| PASS | M1 390 px: every step reachable by tap, primary buttons inside the viewport, no page overflow | [{"step":"1","overflow":false,"offRight":[]},{"step":"2","overflow":false,"offRight":[]},{"step":"3","overflow":false,"offRight":[]},{"step":"4","overflow":false,"offRight":[]},{"step":"5","overflow":false,"offRight":[]},{"step":"6","overflow":false,"offRight":[]}] |
| NOTE | M2 tap targets under 44 px (batch 3 item 22) | [{"step":"1","small":[]},{"step":"2","small":["Back 32x44"]},{"step":"3","small":["Back 32x44"]},{"step":"4","small":["Back 32x44"]},{"step":"5","small":["Back 32x44"]},{"step":"6","small":["Back 32x44"]}] |
| PASS | M3 mobile walk wrote nothing | ["POST /api/auth/callback/credentials","POST /api/auth/totp/verify"] |

## step9 — Configured club, step 9 hand-off failure: 390 px touch and keyboard

| Result | Check | Observed |
|---|---|---|
| PASS | S1 390 px: CSV failure shown in view as an alert, Upload still tappable, Finish locked, no overflow | {"alertInViewport":true,"uploadEnabled":true,"finishDisabled":true,"overflow":false,"alertRole":1,"retryStillShowsAlert":true} |
| PASS | S1b 390 px: no response -> 'couldn't confirm… press Upload CSV again' in view, Upload still tappable, Finish locked | {"inViewport":true} |
| PASS | S2 keyboard: the hand-off card selects with Enter, Upload CSV is reachable by Tab and Enter, the failure is announced | {"selected":true,"pressed":true,"shown":true} |
| PASS | S3 step 9 checks wrote nothing (no job, settings unchanged) | {"importJobs":0} |

## The eight NOTE rows

NOTE rows record state, not pass/fail: the empty club's before and after snapshots and the configured club's before snapshot and write list (4), E21 (class drafts are gone after a reload — the documented re-entry limit), E25 (step 8 passes itself when an authenticator is already enrolled), E27 (Playwright cannot read multipart bodies that carry files, so references are proven by csvref/E27b instead), and M2 (tap targets under 44 px: the header Back button is 32×44 on steps 2–6; batch 3).
