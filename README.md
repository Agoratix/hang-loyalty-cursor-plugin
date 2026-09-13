# Hang Loyalty — Cursor plugin

Integrate the [Hang Loyalty](https://hang.xyz) partner API (points ledger + rewards) into your codebase.

This package bundles:

- **MCP server** (`mcp.json`) — hosted `hang-loyalty` tools for members, earning, balances, rewards/redemptions, quests, puzzles, loot boxes, verification scenarios, and enterprise provisioning
- **Skill** (`skills/hang-loyalty/SKILL.md`) — how to build the integration, with the full API reference embedded
- **Rule** (`rules/hang-loyalty.mdc`) — project guardrails (server-side only, env config, `spendable_balance`, one earning rail, etc.)

## Install

Install from the [Cursor Marketplace](https://cursor.com/marketplace), then configure the variables below under **Plugins → Configure**.

## Required configuration

| Variable | Purpose |
| --- | --- |
| `HANG_API_KEY` | Program API key (MCP bearer token). Keep it secret. |
| `HANG_PORTAL_BYPASS_TOKEN` | Vercel deployment-protection bypass for the portal host. From the [MCP page](https://owner.hang.com/mcp). |
| `HANG_ACTIVITY_TYPE_ID` | Optional. Default earning activity type id. |
| `HANG_ENTERPRISE_API_KEY` | Optional. Account-level key for `/v2/enterprise/*` tools only. |

This plugin ships **no secrets** — only `${VAR}` placeholders resolved from dashboard configuration.

## Notes

- The MCP server is a **dev-time verification** tool. Production code must call the Hang partner API directly over HTTP.
- Staging API origin: `https://loyalty.headliner.page` · Production: `https://loyalty.hang.xyz`
- Skill content is generated from the [owner-x-hang](https://github.com/Agoratix/owner-x-hang) partner portal (`pnpm build:plugin`). Prefer regenerating upstream rather than hand-editing the skill here.
- Docs / MCP setup: https://owner.hang.com/mcp

## License

MIT
