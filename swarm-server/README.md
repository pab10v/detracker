# Swarm signaling server

## Logs: why `stderr.log` stays empty

Node’s `console.log` writes to **stdout** (file descriptor 1), not stderr (2). If the host only appends **stderr** to `stderr.log`, you will see **silence** unless:

- you redirect: `node server.js >>out.log 2>>stderr.log`, or  
- the process uses `console.error` (we use it for startup, optional HTTP/upgrade debug).

On listen, the server prints one line to **both** stdout and stderr with `pid`, `port`, and `SWARM_LOG_*` flags so you can confirm the process is alive.

## Debug env vars

| Variable | Effect |
|----------|--------|
| `SWARM_LOG_UPGRADE=1` | `console.error` on each WebSocket **upgrade** (reaches stderr if captured). |
| `SWARM_LOG_HTTP=1` | `console.error` on each HTTP request (noisy; use briefly). |

Example:

```bash
export SWARM_LOG_UPGRADE=1
export SWARM_LOG_HTTP=1
node server.js
```

## Apache + `.htaccess` (cPanel–style)

If the app runs behind Apache, you need **`mod_proxy`**, **`mod_proxy_wstunnel`**, and rules that pass **`Upgrade`** and **`Connection`** to the Node port. If that is missing, **Cloudflare 524** and empty Node logs are common: the request never reaches `server.js`.

## Cloudflare 524

524 = Cloudflare could not get a timely response from your **origin**. Fix origin reachability, socket backlog, or proxy timeout — not the Node `ws` library alone.
