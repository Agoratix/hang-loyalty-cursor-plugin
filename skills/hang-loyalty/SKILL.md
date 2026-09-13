---
name: hang-loyalty-integration
description: >
  Integrate the Hang Loyalty partner API (points ledger + rewards) into this
  codebase. Use when implementing loyalty features: enrolling members,
  reporting earning activity, displaying points balances, listing rewards,
  redeeming points-priced rewards at checkout, or refunding/voiding
  redemptions. Triggers on mentions of Hang, loyalty points, rewards catalog,
  spendable balance, redemptions, or the partner API.
---

# Integrating Hang Loyalty

You are integrating this codebase with Hang Loyalty, a points ledger and
rewards platform. Hang is the source of truth for points and rewards; this
codebase reports events to Hang and renders what Hang returns.

## Ground rules

1. **All Hang calls happen server-side.** The API key is a secret. Never call
   the partner API from browser/mobile code — route through this codebase's
   backend.
2. **Configuration lives in env vars.** Use (creating if absent):
   - `HANG_API_BASE_URL` — e.g. https://loyalty.hang.xyz (paths below are relative to `/partner-api`)
   - `HANG_API_KEY` — sent as the `X-API-KEY` header
   - `HANG_ACTIVITY_TYPE_ID` — the earning activity type for order events
3. **One Hang membership per user.** Enroll with your stable user id as
   `external_user_id`, store the returned membership `id` on the user record
   (e.g. `hang_membership_id` column), and reuse it everywhere. Enroll lazily
   on first need if the user predates the integration.
4. **Idempotency keys are your order ids.** Activity reporting is idempotent
   per `idempotency_key` — pass your order/transaction id so retries are safe.
5. **`spendable_balance` is the number.** Display it, gate redemptions with
   it. `balance` is lifetime-earned and only drives tiers.
6. **Match local conventions.** Build the Hang client following whatever HTTP
   client, error-handling, and service patterns this codebase already uses.
   Read neighboring code first.

## Integration surfaces (implement what the task asks for)

These mirror the integration paths in the full reference below. Each names the
MCP tool(s) to verify it against the sandbox (if the `hang-loyalty` MCP server
is connected).

### Backend client (do this first)
A thin server-side module wrapping the core calls every other surface uses:
enroll (POST /v2/program-memberships), search
(GET /v2/program-memberships/search?external_user_id=), level
(GET /v2/program-memberships/:id/level), report activity
(POST /v2/program-memberships/:id/activities/synchronous), list rewards
(GET /v2/program-memberships/:id/rewards), generate redemption
(POST /v2/program-memberships/:id/redemptions), redeem
(POST /v2/redemptions/:uuid/redeem), void (POST /v2/redemptions/:uuid/void).
Verify with: `validate_connection`.

### Setup and auth
The program needs one earning activity type before it can take earning. Create
it once (idempotent on name) and store the returned id as
`HANG_ACTIVITY_TYPE_ID`. Verify with: `list_activity_types`,
`create_activity_type`.

### Members
Enroll on account creation with your stable user id as `external_user_id` and
persist the returned membership id. Add a lazy path: when you need a membership
id and have none, search by external_user_id first, then enroll. Enrollment is
find-or-create on external_user_id, but re-sending an email already on file
returns 409 — use search as the find path. Verify with: `enroll_member`,
`find_member`.

If a 409 fires for a member you never enrolled, the email belongs to a member
that pre-exists in Hang (e.g. created from POS history) — that's the claim
case: enroll without the email, find the pre-existing member with
`GET /v2/admin/program-memberships/summary?search_query=<email>` (substring
match — exact-match the returned `email` client-side), then combine them with
`POST /v2/admin/program-memberships/merge` (source = pre-existing member,
soft-deleted; target = your enrolled member). Only merge after the guest has
proven they own the email or phone in your app — merges are irreversible. See
"Claiming an existing member" in the full reference below.

### Earning (order paid + engagement)
On the order-paid event/webhook in this codebase, report:
`{ idempotency_key: orderId, activity: { activity_type_id, value: orderSubtotalInDollars, transaction_timestamp } }`
to the synchronous activities endpoint. Hang computes points from the program's
earning rules — do not compute points locally. For engagement actions (review,
referral, daily visit) use a deterministic idempotency_key so retries can't
double-credit. Verify with: `send_activity`, `get_points_balance`.

### Balances
Read level in the backend. Display and gate with `spendable_balance`; `balance`
is lifetime-earned and only drives tiers. Verify with: `get_points_balance`.

### Rewards and redemption
Rewards page: fetch level + rewards, show `spendable_balance` prominently, mark
each reward affordable when `points_price <= spendable_balance` (disable the
rest), and surface already-granted rewards (those with a `balance` object) as
free to redeem. Checkout: two-step — generate a redemption for the chosen
reward, then redeem it (the redeem call is what deducts points). Apply the
discount to the cart only after redeem succeeds, and handle 422
`INSUFFICIENT_POINTS_BALANCE_TO_REDEEM_REWARD` by re-reading the balance — note
affordability is validated at BOTH the generate and redeem steps, so match that
code on both. The request body field is `reward_id` but takes the reward's
`uuid`; the redemption's lifecycle is under `state`
(`initiated`/`redeemed`/`denied`), not `status`.
Refunds/cancellations: void
the redemption (points come back automatically); persist the redemption uuid on
the order so the void path can find it. Verify with: `list_rewards`,
`generate_redemption`, `redeem_redemption`, `void_redemption`,
`get_ledger_timeline`. To build the catalog itself: `create_reward`
(the curated points-priced menu-item reward), `list_pos_menu_links` (Hang-side
POS ids for the menu link), `list_admin_rewards`, `grant_reward` to comp
a reward directly to a member, and `delete_rewards` to soft-delete rewards by
uuid (they leave the catalog but historical redemptions are preserved).

### Toast in-store
No code required — in-store orders ride Toast's loyalty integration
automatically. Do NOT also report Toast orders via activities (that
double-earns). One earning rail per order type: partner API for app orders,
Toast for in-store.

### Webhooks
Handle `reward.redeemed`. It fires for both in-app and Toast in-store
redemptions. Every payload carries the envelope
`{ type, id, webhook_sent_at, program: { program_id, external_ref } }` with the
event's own keys merged alongside; dedupe on `id` (a retry reuses it), route on
`program.external_ref`, and map users on `external_user_id`, not the membership
id. Timeouts, unreachable endpoints, 408s and 5xx are retried up to 5 times
with exponential backoff (10s doubling to 160s, jittered); a 4xx is permanent
and dropped, so never return one for a transient failure.

