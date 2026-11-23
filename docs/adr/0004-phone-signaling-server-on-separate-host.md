# The Phone pairs through our own signaling server on a free Node host; relay, not TURN, is the fallback

The game is a static site on GitHub Pages, but pairing a Phone over WebRTC needs a server to swap connection offers. We run a small Node `ws` server on Render's free tier. Its URL is set at build time, and the game page sends it a wake-up request on load, because the free tier sleeps after about 15 minutes idle. Once paired, motion data goes peer to peer. If peer-to-peer is blocked, the same server relays the data, capped per room, instead of a paid TURN server.

## Considered Options

- **Dev/LAN only**: rejected. Friends couldn't play from the deployed site.
- **A hosted signaling service** (e.g. PeerJS cloud): rejected. Relay needs a server we control anyway.
- **Cloudflare Workers with Durable Objects**: rejected for now. It means a different runtime from the Node tests and dev proxy.
- **Paid TURN, or an always-on paid host**: rejected on cost. A cold start of about 30–60 s is accepted, and the wake-up on page load hides most of it.

## Consequences

- The site is no longer static only. Phone pairing breaks if the Render service is down. The Camera Input is unaffected.
- The server never sees motion data, except in relay mode.
