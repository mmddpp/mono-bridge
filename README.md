# mono-bridge

## Configure

`MONOPROXY_TOKEN` is required and is used as the upstream JWT:

```sh
npx wrangler secret put MONOPROXY_TOKEN
```

`MONOQUERY_URL` is optional. When set, each `server` hostname is resolved to an IPv4 address through that DNS-over-HTTPS endpoint; if a lookup fails, the original hostname is kept:

```sh
npx wrangler secret put MONOQUERY_URL
# e.g. https://47.57.20.32/monoquery
```

The URL may use an IP literal. Cloudflare Workers' `fetch()` cannot target IP addresses, so for IP-literal endpoints the Worker falls back to a raw TCP + TLS socket and sends the HTTP request itself.

`PATH` is required ans is used as the inbound authentication. It must be at least 44 alphanumeric characters: `A-Z`, `a-z`, or `0-9`.

```sh
npx wrangler secret put PATH
```

## Test

```sh
npm run dev

curl http://localhost:8787/${PATH}
```

## Deploy

```sh
npm run deploy
```