Two delivery modes, differing only in how you authenticate:
- **Enterprise endpoint** (one URL for every program, what a multi-brand
  partner should use): verify `Hang-Signature`, a comma-separated list of
  base64 HMAC-SHA256 digests over the **raw body bytes concatenated with the
  `Hang-Timestamp` header**, computed with the account's signing secret.
  Constant-time compare, accept on any match (the list carries both secrets
  during a rotation), reject a stale `Hang-Timestamp` (verify against the
  header, not the body's `webhook_sent_at`), ack 2xx within 5 seconds. Never
  re-serialize the body before hashing. `webhook_secret_key` is unused here.
  Takes over from a per-program URL one subscribed event at a time.
- **Per-program** (one URL per program, older): verify the `X-API-Key` header
  equals that program's `webhook_secret_key`, ack 2xx within 2 seconds.

Process async and idempotently in both modes.

**Points events.** Four cover every balance movement, each subscribed
independently: `points.earned`, `points.earn_reversed`, `points.spent`,
`points.spend_refunded`. Payload merges
`{ external_user_id?, program_membership_id, phone?, channel, points, balance,
spendable_balance, occurred_at, source: { type, id, activity_type?, reward? },
location?: { restaurant_guid } }` onto the envelope.
- `points` is ALWAYS positive — direction lives in the event type, so never
  check its sign.
- Identify the member by `external_user_id` first, falling back to `phone`
  (profile phone, E.164, omitted when none): a member enrolled at the Toast
  register by phone has no `external_user_id` until the partner enrolls them,
  so `toast` and `check_in` events often carry only `phone`.
- `channel` names the originating system; `partner_api` and `toast` are the
  common two. Treat it as an open enum and fall through on unknown values.
- `location.restaurant_guid` is the Toast restaurant the check was at, present
  on every `toast` channel event (earned, reversed, spent, refunded) and
  omitted (not null) otherwise. Same value as `app.installed`'s
  `location.restaurant_guid`.
- `balance` is lifetime earned and drives tiers — spending never moves it.
  `spendable_balance` is what the member can redeem with, and is omitted when
  the program does not price rewards in points. Both are as of `occurred_at`,
  not delivery, so apply events in `occurred_at` order.
- `points.spent` fires when a spend is FINAL. A Toast hold placed at payment
  and released by a voided check never emits, so a `points.spend_refunded`
  only ever follows a `points.spent` you already received.
- `points.spent` is not a substitute for `reward.redeemed`: the latter also
  fires for free and granted rewards, the former only when points were charged
  and is the only one carrying the amount.

**Toast tile events.** `app.installed` and `app.uninstalled` track the Hang
tile being connected to or removed from a Toast location. Payload merges
`{ occurred_at, location: { restaurant_guid, management_group_guid?, name,
location_name?, external_restaurant_ref?, external_group_ref? } }` onto the
envelope; Toast sends an identical body for both, so branch on `type`.
- `external_restaurant_ref` and `external_group_ref` are the partner's own
  identifiers set in Toast Web, and are usually the right routing key. Both are
  omitted when unset, as is `management_group_guid` for a standalone location.
- The `program` block names which of their programs the location attached to.
- Only locations resolving to a program they own produce an event. Silence
  means the install was not theirs — usually a missing or expired Toast
  binding if one was expected.
- `app.installed` fires when the location finishes attaching to a program, not
  when Toast reports the install, and fires again when a removed tile is
  reconnected — treat it as "on this program (again)", not a one-time create.
- `app.uninstalled` is notification only. Hang does not disable the location,
  so it means "stop sending activity for this restaurant_guid", not "torn
  down".

### Enterprise provisioning and Toast bindings (only with an enterprise key)
Skip unless the task involves provisioning programs for multiple brands or
locations. This surface uses a separate account-level **enterprise API key**
(`HANG_ENTERPRISE_API_KEY`, and the `X-Hang-Enterprise-Api-Key` header for the
MCP tools) — the program key cannot call `/v2/enterprise/*`, and the enterprise
key cannot call anything else.

`POST /v2/enterprise/programs` creates a program and returns `program_id`,
its own `api_key`, `webhook_secret_key`, and `activity_type_id` (plus
`program_slug`, `external_ref`, `created`); store the first four against your
`external_ref`, which is also the idempotency key (a replay returns the
existing program with `created: false`, ignoring `name`/`timezone` and using
`points_per_dollar` only to fill in a missing rule, while bringing the program
up to the current defaults such as missing tier rungs). It also creates
TOAST_SPEND/TOAST_REVERSAL rules at the same rate so an attached Toast location
earns identically. Provisioning does not configure per-program webhook
delivery; if the account already has an enterprise endpoint, new programs are
covered by it immediately, otherwise nothing fires until Hang sets one up.

Every program ships with a four-rung tier ladder keyed off lifetime points:
Tier 0 from 0, Tier 1 from 1,000, Tier 2 from 4,000, Tier 3 from 10,000,
earning at 1x/1.1x/1.2x/1.3x the base rate (10/11/12/13 points per dollar at
the default `points_per_dollar`). Multipliers are proportional, so a base of
20 earns 20/22/24/26. Tiers never move down — they track `balance`, which
redemptions do not reduce. A member holds exactly one tier at a time, so create
catalog rewards as program rewards (`create_reward` does this) rather than
linking them to a single tier, or they vanish when their holder is promoted.

By default a Toast tile install provisions a **brand new** program. To make an
install attach to a program you already own, register a binding first with
`POST /v2/enterprise/programs/:program_id/bindings`: `match_type` of
`restaurant_guid` for one location or `management_group_guid` for a whole Toast
group, with the location-level rule winning over the group's. The rule must
exist BEFORE the install — a location that already installed elsewhere is
rejected with 422, and a GUID can only be bound to one program at a time.

Verify with: `provision_program`, `list_provisioned_programs`,
`get_provisioned_program`, `bind_toast_location`, `list_program_bindings`,
`revoke_program_binding` (frees the GUID; already-installed locations stay put),
`list_program_locations` (ground truth — only populated once a location
actually installs the tile).

### Advanced (only if the task calls for it)
Loot boxes, quests, and puzzles are covered in the appendix of the full
reference below. Each has dedicated MCP tools:
- **Loot boxes:** `create_loot_box`, `update_loot_box` (edit only — loot
  boxes have NO archive/delete endpoint), `list_loot_box_definitions`,
  `get_loot_box_definition`, `grant_loot_box`, `list_loot_boxes`,
  `open_loot_box`. Each reward choice grants `point_reward_value` and/or
  `reward_uuids` (catalog rewards — must be bonus-group reward uuids); the MCP
  tool now supports both. Re-opening a box returns 422
  `ALLOCATED_LOOT_BOX_UNPROCESSABLE`. Update path is
  `PATCH /v2/admin/loot-boxes/:loot_box_id`.
- **Quests:** `create_quest`, `add_quest_requirement`, `update_quest`
  (edit, or retire via `status: archived` — status is forward-only
  draft→published→archived, so you can't move back to draft, and there is no
  delete endpoint), `list_quests`, `get_quest`,
  `list_member_quests`, `opt_in_quest`, `list_quest_opt_ins` (then report
  progress with `send_activity`). When calling `POST /v2/admin/quests`
  directly, the required fields are `name`, `description`, `opt_in_text`,
  `starts_at`, `ends_at`, `point_threshold_requirement`, and
  `quest_requirements` (each with `activity_type_id`, `description`,
  `value_threshold`). `value_threshold` is activity VALUE (e.g. dollars), not
  points, and only activity reported AFTER opt-in counts. Both completion caps
  are optional and omitted means uncapped; `max_num_of_completions_per_user`
  is per member, `max_num_of_completions_for_program` is the TOTAL across all
  members — setting the latter to 1 makes the quest one-and-done for the WHOLE
  program (others then get `QUEST_COMPLETED_MAX_NUMBER_OF_TIMES`, the same
  code a member gets on hitting their own cap). Update/archive uses
  `PATCH /v2/admin/quests/:quest_id` (status is forward-only; moving back to
  draft is 422 `STATUS_UNPROCESSABLE`).
- **Puzzles:** `create_puzzle_completion_reward` →
  `create_puzzle` (pass the completion reward id as `reward_ids`) →
  `create_puzzle_piece_reward` + `add_puzzle_piece` per slot (sequential
  from 0). Inspect with `list_puzzles`, `get_puzzle`,
  `list_member_puzzles`, `get_member_puzzle`; `update_puzzle` edits a
  puzzle, publishes it (`published_at`), or retires it (`archived_at` — the
  only cleanup, there is no delete). To complete: issue every piece by granting
  its backing reward to the member (read `get_puzzle` for each piece's
  loyalty_reward_id, resolve the uuid via `list_admin_rewards`, then
  `grant_reward`), then call `complete_puzzle`. FOOTGUN: a direct
  `POST /v2/admin/puzzles` without `published_at` creates an unpublished,
  non-completable puzzle (`create_puzzle` sets it for you). The complete 422
  ("not all pieces") is a free-text message, not a coded enum.

## Verifying your work

Use the MCP tools above against the sandbox to verify each step as you build,
and `run_scenario` for scripted end-to-end checks. Production code must still
call the partner API directly over HTTP — the MCP server is a dev-time tool,
not a runtime dependency.

The contract below changes over time. Before touching an existing integration,
read the `hang://docs/changelog` resource: every change to a response shape,
webhook payload, or documented behaviour is listed there by date, newest first,
with whether it needs anything from you. For exact request and response
schemas, read `hang://docs/openapi` — an OpenAPI 3.1 document covering every
endpoint, generated from the server's own docs — rather than inferring shapes
from examples.

## Full API reference

# Hang Loyalty Integration Guide

Hang is your points ledger and rewards engine. You tell Hang when members earn;
Hang tracks balances; redemptions deduct points and work both in your app and
at the Toast POS from a single reward catalog.

This guide is organized by integration path. Work top to bottom for a full
integration, or jump to the path you need. Every change to what it promises —
a response shape, a webhook payload, a documented behaviour — is dated in the
Changelog (`hang://docs/changelog`), newest first, so you can see what moved
since you last read it.

## At a glance

The whole core integration is six calls. Authenticate every request with your
program API key:

```bash
curl https://loyalty.hang.xyz/partner-api/v2/admin/program \
  -H "X-API-KEY: $HANG_API_KEY"
```

Then the loop is: enroll a member, report earning, show the balance and reward
catalog, and redeem at checkout (generate then redeem; void to refund).

```text
enroll member ─▶ report activity ─▶ read balance + rewards ─▶ generate ─▶ redeem ─▶ (void)
```

Store three values in config: `HANG_API_BASE_URL`, `HANG_API_KEY`, and
`HANG_ACTIVITY_TYPE_ID` (the earning rule you create in Setup). All paths below
are relative to the `/partner-api` mount.

## Core concepts

- **Program membership** — your user enrolled in the program. Keyed by your
  `external_user_id`. Include `phone` so members can be identified at the POS.
- **balance vs spendable_balance** — `balance` is lifetime-earned (drives
  tiers); `spendable_balance` is earned minus spent. Display and gate with
  `spendable_balance`.
- **Points-priced reward** — a catalog reward with `points_price`. Redeeming it
  deducts that many points. Rewards are mirrored to Toast menu items so the
  same reward works at the register.
- **Granted reward** — a reward given to a member (welcome, birthday, comp).
  Redeems free of charge; takes precedence over a points charge.
- **Activity type** — an earning event you report (e.g. "App order"), carrying
  the rule that converts activity value into points.

## Setup and auth

Every request sends your program API key in the `X-API-KEY` header. The key is
scoped to one loyalty program — keep it server-side.

There are two kinds of keys:

- **Program API key** — scoped to one loyalty program; used for everything in
  this guide (members, earning, rewards, redemptions).
- **Enterprise API key** — account-level; only works on the
  `/v2/enterprise/*` provisioning endpoints. If Hang issued you one, you can
  create programs programmatically and attach Toast locations to them — see
  "Provisioning programs (enterprise)" and "Attaching Toast locations
  (enterprise)".

Before anything else, your program needs at least one **activity type**: the
earning event you'll report, with a rule converting value into points.

```bash
curl -X POST .../v2/admin/activity-types \
  -H "X-API-KEY: $HANG_API_KEY" -H "Content-Type: application/json" \
  -d '{ "name": "App order", "points_per_unit": 10 }'
```

This creates the event plus a "10 points per unit" rule (and bootstraps the
program's points metric if it's brand new). The returned `id` is the
`activity_type_id` you pass with every earning activity — store it in config.

```bash
curl .../v2/admin/activity-types -H "X-API-KEY: $HANG_API_KEY"
```

> [!NOTE]
> Creating an activity type is idempotent on name: re-posting "App order"
> returns the same activity type and updates its rule. Use the GET list to
> discover ids on an already-configured program instead of creating new types.

## Provisioning programs (enterprise)

Skip this section unless Hang issued you an **enterprise API key**. It lets a
platform spin up a loyalty program per brand or location without waiting on
manual setup — one call returns everything the runtime integration needs.

```bash
curl -X POST .../v2/enterprise/programs \
  -H "X-API-KEY: $HANG_ENTERPRISE_API_KEY" -H "Content-Type: application/json" \
  -d '{ "name": "Taco Palace", "external_ref": "loc-123", "points_per_dollar": 10 }'
```

The response is `{ program_id, program_slug, external_ref, api_key,
webhook_secret_key, activity_type_id, created }`. Store `program_id`, the
program-scoped `api_key`, `webhook_secret_key`, and `activity_type_id`
against your `external_ref` — `program_id` is the handle every other
enterprise call takes — and use that program key for every runtime call in this
guide. (`activity_type_id` is nullable: it is `null` in the rare case the
program's purchase activity type is missing.) The program comes pre-provisioned:
points metric, the default tier ladder, a purchase activity type with the
earning rule you specified, and matching `TOAST_SPEND`/`TOAST_REVERSAL` rules
at the same rate so a Toast location attached to the program earns identically
at the register.

- **Idempotent on `external_ref`** (your brand/location id): re-posting the
  same ref returns the existing program with HTTP 200 and `created: false`
  instead of 201 — safe to retry. Replays are **deduplicated, not merged**:
  `name` and `timezone` in a replayed request are ignored, and
  `points_per_dollar` is used only to fill in an earning rule that is missing,
  never to change one that exists. A replay does still bring the program up to
  the current defaults — a program created before the tier ladder existed gains
  its missing rungs, and its bottom rung is renamed from `Base` to `Tier 0` —
  without disturbing members, who stay on the tier they already hold.
- `GET /v2/enterprise/programs` lists your provisioned programs (no secrets);
  each item is `{ program_id, program_slug, title, external_ref,
  provisioned_at }`. `GET /v2/enterprise/programs/:id` re-fetches one
  program's credentials if you lose them (404 if the id isn't provisioned on
  your account).
- **Errors**: a missing `X-API-KEY` header is 400
  (`API_KEY_HEADER_IS_MISSING`); an invalid or revoked key is 401. Those (and
  the 404 above) render `{ id, code, messages }`; a failed create —
  validation or upstream provisioning — is 422 with the other body shape,
  `{ "errors": ["..."] }`.

### The default tier ladder

Every provisioned program gets four tiers keyed off lifetime-earned points, and
each tier earns at a multiple of the base rate:

| Tier | Lifetime points | Multiplier | Rate at the default base |
| --- | --- | --- | --- |
| Tier 0 | 0 – 999 | 1.0x | 10 points per dollar |
| Tier 1 | 1,000 – 3,999 | 1.1x | 11 points per dollar |
| Tier 2 | 4,000 – 9,999 | 1.2x | 12 points per dollar |
| Tier 3 | 10,000+ | 1.3x | 13 points per dollar |

Multipliers are proportional, so `points_per_dollar: 20` earns 20/22/24/26
across the ladder rather than 20/21/22/23.

**Tiers never move down.** They track `balance` (lifetime earned), which
redemptions do not reduce — spending shows up in `spendable_balance` only. A
member is promoted on their next earning event, and jumps straight to the
highest tier their balance qualifies for rather than climbing one rung at a
time. Boosted points count toward progression, so a Tier 2 member reaches
Tier 3 faster than a Tier 0 member would.

Read the ladder with `GET /v2/admin/program-tiers` and a member's current rung
with `GET /v2/program-memberships/:id/level`.

> [!IMPORTANT]
> A member holds exactly one tier at a time, and rewards are visible only
> through a link to the program or to a tier the member currently holds. Create
> catalog rewards as **program rewards** (`is_program_reward: true`, which
> `create_reward` does for you) so they stay visible as members move up. A
> reward linked only to Tier 0 disappears — and stops being redeemable — the
> moment its holder is promoted.

> [!NOTE]
> Provisioning does **not** configure per-program webhook delivery. If Hang has
> already set up an **enterprise endpoint** on your account, every program you
> provision is covered by it from the moment it exists — nothing more to do. If
> not, no webhooks fire for the new program until one is set up for you (not yet
> available via this API). `webhook_secret_key` belongs to the older
> per-program delivery mode, where Hang echoes it back in an `X-API-Key`
> header — it is not a signing key. On an enterprise endpoint deliveries are
> signed instead and this value is unused. See **Webhooks** below.

> [!WARNING]
> The enterprise key can mint credentials for every program on your account —
> treat it like a root credential. Never use it for runtime traffic; each
> program's own API key keeps the blast radius of a leak to one program.

## Attaching Toast locations (enterprise)

Also enterprise-only. By default, when a location installs the Hang tile in
Toast, Hang provisions a **brand new program** for that location — or, if
another location in the same Toast management group is already installed, joins
that sibling's program. If you have already provisioned a program for the brand,
neither is the outcome you want: you end up with an orphan program and a
location that isn't on your account.

A **binding** fixes that. It tells Hang, ahead of time, which Toast identifiers
belong to a program you already own, so the install attaches to your program
instead of creating one.

```bash
curl -X POST .../v2/enterprise/programs/$PROGRAM_ID/bindings \
  -H "X-API-KEY: $HANG_ENTERPRISE_API_KEY" -H "Content-Type: application/json" \
  -d '{ "match_type": "restaurant_guid", "match_value": "$TOAST_RESTAURANT_GUID" }'
```

There are two things you can match on, both Toast's own identifiers:

- `restaurant_guid` — one specific location.
- `management_group_guid` — every location in a Toast management group, so a
  whole brand can be covered by a single rule without knowing each location up
  front.

A location-level rule beats a group-level one. That means you can bind an entire
management group to your main program and carve out individual locations onto
different programs, without revoking the group rule.

Two optional fields shape the rule: `external_ref` records your own id for the
location or group, and `expires_in_days` (up to 365) makes the rule stop
matching after a while. Catching an install does not use a rule up, so a
location that uninstalls and reinstalls returns to the same program instead of
provisioning a fresh one.

> [!WARNING]
> Register the binding **before** the location installs the tile. A rule only
> catches future installs, so a `restaurant_guid` rule for a location that has
> already installed under a different program is rejected with 422 — there is
> no install left to intercept. A `management_group_guid` rule is not checked
> this way: it is accepted even if siblings are already installed elsewhere,
> and then catches only the group's *future* installs while the existing
> locations stay where they are. Contact Hang to move a location that has
> already landed in the wrong place.

Two endpoints tell you whether it worked. Listing the program's bindings returns
every rule ever registered, each with a `status` of `active`, `expired`, or
`revoked`; once an install matches, `claimed_at` and
`claimed_by_restaurant_guid` record which location it caught. Listing the
program's locations returns the Toast locations actually attached to it — the
ground truth you reconcile your own location ids against.

```bash
curl .../v2/enterprise/programs/$PROGRAM_ID/bindings \
  -H "X-API-KEY: $HANG_ENTERPRISE_API_KEY"
curl .../v2/enterprise/programs/$PROGRAM_ID/locations \
  -H "X-API-KEY: $HANG_ENTERPRISE_API_KEY"
```

To undo a rule, `DELETE /v2/enterprise/programs/$PROGRAM_ID/bindings/$BINDING_ID`.
Revoking stops it matching immediately and frees the GUID to be registered
again, including against a different program. It does not detach locations that
already installed under it — those stay on their program. Revoking twice is
harmless.

- **A GUID belongs to one program at a time.** Registering one a live rule
  already holds is 422; revoke that rule first. A rule that has lapsed
  (`expired`) no longer holds its GUID, so you can re-register it without
  cleaning anything up.
- **Errors** match the rest of the enterprise API: 400 for a missing
  `X-API-KEY`, 401 for an invalid one, 404 when the program isn't provisioned on
  your account, and 422 with `{ "errors": ["..."] }` when the rule is rejected.

## Members

`POST /v2/program-memberships` is find-or-create keyed by `external_user_id`
**or `phone`**: if either already belongs to a member of your program, that
membership is returned (HTTP 200, same id) and any newly provided profile fields
— including `external_user_id` — are written onto it. Because a phone match
counts, enrolling a new user whose phone is already on another member returns
that member and overwrites its `external_user_id` with yours. A brand-new
enrollment is also 200, so the status alone does not tell you which happened;
compare the returned `external_user_id` to what you sent.

```bash
curl -X POST .../v2/program-memberships \
  -H "X-API-KEY: $HANG_API_KEY" -H "Content-Type: application/json" \
  -d '{ "external_user_id": "user_123", "phone": "+13055550123" }'
```

When you need to re-resolve a membership id, search by your external id:

```bash
curl ".../v2/program-memberships/search?external_user_id=user_123" \
  -H "X-API-KEY: $HANG_API_KEY"
```

> [!WARNING]
> Re-sending an `email` that is already on file — even the same member's own
> current email — fails with 409 `EMAIL_ALREADY_EXISTS`. Treat enrollment as a
> one-shot call per user, and use the search endpoint as your find path. If the
> email belongs to a member you never enrolled (no external_user_id of yours),
> that's the claim case — see the next section.
>
> Two other 409s exist on this endpoint, so match the code rather than the
> status: `MULTIPLE_PROGRAM_MEMBERSHIPS_FOUND_FOR_GIVEN_PARAMETERS` when your
> `external_user_id` and `phone` resolve to two different members, and
> `PROGRAM_MEMBERSHIP_ALREADY_EXISTS` from a uniqueness race.

### Claiming an existing member (merge by email)

Members can exist in Hang before you enroll them — e.g. created from POS
history with an email but no `external_user_id`. When your enrollment call
returns 409 `EMAIL_ALREADY_EXISTS` and a search by your external_user_id finds
nothing, the email belongs to one of these pre-existing members, and the fix is
a **merge**: combine the pre-existing member into the one you enrolled so
points and history land in one place.

1. **Enroll without the email** (or search by external_user_id if already
   enrolled) to get your membership — this is the merge **target**.
2. **Find the pre-existing member by email** — this is the merge **source**:

```bash
curl ".../v2/admin/program-memberships/summary?search_query=taco.fan@example.com" \
  -H "X-API-KEY: $HANG_API_KEY"
```

   `search_query` is a case-insensitive **substring** match across name,
   phone, email, and membership id — exact-match the returned `email` field
   client-side before treating a row as the member.
3. **Merge** source into target:

```bash
curl -X POST .../v2/admin/program-memberships/merge \
  -H "X-API-KEY: $HANG_API_KEY" -H "Content-Type: application/json" \
  -d '{ "source_program_membership_id": "<pre-existing id>", "target_program_membership_id": "<your enrolled id>" }'
```

   Lifetime-earned `balance`, activity history, Toast order history, granted
   reward balances, and stored-value cards move to the target; the source is
   then soft-deleted. The source's **points-spend ledger and redemption history
   do not move**, so the target's `spendable_balance` after a merge can exceed
   what the two accounts could have spent between them. If your enrolled
   membership has no email yet (the usual claim case, since the email 409s at
   enrollment), the merge carries the source's email onto the target
   automatically, and the earlier of the two join dates is preserved.

> [!WARNING]
> Merging is **irreversible** and Hang trusts your assertion — verify the guest
> actually owns the source member's email (or phone) in your own app before
> merging, or anyone could claim another member's points balance.

> [!IMPORTANT]
> The merge only runs when the **source** is an email-only member with no Hang
> user account behind it — which is exactly the pre-existing, POS-history kind
> of member this flow is for. A source that was enrolled through this API, or
> that signed up by phone at the register, has a user account, and the merge is
> **skipped server-side while still returning 200**. Merge responses are
> `{ success, message }`, and their errors are `{ error }` with 404/422, not
> the `{ id, code, messages }` shape used elsewhere. If points don't combine
> after a merge, contact Hang to resolve that member manually.

> [!NOTE]
> The `magic_link` returned by enrollment/search (`include_magic_link`) is a
> login link into the Hang-hosted member portal — it is **not** a claim or
> merge flow. Use the merge endpoint above for claims.

## Earning

Report earning from your app's orders with the synchronous activities endpoint.
Pass an `idempotency_key` (your order id) so retries are safe, and the
`activity_type_id` from Setup. Points are computed from your program's earning
rules — don't compute them locally.

```bash
curl -X POST .../v2/program-memberships/:id/activities/synchronous \
  -H "X-API-KEY: $HANG_API_KEY" -H "Content-Type: application/json" \
  -d '{ "idempotency_key": "order_456", "activity": { "activity_type_id": "...", "value": 25.00, "transaction_timestamp": 1718400000 } }'
```

`transaction_timestamp` is epoch **seconds**; milliseconds are also accepted
and told apart by magnitude. The response is `{ quest_opt_ins: [...] }` — the
quest progress this activity advanced, not the balance — so follow up with the
level endpoint below when you need the new number.

> [!NOTE]
> The synchronous endpoint applies the points **before it responds**, so a
> `GET .../level` immediately afterwards reflects the new balance. (The plain
> `POST .../activities` endpoint queues the work instead.) If inline processing
> fails for any reason Hang falls back to the queue so the points still land, so
> a UI that tolerates a brief delay in that rare case is still the right design.

> [!WARNING]
> There is no refund path through activities. Every activity type this API
> creates earns at a positive rate, so reporting a refund as an activity **adds**
> points. Points spent on a reward come back through
> `POST /v2/redemptions/:uuid/void`; to claw back points earned on a refunded
> app order, contact Hang.

## Balances

Read the member's level to display points and gate redemptions.

```bash
curl .../v2/program-memberships/:id/level -H "X-API-KEY: $HANG_API_KEY"
```

The response carries the member's tier, lifetime-earned `balance`, and
`spendable_balance`. Display and gate with `spendable_balance`; `balance` only
drives tiers.

## Rewards and redemption

List the member's reward catalog, then redeem in two steps so an abandoned cart
never charges points.

```bash
curl .../v2/program-memberships/:id/rewards -H "X-API-KEY: $HANG_API_KEY"
```

1. **Cart** — enable "add to cart" when `points_price <= spendable_balance`.
   Check the cumulative cart total against the balance client-side.
2. **Order placed** — `POST .../redemptions { reward_id }` per reward unit.
   Validates affordability; does NOT charge yet. Abandoned redemptions expire
   harmlessly.
3. **Payment confirmed** — `POST /v2/redemptions/:uuid/redeem` per redemption —
   this charges the points.
4. **Order cancelled/refunded** — `POST /v2/redemptions/:uuid/void` — points are
   refunded automatically.

```bash
curl -X POST .../v2/program-memberships/:id/redemptions \
  -H "X-API-KEY: $HANG_API_KEY" -H "Content-Type: application/json" \
  -d '{ "reward_id": "<reward uuid>" }'
curl -X POST .../v2/redemptions/:uuid/redeem -H "X-API-KEY: $HANG_API_KEY"
```

> [!WARNING]
> Affordability is validated at **both** steps: the first call
> (`generate_redemption`) and the redeem call can each return 422
> `INSUFFICIENT_POINTS_BALANCE_TO_REDEEM_REWARD`. Match that exact code on both,
> remove the item, and re-read the balance — the member may have spent the points
> elsewhere between generate and redeem. (The request body field is named
> `reward_id` but takes the reward's `uuid` value.)

### Denominations (pure point decrements)

To treat Hang as a plain points ledger — deduct N points without mapping to a
specific catalog item — a program can define **denomination rewards**: rewards
named for their value ("500 pts", "1000 pts", …) whose `points_price` equals
that number.

- Identify them in the rewards list by their metadata: the API serializes
  `partner_metadata` as `metadata`, and denominations carry
  `{ "denomination": true, "points": N }`.
- **Decrement N points** = generate + redeem the matching denomination.
- **Refund** = void the redemption — the points come back automatically.
- **Compose larger amounts** from multiple denominations (e.g. 1500 = 1000 +
  500), one redemption per denomination.
- Denomination rewards are `:redemption` type, so they never surface as offers
  at the Toast POS — they exist only for your app's API-driven decrements.

## Toast in-store

In-store, everything rides Toast's loyalty integration automatically: members
are identified by phone, offers shown at the register reflect affordability,
points are charged when payment processes, earning accrues at check close, and
voids refund automatically. See the **Toast In-Store Flow** doc below for the
phase-by-phase breakdown.

> [!WARNING]
> No partner API calls are needed for in-store orders. Do not also report Toast
> orders via activities — that double-earns. One earning rail per order type:
> partner API for app orders, Toast for in-store.

## Webhooks

Hang POSTs events to an HTTPS endpoint you own. There are two delivery modes,
and you almost certainly want the second:

| | Per-program | Enterprise endpoint |
| --- | --- | --- |
| Endpoint | One URL per program | One URL for every program you own |
| Auth | `X-API-Key` header carrying `webhook_secret_key` | `Hang-Signature` HMAC over the body |
| Respond within | 2s | 5s |

Ask Hang to set up an **enterprise endpoint**: you register one URL, Hang signs
every delivery, and the payload tells you which program it belongs to. The
per-program mode predates multi-brand partners and sends your secret over the
wire on every request; it stays supported but is not what you should build
against. The two can coexist during a migration: the enterprise endpoint takes
over **per subscribed event**, and any event it does not subscribe to keeps
flowing to the program's own URL.

### The envelope

Every event carries the same outer shape, with event-specific keys merged in
alongside:

```json
{
  "type": "reward.redeemed",
  "id": "<uuid>",
  "webhook_sent_at": 1718400000,
  "program": { "program_id": 4211, "external_ref": "loc-123" },
  "external_user_id": "user_123",
  "reward": {
    "uuid": "<reward uuid>",
    "name": "Free coffee",
    "description": "Show this screen at the counter.",
    "image_url": "https://...",
    "terms_and_conditions": "One per visit.",
    "metadata": {}
  }
}
```

`program.external_ref` is the identifier **you** supplied when the program was
provisioned or linked, so route on it directly — no mapping table needed. It is
omitted (not null) for a program that was not provisioned or linked through the
enterprise API. `program_id` is Hang's id for the same program and is always
present.

Treat `id` as the idempotency key: a retried delivery reuses it, so a duplicate
`id` means you have already seen this event.

The `reward` object above is the same one that appears as `source.reward` on
`points.spent` and `points.spend_refunded`: keyed by `uuid` (the value the
redemption endpoints take as `reward_id`), with `metadata` carrying whatever
you set as `partner_metadata` when you created the reward.

### Verifying the signature

Deliveries to an enterprise endpoint carry two headers:

| Header | Value |
| --- | --- |
| `Hang-Signature` | Comma-separated list of base64 HMAC-SHA256 digests |
| `Hang-Timestamp` | Unix seconds, also covered by the signature |

Recompute over the **raw request body concatenated with the timestamp** and
accept if any value in the list matches:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody: string, headers: Headers, secret: string) {
  const timestamp = headers.get("hang-timestamp") ?? "";

  // Reject anything older than five minutes so a captured delivery cannot be
  // replayed at you later. The timestamp is signed, so it cannot be edited.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const expected = createHmac("sha256", secret)
    .update(rawBody + timestamp)
    .digest("base64");

  return (headers.get("hang-signature") ?? "")
    .split(",")
    .some((candidate) => {
      const a = Buffer.from(candidate);
      const b = Buffer.from(expected);
      return a.length === b.length && timingSafeEqual(a, b);
    });
}
```

Sign the bytes exactly as received — parsing and re-serializing the JSON will
change them and the signature will not match. There is no separator between the
body and the timestamp. Verify against the `Hang-Timestamp` header, not the
body's `webhook_sent_at`: the body is stamped when the event is queued and the
header when it is delivered, so on a retried delivery they differ.

> [!NOTE]
> The header is a **list** because during a secret rotation Hang signs with
> both the new and old secret. Accept on any match and rotation needs no
> coordinated cutover on your side: Hang issues the new secret, you deploy it
> whenever you are ready, then Hang retires the old one.

### Retries

Respond 2xx quickly and do your work async. Hang retries on a timeout, an
unreachable endpoint (connection refused, DNS failure, TLS error), an HTTP 408,
or any 5xx — up to 5 retries, so 6 deliveries in all — with exponential backoff
of roughly 10s, 20s, 40s, 80s, 160s plus up to 10s of jitter. A 4xx is treated
as permanent and is **not** retried, so do not return one for a transient
problem on your side.

> [!NOTE]
> `reward.redeemed` is channel-agnostic: it fires whenever a redemption is
> finalized, whether redeemed via the partner API in your app or at the Toast
> POS. For an in-store points-priced reward the event lands at check close
> (the LOYALTY_ACCRUE phase), not the moment the discount is applied. Map on
> `external_user_id`, not the membership id.

### Points events

Four events cover earning, its reversal, and points spent on rewards. Subscribe
to only the ones you need — each is opt-in independently. Two things move
`spendable_balance` without an event: a member exchanging points for a loot box,
and spendable-points expiry on programs that have it. If you track balances from
events alone, re-read `GET /v2/program-memberships/:id/level` before gating on
a stale number.

| Event | Fires when |
| --- | --- |
| `points.earned` | A member accrues points |
| `points.earn_reversed` | An accrual is taken back (voided check, refunded order) |
| `points.spent` | A member spends points and the spend is final |
| `points.spend_refunded` | A finalized spend is given back |

```json
{
  "type": "points.earned",
  "id": "<uuid>",
  "webhook_sent_at": 1718400000,
  "program": { "program_id": 4211, "external_ref": "loc-123" },
  "external_user_id": "user_123",
  "program_membership_id": "<uuid>",
  "phone": "+13055550123",
  "channel": "toast",
  "points": 250.0,
  "balance": 1450.0,
  "spendable_balance": 950.0,
  "occurred_at": 1718400000,
  "source": {
    "type": "activity",
    "id": "<opaque handle>",
    "activity_type": "TOAST_SPEND"
  },
  "location": {
    "restaurant_guid": "00000000-1111-2222-3333-444444444444"
  }
}
```

**`points` is always positive.** The event type carries the direction, so you
never have to interpret a sign — a `points.earn_reversed` carrying
`"points": 80.0` means 80 points were removed.

**Three ways to identify the member.** `external_user_id` is yours when you
enrolled the member; `program_membership_id` is Hang's and is always present;
`phone` is the member's profile phone in E.164, omitted when they have none.
A member who signed up at the Toast register by phone has no
`external_user_id` until you enroll them, so for `toast` and `check_in`
movements the phone is often the only key you already hold — match on
`external_user_id` first and fall back to `phone`. It is the same value
`GET /v2/program-memberships/:id` returns, so the two never disagree.

**`channel` tells you which system moved the points.** The two you will see
most are `partner_api` (your own API calls) and `toast` (the POS). The full
vocabulary is `partner_api`, `toast`, `shopify`, `square`,
`pos_integration`, `end_user_app`, `admin`, `referral`, `quest`,
`loot_box`, `form`, `game`, `social`, `check_in`, `promo_code`, and
`other`. Treat it as an open enum: match the values you care about and fall
through on the rest, so a new channel does not break you.

**The two balances move independently.** `balance` is lifetime earned and is
what drives tier progression; spending never changes it. `spendable_balance`
is what the member can actually redeem with. So a `points.spent` shows
`balance` unchanged and `spendable_balance` reduced. `spendable_balance` is
omitted entirely for programs that do not price rewards in points, matching
`GET /v2/program-memberships/:id/level`.

Both balances are the values **as of the moment the movement happened**, not as
of delivery — a retried event still reports the balance at the time, so a late
arrival will not overwrite newer state if you apply them in `occurred_at`
order.

`source.id` is an opaque string handle for the thing that produced the
movement. `source.type` is either `activity` for an accrual or
`reward_redemption` for a spend, and a `reward_redemption` source also
carries a `reward` object.

**`location` says where the points moved, when Hang knows.** For any
event Toast drives — an accrual or reversal at check close, a spend finalized
at the register, or that spend refunded when Toast voids the check — it carries
the Toast `restaurant_guid` of the check. That is the same value `app.installed`
reports as `location.restaurant_guid` and
`GET /v2/enterprise/programs/:id/locations` lists as `toast_restaurant_guid`,
so one location table serves all of them. It is omitted entirely, not sent
empty, for every other channel: a `partner_api` movement is an order or
redemption you drove, so you already know where it happened, and manual grants
and check-ins have no location.

> [!IMPORTANT]
> `points.spent` fires when a spend is **final**, which for the Toast POS is
> check close, not the moment the discount is applied. Toast places a points
> hold when the guest pays and finalizes it at close; if the check is voided
> the hold is released and no event was ever sent. That means you will never
> see a `points.spend_refunded` for a spend you were not first told about.

> [!NOTE]
> `points.spent` and `reward.redeemed` overlap but are not interchangeable.
> `reward.redeemed` fires for every redemption including free and granted
> rewards; `points.spent` fires only when points were actually charged, and is
> the only one carrying the amount.

### Toast tile events

Two events track the Hang tile being connected to and removed from a Toast
location, for the brands you manage.

| Event | Fires when |
| --- | --- |
| `app.installed` | A Toast location connects the tile and attaches to one of your programs |
| `app.uninstalled` | A Toast location removes the tile |

```json
{
  "type": "app.installed",
  "id": "<uuid>",
  "webhook_sent_at": 1718400000,
  "program": { "program_id": 4211, "external_ref": "loc-123" },
  "occurred_at": 1568667713,
  "location": {
    "restaurant_guid": "00000000-1111-2222-3333-444444444444",
    "management_group_guid": "55555555-6666-7777-8888-999999999999",
    "name": "Toast Grill & Tap",
    "location_name": "Fenway, Boston, MA",
    "external_restaurant_ref": "boston01",
    "external_group_ref": "toastgrill"
  }
}
```

`app.uninstalled` carries the same shape — Toast sends an identical payload for
both, so branch on `type` rather than on the body.

**`external_restaurant_ref` and `external_group_ref` are yours.** They are the
identifiers the brand sets against the integration in Toast Web, so they are
usually what you want to route on. Both are omitted when the brand never set
them, as is `management_group_guid` for a standalone location.

**The `program` block tells you which of your programs the location joined.**
For a location covered by a pre-provisioned Toast binding, that is the program
you created for it. For an additional location in a management group you
already operate, it is the program its siblings already use.

> [!IMPORTANT]
> `app.installed` fires when the location finishes attaching to a program, not
> at the instant Toast reports the install. Those are seconds apart for a
> location that matches a binding, and longer for a brand new one. It fires
> again when a location that removed the tile reconnects, so a receiver should
> treat it as "this location is (back) on this program", not as a one-time
> creation event.

> [!NOTE]
> You will only receive these for locations that resolve to a program you own.
> An install for a brand outside your account produces no event, so silence
> means "not yours" — if you expected one and it did not arrive, the usual
> cause is a missing or expired Toast binding.

> [!WARNING]
> `app.uninstalled` is a notification. Hang does not disable the location on
> your behalf, so treat it as a signal to stop sending activity for that
> `restaurant_guid` rather than as confirmation that anything has been torn
> down.

## Golden rules

- One earning rail per order type: partner API for app orders, Toast for
  in-store. Never both for the same order.
- Always send idempotency keys on activities; redeem/void are idempotent.
- Never use negative point grants to simulate spends — redeem/void instead.

## Appendix: Loot boxes

Loot boxes are admin-created mystery rewards: you define a set of weighted
outcomes, issue a box to a member, and the member opens it to claim what they
won.

- **Create** — `POST /v2/admin/loot-boxes` with `name`, `description`, and a
  `loot_box_reward_choices` array. Each choice carries a `probability` plus a
  `point_reward_value` **and/or** `reward_uuids` (so a box can award points,
  catalog rewards, or both). `reward_uuids` must be **bonus-group** reward
  uuids (the granted kind — e.g. from `create_puzzle_completion_reward` or any
  bonus reward in `list_admin_rewards`), not points-priced rewards. Optional
  `quantity` caps how many times a choice can be awarded across all members
  (omit for unlimited). Probabilities are relative weights, so `50/40/9/1`
  produces 50% / 40% / 9% / 1% odds.
- **Edit** — `PATCH /v2/admin/loot-boxes/:loot_box_id`. `name` and
  `description` are required; sending `loot_box_reward_choices` **replaces** the
  whole outcome set. There is **no archive or delete** for loot boxes — you can
  edit a definition but not remove it, so avoid creating throwaway boxes.
- **Issue** — `POST /v2/admin/program-memberships/:id/member-actions/grant-loot-box`
  with `{ loot_box_id }` (plus optional `admin_email`/`reason` for the audit
  trail). The winning outcome is rolled at grant time, not when the box is
  opened — listing the member's boxes already shows the pre-determined reward.
- **Open** — `POST /v2/program-memberships/:id/loot-boxes/:loot_box_id/open`
  reveals and grants the won outcome. Point rewards credit both `balance` and
  `spendable_balance` immediately (no async lag). A box opens once; a second
  open returns 422 `ALLOCATED_LOOT_BOX_UNPROCESSABLE`. List a member's boxes
  with `GET /v2/program-memberships/:id/loot-boxes`.

## Appendix: Quests

Quests are admin-created challenges a member opts into and completes by
accumulating qualifying activity (the same earning activities from the Earning
path). Completing a quest grants its configured reward.

- **Author** a quest with `POST /v2/admin/quests`. The MCP `create_quest`
  tool hides the payload, but production code calls the API directly, so here is
  the full request body. Required fields: `name`, `description`,
  `opt_in_text`, `starts_at` (epoch seconds), `ends_at` (epoch seconds),
  `point_threshold_requirement`, and a non-empty `quest_requirements` array
  (each requirement needs `activity_type_id`, `description`,
  `value_threshold`). Send `status: "published"` to make it live.

```json
{
  "name": "Spend $50 this month",
  "description": "Spend $50 to earn bonus points.",
  "opt_in_text": "Join this quest",
  "starts_at": 1718553600,
  "ends_at": 1721145600,
  "point_threshold_requirement": 0,
  "status": "published",
  "max_num_of_completions_per_user": 1,
  "max_num_of_completions_for_program": 1000000,
  "quest_requirements": [
    { "activity_type_id": "<activity type id>", "description": "Spend $50", "value_threshold": 50 }
  ]
}
```

  Add more requirements later with
  `POST /v2/admin/quests/:quest_id/quest-requirements`, and list or inspect
  with `GET /v2/admin/quests` and `GET /v2/admin/quests/:quest_id`.

> [!WARNING]
> **Per-user vs per-program completion caps.**
> `max_num_of_completions_per_user` limits how many times *each member* can
> complete the quest. `max_num_of_completions_for_program` caps the *total*
> completions across *all* members. Both are optional and **omitting one means
> no cap**. The footgun is setting the program cap thinking it is per member:
> `max_num_of_completions_for_program: 1` makes the quest one-and-done for the
> entire program — after a single member completes it, everyone else gets 422
> `QUEST_COMPLETED_MAX_NUMBER_OF_TIMES` on opt-in. That same code is returned
> when a member hits their own per-user cap, so it does not tell you which limit
> was reached.

- **Update / archive** with `PATCH /v2/admin/quests/:quest_id`. Send only the
  fields to change. There is **no DELETE endpoint** — to retire a quest send
  `{ "status": "archived" }`. Status is **forward-only** (`draft` → `published`
  → `archived`): you can archive from any state, but moving a published quest
  **back** to `draft` is rejected with 422 `STATUS_UNPROCESSABLE` (there is
  no "unpublish"). Sending `max_num_of_completions_for_program` here — at any
  value — also clears the quest's program-limit-reached flag, reviving a quest
  that went one-and-done. Archiving a quest sets its `ends_at` to now.
- **List** a member's quests with `GET /v2/program-memberships/:id/quests`.
- **Opt in** with `POST /v2/program-memberships/:id/quests/:quest_id/opt-in`,
  and read opt-ins (with progress) via
  `GET /v2/program-memberships/:id/quests/opt-ins`.

> [!NOTE]
> **Progress semantics.** A requirement's `value_threshold` is **activity
> value** (e.g. dollars reported), not points — `value_threshold: 50` means $50
> of reported activity. Progress advances as the member reports activities (the
> same Earning path) that match the quest's requirements; no separate "progress"
> call is needed. **Only activity reported *after* the member opts in counts**
> toward the quest. On the admin quest object the thresholds live under
> `quest_requirements`; the member-facing quest exposes the same things under
> `activities` — they're the same concept under different keys.

## Appendix: Puzzles

Puzzles are collect-to-complete challenges: a puzzle has a set of piece slots,
each backed by a reward, plus a completion reward. A member "earns" a piece by
holding its backing reward; once they hold every piece, completing the puzzle
awards the completion reward.

- **Completion reward** — create the prize first with
  `POST /v2/admin/rewards` as a `bonus_reward` of `reward_type`
  `redemption` (a granted, not points-priced, reward).
- **Create** — at the **raw-API** level `POST /v2/admin/puzzles` requires
  `name`, `description`, and `image_url` (a real URL the backend downloads).
  Optionally `reward_ids` (the completion reward id), `loot_box_ids`, and
  `earn_instructions`. (The MCP `create_puzzle` tool only makes `name`
  mandatory — it defaults `description` and `image_url` for you — so don't
  mistake that convenience for the HTTP contract.)

> [!WARNING]
> **`published_at` is the puzzle footgun.** It is *not* in the API's required
> list, but if you omit it the puzzle is created **unpublished and can never be
> completed** (the member-facing complete call keeps returning 422). The MCP
> `create_puzzle` tool sets it for you; **direct `POST /v2/admin/puzzles`
> callers must pass `published_at`** (ISO8601 or epoch seconds, e.g. now) for any
> puzzle that should be playable.

- **Piece reward** — each piece needs a backing reward created with
  `POST /v2/admin/rewards` as a `bonus_reward` of `reward_type`
  `puzzle_piece`.
- **Add a piece** — `POST /v2/admin/puzzle-pieces` with
  `{ puzzle_id, loyalty_reward_id, slot }`. Slots must be sequential starting
  at 0. Inspect a puzzle and its pieces with `GET /v2/admin/puzzles` and
  `GET /v2/admin/puzzles/:puzzle_id`.
- **Edit / publish / archive** — `PATCH /v2/admin/puzzles/:puzzle_id`. Set
  `published_at` to publish a puzzle that was created without one, or
  `archived_at` to retire it — there is **no DELETE endpoint**, so archiving is
  the cleanup path (and avoid creating throwaway puzzles, since each spawns a
  completion reward + N piece rewards too).
- **Member views** — `GET /v2/program-memberships/:id/puzzles` lists the
  member's puzzles; `GET /v2/program-memberships/:id/puzzles/:puzzle_id` shows
  progress on one (the puzzle with its `pieces`, each flagged collected or not).
- **Issue pieces** — a member earns a piece by being granted its backing
  reward. Pieces are added with a reward **`id`** (`loyalty_reward_id`), but
  granting needs the reward's **`uuid`** — so read `GET /v2/admin/puzzles/:id`
  for each piece's `loyalty_reward_id`, map it to a `uuid` via
  `GET /v2/admin/rewards`, then grant via
  `POST /v2/admin/program-memberships/:id/member-actions/grant-reward` with
  `{ nft_loyalty_reward_uuid }` (one grant per piece slot).
- **Complete** — `POST /v2/program-memberships/:id/puzzles/:puzzle_id/complete`
  claims the finished puzzle and awards its rewards.

> [!NOTE]
> Completion returns 422 until the member holds every piece. Issue all the
> backing rewards first (one grant per piece slot — duplicate rewards across
> slots each need their own grant), then call complete. Unlike the loot box and
> redemption 422s, this one is a **free-text `error` message** (e.g. "the puzzle
> is not redeemable because it is not complete…"), not a stable machine code —
> branch on the HTTP 422 status, not on the message text.

## Appendix: Response shapes & error codes

The MCP tools return raw API responses, but production code parses them itself —
so these are the envelopes, identifiers, and error codes to model against.

### Response envelopes

Most endpoints wrap their payload in a named key:
- Enroll / find member → `{ membership: {...} }`
- Level (`GET /v2/program-memberships/:id/level`) → **unwrapped**
  `{ tier, balance, spendable_balance }`; `tier` is `null` before any earning
  and `spendable_balance` is omitted for programs without points pricing.
- Activity types → `{ activity_types: [...] }` from the list, but
  `{ activity_type: {...} }` from create — plural for the collection, singular
  for the one you made.
- Report activity (synchronous) → `{ quest_opt_ins: [...] }`, not the balance.
- List rewards → `{ rewards: [...] }`
- Generate / redeem redemption → `{ redemption: {...} }`
- Quest opt-ins → `{ opt_ins: [...] }`
- Member quests (`GET /v2/program-memberships/:id/quests`) →
  `{ quests: [{ quest: {...}, status: "..." }] }` — each item **wraps** the quest
  under a `quest` key with the member's progress in the sibling `status` key
  (it is *not* a flat quest object).
- Admin loot boxes (`GET /v2/admin/loot-boxes`) →
  `{ loot_boxes: [...], total_records: N }` (these are definitions).
- A member's allocated loot boxes (`GET /v2/program-memberships/:id/loot-boxes`) →
  `{ allocated_loot_boxes: [...] }` (note the key is `allocated_loot_boxes`, **not**
  `loot_boxes`); each item's `redeemed_at` (epoch seconds, `null` until opened)
  tells you whether that box has been opened.

### Identifiers are not uniform

- **Memberships** are referenced by `id`.
- **Rewards** and **redemptions** are referenced by `uuid`. Where a request
  body field is named `reward_id`, pass the reward object's `uuid` value.
- A redemption's lifecycle is under `state`
  (`initiated` / `redeemed` / `denied`), **not** `status`.
- Admin quests expose thresholds under `quest_requirements`; the member-facing
  quest exposes the same data under `activities`.
- Puzzle pieces are created/returned with a reward **`id`**
  (`loyalty_reward_id`), but `grant_reward` wants the reward's **`uuid`**
  (`nft_loyalty_reward_uuid`) — so issuing a piece means a
  `get_puzzle` → `list_admin_rewards` (`id`→`uuid`) round-trip.

### Field types

`balance` comes back as a **string** (e.g. `"250.0"`) while
`spendable_balance` is a **number** — coerce `balance` before doing math.
(`spendable_balance` gates redemptions; `balance` is the lifetime/tier figure.)

### Error codes (what apps branch on)

Every error below arrives in the same body, and the code your app should match
is `messages[0].message` — not the top-level `code`, which is just the HTTP
status repeated:

```json
{
  "id": "<uuid>",
  "code": 422,
  "messages": [
    { "title": "unprocessable_entity_error", "message": "INSUFFICIENT_POINTS_BALANCE_TO_REDEEM_REWARD" }
  ]
}
```

(Two exceptions keep their own shape: enterprise create/bind failures return
`{ "errors": ["..."] }`, and the member merge endpoint returns `{ error }`.)

- **Redemption affordability is checked at `generate_redemption`, not only at
  redeem** — both can return 422
  `INSUFFICIENT_POINTS_BALANCE_TO_REDEEM_REWARD`. Match that exact code on both
  steps.
- Opting into a quest that has reached its program-wide cap returns 422
  `QUEST_COMPLETED_MAX_NUMBER_OF_TIMES` (see the per-program cap warning in the
  Quests appendix).
- Re-opening an already-opened loot box returns 422
  `ALLOCATED_LOOT_BOX_UNPROCESSABLE`.
- Completing a puzzle before the member holds every piece returns 422 — but as a
  **free-text `error` message**, not a coded enum, so branch on the 422 status
  rather than the text.
- Enrolling a member whose email already exists returns 409
  `EMAIL_ALREADY_EXISTS` — if you enrolled them before, treat it as "already
  enrolled" and look the member up by external_user_id; if you never enrolled
  them, it's a pre-existing Hang member and the claim/merge flow applies (see
  "Claiming an existing member" in the Members section). Two other 409 codes
  exist on enrollment (`MULTIPLE_PROGRAM_MEMBERSHIPS_FOUND_FOR_GIVEN_PARAMETERS`,
  `PROGRAM_MEMBERSHIP_ALREADY_EXISTS`), so match the code, not the status.
- Granting a reward (`grant-reward`) returns 404 `NFT_LOYALTY_REWARD_NOT_FOUND`
  for a uuid that isn't in your program and 422
  `NFT_LOYALTY_REWARD_UNPROCESSABLE` for a reward that isn't a published
  `bonus_reward` — points-priced catalog rewards cannot be granted.

