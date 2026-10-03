# 05 — Hosted photo-ID APIs (topic 05)

Pages saved (all fetched 2026-10-02, in `05-hosted-apis/`): `inat-swagger.json` (api.inaturalist.org/v1/swagger.json), `inat-org-repos.json`, `inat-inatVisionAPI-readme.md`, `inat-model-files-readme.md`, `inatapi-inaturalist_api.js`, `inatapi-computervision-controller.js`, `inatapi-rapidapi-controller.js`, `inatapi-util.js`, `inatapi-taxa-controller.js`, `rn-computerVision.ts`, `rn-useOnlineSuggestions.ts`, `inaturalistjs-computervision.js`, `inaturalistjs-taxa.js`, `rails-routes.rb`, `rails-taxa-controller.rb`, `pyinat-cv.py` (404 — pyinaturalist has no CV module), `forum-search-scoreimage.json`, `forum-t32587.json`, `forum-t41309.json`, `forum-t41775.json`, `forum-search-rapidapi.json`, `rapidapi-visionapi.html`, `wayback-visionapi.json`, `kindwise-insect-id.html/.md`, `kindwise-pricing.html/.md`, `kindwise-docs.html`, `kindwise-postman.json`, `ma-user-agreement.html/.md`, `ma-home.html/.md`, `ma-schema.json` (404), `ma-api-ping.json`, `ma-api-obs-post-probe.json`, `mosq-org-repos.json`, `mosq-ai-readme.md`, `mosq-model-monitor-readme.md`, `culicidaelab-repos.json`, `culicidaelab-*-readme.md`, `pypi-ma.json` (404), cloned repos `mosquito_alert_mobile_app/`, `mosquito_alert/`, `mosquito-alert-python-sdk/`, `mosquito-alert-dart-sdk/`, plus probe artifacts `probe-*.json`, `test-image.jpg`.

**TL;DR.** Two live hosted photo→mosquito-estimate surfaces exist and are reachable today: **Mosquito Alert's app API** (purpose-built mosquito taxa, free, JWT guest auth, returns a single AI/expert result on your own report — terms do not sanction third-party API clients) and **iNaturalist's app CV endpoint** (exists, powers the apps, but explicitly not publicly available — fee-based access for a "small number of select individuals/organizations"). Kindwise is the only self-serve commercial insect-ID API but is dropped per decision. No other purpose-built hosted insect/mosquito-ID API found.

## 1. iNaturalist — what the apps actually call (claim 2)

### 1.1 The app call surfaces, mapped in source

Four distinct surfaces, all verifiable in iNat's public code:

