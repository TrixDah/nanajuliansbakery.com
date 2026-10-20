# Bake A Message — encrypted chat

## What's included

- Passwordless email-code login: one-use 6-digit codes, 10-minute expiry, hashed/MACed code storage, a five-attempt cap, per-IP and per-email request limits, cooldowns, and secure HTTP-only sessions.
- Village Square public chat, direct messages, and named private groups.
- Client-side hybrid encryption: a fresh random AES-256-GCM key encrypts each message; RSA-OAEP-3072/SHA-256 wraps that key separately for every room member; ECDSA P-256/SHA-256 signs the encrypted message envelope. The server verifies signatures and stores only ciphertext, IVs, signatures, and recipient key envelopes.
- Private encryption/signing keys are held in browser IndexedDB as non-extractable CryptoKeys. The account recovery file is encrypted with a random 256-bit recovery code using PBKDF2-SHA-256 (600,000 iterations) and AES-256-GCM. The recovery code is shown once and must be stored separately from the file.
- Server-side limits: 12 messages/minute and 120/hour per user, 40/minute per IP; login request/verification limits; group creation limit; body, group-size, public-room-size, and message-size bounds.
- SQLite persistence for accounts, sessions, rooms, and encrypted messages.

## Local run

Requires Node.js 22 or newer, npm, an SMTP mailbox/provider, and this repository root.

```bash
cp .env.example .env
openssl rand -base64 48
# Put the generated random value in AUTH_PEPPER in .env.
# Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and MAIL_FROM to your provider.
npm install
npm run check
npm start
```

Open `http://localhost:3000/bake-a-message.html`. `localhost` is treated as a secure context by modern browsers. If the email code does not arrive, check SMTP provider logs and spam/junk folders. The API deliberately does not print login codes to the server console.

For local HTTP, `NODE_ENV=development` sets a non-Secure cookie so localhost works. For production, change `NODE_ENV` to `production`, serve only over HTTPS, keep `.env` readable only by the service account, and use a trusted reverse proxy. Set `TRUST_PROXY_HOPS=1` only if a single trusted proxy sits directly in front of Node; adjust to your actual topology. Do not expose the Node port directly to the public internet without TLS and a firewall/reverse proxy.

## Hosting with the static website

GitHub Pages cannot run this Node API. Chat requires the Node server and SMTP configuration. For a single-origin deployment, route web requests through HTTPS to this Node app (which serves the existing HTML/assets and `/api`). A reverse proxy can route to the Node port. Do not configure DNS, Cloudflare, tunnels, or the existing unrelated services without reviewing your own server setup first.

Use a persistent writable `DB_PATH` outside the publicly served website. Back up the SQLite database with SQLite-aware backup tooling; it contains personal email addresses and metadata, but message bodies and private keys are not stored there. Back up `.env` securely, never in Git. Append the patterns in `GITIGNORE_CHAT_ADDITIONS.txt` to your existing `.gitignore` (do not overwrite the repository's existing ignore file).

## Encryption and privacy model

Message text is encrypted and signed in the sender's browser. The backend never receives plaintext message bodies or private keys. It must still process the account email for login and can see account display name, room names/types, memberships, sender, timestamps, ciphertext sizes, IPs needed for rate limiting, and the public keys. The SMTP provider sees login code email metadata. Login codes and session tokens are not stored in plaintext in the database.

This is a useful prototype, not a professionally audited secure messenger. It does not yet provide forward secrecy, a Double Ratchet, multi-device sync, verified/key-transparent identities, attachments, editing/deleting messages, abuse reporting, or durable distributed rate limits across multiple server instances. The public-key directory is served by this server; for sensitive conversations, key fingerprints must be compared out of band. Use a current HTTPS deployment and keep server dependencies patched. Do not describe this as anonymously hosted or metadata-free.

There is no password reset that can recover lost private keys. If you lose both the browser's local key and the separate recovery code or encrypted backup, old messages cannot be decrypted. Store the encrypted recovery file and recovery code in different secure places. Never paste the recovery code into chat or share it with other people.
