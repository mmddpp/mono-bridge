# mono-bridge

## Configure

`MONOPROXY_TOKEN` is required and is used as the upstream JWT:

```sh
npx wrangler secret put MONOPROXY_TOKEN
```

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
