# Rate limit and client IP verification

## Client IP selection

`getClientIp` selects the `X-Forwarded-For` entry at index `length - TRUSTED_PROXY_HOPS`, counting from the right. The default is one trusted appended proxy. Set `TRUSTED_PROXY_HOPS` to an integer of at least `1` that matches the number of trusted proxy hops that append to the header. If the list is shorter than that value, the app falls back to `X-Real-IP`, then `unknown`.

Render's [public guidance](https://render.com/articles/how-render-handles-ddos-attacks) says to read `X-Forwarded-For` to obtain the client address, and describes requests passing through Cloudflare and Render load balancers. The public material does not provide a guaranteed hop count or a complete chain contract. I cannot verify the header chain received by this particular service from this checkout. Check it on the deployed service before changing the default; do not infer the hop count from the platform name.

## Verify after deploy

1. Set `RATE_LIMIT_DEBUG=1` temporarily in the Render service environment and deploy/restart.
2. Make a request to the service from a known public network and inspect the server log line `[rate-limit] xff_entries=… selected_ip=…`.
3. The log reports only the number of non-empty forwarded entries and a masked selected address (IPv4 has its last octet zeroed; IPv6 is truncated). Compare the masked value with the known network address and verify that changing a caller-supplied leftmost `X-Forwarded-For` value does not change the selection.
4. If you have verified that the rightmost trusted appended entries are a different count, set `TRUSTED_PROXY_HOPS` to that count and repeat the check. Remove `RATE_LIMIT_DEBUG` or set it to `0` after verification.

Do not paste raw client addresses into tickets or logs. The debug mode is off unless `RATE_LIMIT_DEBUG=1`.

## Limits and deployment behavior

Sign-in, password reset, setup-password, and participant PIN request/verify use separate in-memory limits for source IP and normalized account email. Their counters reset on process restart or deploy and are local to each application instance; they are not shared across instances. A request must stay under both limits. The store remains in memory by design for this change.

## Environment

- `TRUSTED_PROXY_HOPS`: optional positive integer; defaults to `1`.
- `RATE_LIMIT_DEBUG`: optional; defaults off. Set to `1` only while verifying a deployment.