| # | Surface | Endpoint | Auth | Evidence |
|---|---|---|---|---|
| a | Mobile app "suggestions" screen | `POST https://api.inaturalist.org/v1/computervision/score_image` (multipart `image`; optional `lat`/`lng`/`taxon_id`; app also sends `include_representative_photos=true`, `test_feature=ancestor_unrestricted`) | JWT required | [iNaturalistReactNative `src/api/computerVision.ts`](https://github.com/inaturalist/iNaturalistReactNative/blob/main/src/api/computerVision.ts), [`useSuggestions/useOnlineSuggestions.ts`](https://github.com/inaturalist/iNaturalistReactNative/blob/main/src/sharedHooks/useSuggestions/useOnlineSuggestions.ts) (calls with `optsWithAuth`); server route [iNaturalistAPI `lib/inaturalist_api.js` L239](https://github.com/inaturalist/iNaturalistAPI/blob/main/lib/inaturalist_api.js) |
| b | Web uploader suggestions | `GET/POST /v1/taxa/suggest` on api.inaturalist.org; `source=visual` (+`image_url`) delegates into the same CV code; non-visual sources (observations/checklist/misidentifications) need no image | visual: JWT; non-visual: open | [inaturalistjs `lib/endpoints/taxa.js` `suggest()` with `useAuth: true`](https://github.com/inaturalist/inaturalistjs/blob/main/lib/endpoints/taxa.js); [iNaturalistAPI `taxa_controller.js` `getVisualSuggestions` → `ComputervisionController.scoreImage/scoreImageURL`](https://github.com/inaturalist/iNaturalistAPI/blob/main/lib/controllers/v1/taxa_controller.js); routes at `inaturalist_api.js` L378–381 |
| c | Web-only CV demo page | `https://www.inaturalist.org/computer_vision_demo` | none (browser UI, not an API) | [Rails `config/routes.rb` L758](https://github.com/inaturalist/inaturalist/blob/main/config/routes.rb) `resource :computer_vision_demo`; user-facing description in [forum 41309 #2](https://forum.inaturalist.org/t/is-there-some-api-identification-request-without-creating-an-observation/41309) |
| d | Fee-based channel | `POST /v1/rapidapi/score_image`, reachable only through the RapidAPI gateway | `X-RapidAPI-Proxy-Secret` header | [rapidapi_controller.js](https://github.com/inaturalist/iNaturalistAPI/blob/main/lib/controllers/v1/rapidapi_controller.js) + `util.isRapidAPIRequest` ([util.js L526](https://github.com/inaturalist/iNaturalistAPI/blob/main/lib/util.js)); staff statement below |

Mobile vs web use the same current model ([staff, forum 32587 #7](https://forum.inaturalist.org/t/why-does-cv-give-different-suggestions-on-the-mobile-app-than-on-the-w/32587), linking the [CV model updates blog post](https://www.inaturalist.org/blog/63931-the-latest-computer-vision-model-updates)); suggestions are location-boosted ("Include suggestions not nearby" toggle changes results; [forum 32587 #10–#18](https://forum.inaturalist.org/t/why-does-cv-give-different-suggestions-on-the-mobile-app-than-on-the-w/32587)). CV looks at only the first photo (forum 32587 #6).

### 1.2 Auth mechanics

JWT bearer via OAuth: `https://www.inaturalist.org/users/api_token`, 24-h expiry, "Authentication required for all PUT and POST requests" — all documented in the [swagger info description](https://api.inaturalist.org/v1/swagger.json) (fetched 2026-10-02, saved as `inat-swagger.json`). Getting a JWT requires an iNat **account + a registered OAuth application** — i.e. the same credentials the app itself uses.

### 1.3 Live probes (2026-10-02, no credentials — permitted by no-signup constraint)

| Probe | Result |
|---|---|
| `POST /v1/computervision/score_image`, empty body | 400 (parameter check fires first) |
| `POST /v1/computervision/score_image` with a small JPEG, no auth | **401 `{"error":"Unauthorized"}`** |
| `GET /v1/computervision/score_image` | 404 (method-restricted) |
| `GET /v1/taxa/suggest?taxon_id=62984&lat=47.56&lng=7.59` (non-visual) | **200 with ranked results**, unauthenticated |
| `GET /v1/taxa/suggest?source=visual&image_url=<iNat photo URL>` | **401** |
| CORS on api.inaturalist.org | `Access-Control-Allow-Origin: *` |

Auth at code level: `if ( !req.userSession && !req.applicationSession ) throw util.httpError( 401, "Unauthorized" )` in `scoreImage`, `scoreImageURL`, `scoreObservation` ([computervision_controller.js](https://github.com/inaturalist/iNaturalistAPI/blob/main/lib/controllers/v1/computervision_controller.js)); `TaxaController.suggest` itself has no auth check — the 401 for `source=visual` comes from the CV delegate. `score_image` returns default 10, max 100 suggestions per call (`InaturalistAPI.setPerPage( req, { default: 10, max: 100 } )`).

### 1.4 Documented rate limits and use policy

From the swagger description (fetched 2026-10-02): throttle **max 100 req/min**, target **≤60 req/min**, keep **under 10,000 req/day**; "The API is intended to support application development, not data scraping. We will block any use of our API that violates our Terms or Privacy Policy without notice."

### 1.5 Is the full model public? (claim 2's second half)

VERIFIED. Straight from iNat's own repos (both fetched 2026-10-02):

> "iNaturalist makes a subset of its machine learning models publicly available while keeping full species classification models private due to intellectual property considerations and organizational policy related to all-rights-reserved photos... We provide 'small' models trained on approximately 500 taxa, including taxonomy files and a geographic model, which are suitable for on-device testing and other applications." — [inatVisionAPI README](https://github.com/inaturalist/inatVisionAPI) and [model-files README](https://github.com/inaturalist/model-files)

Corroborating: the endpoint is absent from the official swagger (checked `inat-swagger.json` — no `/computervision` path), and pyinaturalist (the main third-party Python client) does not wrap it at all (no computervision module; GitHub code search 2026-10-02).

### 1.6 Staff statements on third-party access

- "There is no public API for iNaturalist's vision model." — STAFF, [forum 41309 #5](https://forum.inaturalist.org/t/is-there-some-api-identification-request-without-creating-an-observation/41309), 2023-05-01.
- "The API that gives species suggestions based on visual similarity is not publicly available. We have allowed a small number of select individuals/organizations fee-based access for research or use in other citizen science apps. If your use meets these criteria, please send me an email (carrie at inaturalist.org) with more details." — STAFF, [forum 41775 #4](https://forum.inaturalist.org/t/hidden-computer-vision-api/41775), 2023-05-17.
- The RapidAPI listing URL (rapidapi.com/inaturalist-inaturalist-default/api/visionapi) now renders a bare "API Hub" shell with no API metadata (fetched 2026-10-02, `rapidapi-visionapi.html`) and has no wayback snapshots — the listing is not publicly browsable today; consistent with invitation-only access.

### 1.7 Verdict — hosted public mosquito-ID service on iNat CV

Not usable as-is. A third party cannot call `score_image` without an iNat account + OAuth app, staff have stated repeatedly it is not public, and the sanctioned route is a fee-based agreement with iNat (carrie@inaturalist.org). For a public-facing service, that means negotiation, unclear pricing, and policy risk (iNat's API is explicitly not for data scraping; the CV API additionally serves only iNat's own mission). The open parts of iNat (CC-licensed observation photos) are the sibling topics' territory (local models / geographic prior), not a hosted API.

**Claim 2 verdict: VERIFIED, with one sharpening.** "NOT exposed as a supported image-identification API" is correct (staff-stated, code-authenticated, absent from official docs). Sharpening: the endpoint `score_image` **does exist** and is exactly what the apps call — it is just auth-gated (JWT) and unsupported-for-third-parties rather than nonexistent, and only ~500-taxon small models are released while the full species model is private for IP/rights reasons.

## 2. Mosquito Alert — what the app calls

### 2.1 Architecture and the photo→result flow

The Flutter app talks to a Django REST API (org [github.com/Mosquito-Alert](https://github.com/Mosquito-Alert), 42 repos, active 2026-10-02). Default API host `https://api.mosquitoalert.com/v1` ([dart SDK `lib/src/api.dart` L33](https://github.com/Mosquito-Alert/mosquito-alert-dart-sdk/blob/main/lib/src/api.dart)); the legacy `webserver.mosquitoalert.com` also serves it. The app has **no on-device ML** — no tflite/onnx/tensorflow in `pubspec.yaml`, no model assets, no prediction code anywhere in `lib/` — so identification is **purely server-side**. Models run on HPC clusters, monitored by their [mosquito-alert-model-monitor](https://github.com/Mosquito-Alert/mosquito-alert-model-monitor) dashboard ("automated data wrangling tasks and models running on computational clusters").

Flow (all from the [OpenAPI spec shipped in the python SDK repo](https://github.com/Mosquito-Alert/mosquito-alert-python-sdk/blob/main/openapi.yml), `openapi.yml`):

1. `POST /auth/signup/guest/` `{"password": "..."}` → guest account + JWT (spec also has cookie/token auth schemes; endpoint security: `cookieAuth`/`tokenAuth`).
2. `POST /observations/` (multipart, photos attached) — the app sends photos + location + note ([mobile app `observation_repository.dart`](https://github.com/Mosquito-Alert/mosquito_alert_mobile_app/blob/main/lib/features/observations/data/observation_repository.dart)).
3. Server-side AI writes a `PhotoPrediction` per photo: `predicted_class` ∈ {`ae_albopictus`, `ae_aegypti`, `ae_japonicus`, `ae_koreicus`, **`culex`, `anopheles`, `culiseta`**, `other_species`, `not_sure`}, `classifier_version` ∈ {v2023.1, v2024.1, v2025.1}, plus `bbox`, `insect_confidence`, `scores`, `threshold_deviation`, `is_decisive` — a purpose-built mosquito classifier whose class list covers exactly the European taxa of interest, refreshed yearly.
4. The reporter reads back `identification.result` = {`source`: `expert`|`ai`, `taxon`, `is_confirmed`, `confidence`, `confidence_label`, `uncertainty`, `agreement`} on their own report (`/me/observations/`) — a **single result, not a ranked shortlist**, arriving asynchronously after server processing ([reports.py `ObservationSerializer.IdentificationSerializer` L1000–1036](https://github.com/Mosquito-Alert/mosquito_alert/blob/master/mosquito_alert/api/v1/serializers/reports.py)).

### 2.2 What a third party can and cannot reach

- Live today: `https://api.mosquitoalert.com/v1/ping/` → 204; unauthenticated `POST /observations/` → clean 401 `not_authenticated` (probed 2026-10-02, `ma-api-ping.json`, `ma-api-obs-post-probe.json`).
- Report/photo submission requires an account; guest signup is in the spec (`/auth/signup/guest/`, password only, writeOnly). In principle an API client can replicate the app flow: guest JWT → create report with photos → poll for the AI result.
- The per-photo prediction/scores endpoints (`/identification-tasks/{uuid}/predictions/`, `/photos/{uuid}/prediction`) are staff/workspace-only: `PhotoPredictionPermissions = FullDjangoModelPermissions` ([permissions.py L216](https://github.com/Mosquito-Alert/mosquito_alert/blob/master/mosquito_alert/api/v1/permissions.py)), and `can_view_identification_task` requires workspace membership ([rules.py](https://github.com/Mosquito-Alert/mosquito_alert/blob/master/mosquito_alert/identification_tasks/rules.py)). A reporter only gets the collapsed single result.
- No public schema endpoint on prod (`/api/v1/schema/` → 404); the spec ships only in the SDK repos. SDKs (python/typescript/dart/R) exist on GitHub only — **not on PyPI** (pypi.org/pypi/mosquito-alert → 404, 2026-10-02). No developer/API docs page on mosquitoalert.com (checked home page, 2026-10-02).

### 2.3 Terms

The [user agreement](https://www.mosquitoalert.com/en/user-agreement/) (fetched 2026-10-02) governs data contribution: photos may be released anonymously under CC-BY, databases under CC0, and data may be shared with public-health professionals. It says **nothing** about third-party API clients or automated access. Developer contact in the spec: it@mosquitoalert.com (contact "Developers").

### 2.4 Verdict — hosted public mosquito-ID service on Mosquito Alert

The most interesting hosted option for mosquito specifically: a live, free, purpose-built classifier (v2025.1) whose classes include *albopictus*, *japonicus*, *koreicus*, *culex*, *anopheles*, *culiseta* — the exact European taxa. But: single-result (no shortlist), asynchronous (server-side queue), no documented rate limits, no public developer docs, and the user agreement does not sanction API clients — every call creates a citizen-science report in their surveillance database, which is not the same as an ID service. **Building a public-facing service on it requires an agreement with Mosquito Alert** (it@mosquitoalert.com); a gray-zone client mimicking the app with guest accounts would be polluting a scientific dataset and is not defensible. If a partnership were on the table, their API + classifier is arguably the single best hosted fit for the European taxa, and the sibling topic's local-model path is the fallback.

## 3. Kindwise insect.id (claim 1) — dropped per decision, short paragraph only

What it is: the only self-serve commercial purpose-built insect-ID API (Kindwise, ~14k taxa, [insect.kindwise.com/docs](https://insect.kindwise.com/docs) — a Postman collection, `kindwise-postman.json`). Endpoint shape **verified** from the collection: `POST /api/v1/identification` with `images` (base64 data-URIs) + `latitude`/`longitude`/`similar_images`, returning `result.classification.suggestions` (ranked, with `probability`), a separate `is_insect` binary check, `model_version` (insect_id:2.0.0), and `usage_info` with day/week/month/total credit limits; details params `gbif_id`/`inaturalist_id`/`taxonomy` are supported. Pricing **verified** from [kindwise.com/pricing](https://www.kindwise.com/pricing) (fetched 2026-10-02): 100 free credits after registration; Business credit packs from **€0.05/credit** (1k, €50) down to **€0.01/credit** (1.5M, €15,000); "cost of each identification call is one credit"; credits valid 3 months except purchases under 30,000 ("Purchased credits are valid for 3 months (this does not apply to purchases under 30 000 credits)" — verbatim; the exact reading for small purchases is ambiguous on the page). SLA + dev keys are Business features. **Why not pursued:** Cornelius: "it's so limited, not worth it, let's drop it" — the free quota (100 credits total / 10/month web demo) is too small for any real use, no API key will be provided, and we will not live-test it. The web-demo "10 identifications/month" claim from the working notes was **not confirmed** from the pages fetched (the product page links a demo at insect.kindwise.com/demo but states no quota); the 100-credit-after-registration figure is confirmed. Vendor-reported 92% top-3 remains vendor-reported, untested. For completeness: €0.05/credit self-serve would allow a small public service at ~€50/1,000 IDs, subject to their API Terms and Conditions (linked from the pricing page footer, not fetched).

## 4. Other hosted insect/mosquito-ID APIs (claim 3)

**CulicidaeLab** — [github.com/CulicidaeLab](https://github.com/CulicidaeLab) (3 repos: `culicidaelab`, `culicidaelab-server`, `culicidaelab-mobile`). The server is a FastAPI+Solara "API services" platform (species prediction, observation service, map, galleries) built on the culico-net models and CC-BY-SA datasets — **no live hosted instance found**: no advertised deployment URL in either README, and `culicidaelab.org`, `culicidaelab.com`, `mosquitoscan.org`, `mosquitoscan.com`, `app.culicidaelab.org` all fail to resolve (probed 2026-10-02). Server and app are AGPL-3.0 (note if self-hosting a public service on them — that's the sibling topic's path anyway). Verdict: **nothing hosted to call today**.

**Everything else — nothing credible found.** Purpose-built hosted insect/mosquito photo-ID APIs beyond the above: none. Checked the Mosquito-Alert org repos (nothing else serving an ID API), GitHub code search for `score_image` across the iNat org (mapped above), and probed likely CulicidaeLab domains. The general-vision APIs (Gemini/GPT etc.) are out of scope by brief. Baidu/Tencent pest/animal-recognition cloud APIs exist but document no mosquito-species capability; caveat: the WebSearch tool was rate-limited (backend 429s) during the sweep, so this "nothing else" rests on GitHub/org mapping and direct probes rather than an exhaustive commercial-landscape search — a claim I could not fully discharge after honest effort. If a hosted mosquito-ID API existed with public docs, the iNat forum threads and the Mosquito-Alert ecosystem (both heavily cross-referenced by citizen-science projects) would likely have surfaced it; they did not.

## 5. Claims scoreboard

| Claim | Verdict |
|---|---|
| 1. Kindwise insect.id endpoint/pricing/demo terms | Endpoint shape + pricing **verified**; "web demo 10/month" **not confirmed** from fetched pages; topic **dropped** per decision (quota too small, no key) |
| 2. iNat full CV classifier not exposed as supported API; only ~500-taxon small models released | **VERIFIED**, sharpened: `score_image` exists, powers the apps, auth-gated (401 live-verified), absent from official swagger, staff-stated "no public API", fee-based select access only (carrie@inaturalist.org); full model private for IP/rights reasons, ~500-taxon small models released |
| 3. Other hosted insect/mosquito-ID APIs | **Refuted as a landscape**: only Kindwise (self-serve), iNat CV (fee-based, select-only), Mosquito Alert (free but flow-bound, terms don't sanction API clients); CulicidaeLab hosts nothing live; nothing else credible found |

## 6. Method notes and limitations

- All fetches 2026-10-02 via curl into `05-hosted-apis/`, converted with html2text, no re-fetches per parsing attempt. `www.inaturalist.org` (incl. the API reference page and the CV demo page) is Cloudflare-fronted and returned 403 to both curl and WebFetch from this container — citations for those pages use the Rails/Node source code instead, which is stronger evidence anyway.
- Live probes were unauthenticated GET/POST only (no signups, no keys); exactly one image was ever sent to any endpoint (iNat `score_image`, rejected 401). The iNat `/v1/taxa/suggest` non-visual probes used a real public photo URL obtained via the documented observations API.
- WebSearch returned persistent backend 429s during this session; the sweep for other APIs leaned on GitHub org/repo mapping, code search, and direct domain probes instead.
- No API keys exist, so nothing here was tested *with* credentials — the 401s establish the auth boundary, not post-auth behaviour (quota, latency, quality).
