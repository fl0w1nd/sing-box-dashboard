# sing-box dashboard (Extended)

Web dashboard for [sing-box Extended](https://github.com/fl0w1nd/sing-box), based on the
official [sing-box dashboard](https://github.com/SagerNet/sing-box-dashboard) and rebuilt on a
design system of its own.

It talks to the sing-box API service over gRPC-Web: `StartedService` as upstream, plus the fork's
`ExtendedService` for the features below. Against an upstream core the extended pages simply do not
appear.

## Features

- **Overview** — live traffic, the active route chain and its latency, memory, goroutines,
  connections, node latency per group, and summaries of providers and DNS.
- **Groups** — selectors and URL tests with their members as a grid of nodes.
- **Providers** — outbound providers with subscription traffic and expiry, manual updates and node
  latency (`outbound_provider`).
- **Connections** and **Logs** — as upstream, restyled.
- **DNS** — query statistics, top domains, blocked domains and clients, upstream servers, a
  filtered query log followed live with the details of each query (`dns_query_log`), and flushing
  the DNS cache (`dns_cache`).
- **Tailscale force DERP relay** — a switch in Settings and on each Tailscale endpoint page
  (`tailscale_force_relay`).
- English and Simplified Chinese.

## Use with sing-box

Serve it from the API service by pointing the dashboard download at this repository's `gh-pages`
branch, which CI publishes on every push to `main`:

```json
{
  "services": [
    {
      "type": "api",
      "listen": "127.0.0.1",
      "listen_port": 9090,
      "dashboard": {
        "enabled": true,
        "download_url": "https://github.com/fl0w1nd/sing-box-dashboard/archive/refs/heads/gh-pages.zip"
      }
    }
  ]
}
```

Then open `http://127.0.0.1:9090/dashboard/`.

## Development

```bash
git submodule update --init
pnpm install
pnpm generate
pnpm dev
```

`pnpm generate:dev` copies the daemon protos from a `../sing-box` checkout first.

### Design system

"Ledger": a warm paper canvas, hairline rules and panels laid edge to edge on a board, one signal
colour (vermilion) for what is live or selected and cobalt as the second data series, large light
numerals with small monospaced labels (Geist, Geist Mono), and Lucide line icons.

- Tokens: `src/styles/globals.css`
- Base components: `src/styles/shared.css`, `src/components/ui.tsx`
- Board primitives (board, panel, metric, tabs, chips, meter): `src/styles/ledger.css`,
  `src/components/Board.tsx`
- Charts: `src/components/charts.tsx`

Style rules are enforced by `pnpm lint:css`: colours, font sizes and weights, spacing and z-index
come from tokens.

## LICENSE

```
Copyright (C) 2022 by nekohasekai <contact-sagernet@sekai.icu>

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program. If not, see <http://www.gnu.org/licenses/>.

In addition, no derivative work may use the name or imply association
with this application without prior consent.
```
