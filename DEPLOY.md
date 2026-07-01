# Deploying the reverse bot

This bot places resting limit BUY orders on Polymarket's recurring crypto
Up/Down markets and holds to resolution. It must run from a server whose IP is
in a **Polymarket-permitted jurisdiction** — Polymarket geoblocks by request
IP, which is why a US-hosted server (e.g. a New York droplet) gets every order
rejected with a region error. Only deploy where you are actually permitted to
trade; jurisdiction compliance is your responsibility.

## 1. Provision a host in a permitted region

Any always-on Linux host in a permitted region works. Example: AWS EC2
`t3.micro`, Ubuntu Server 24.04 LTS, region **Mexico (Central) `mx-central-1`**.

- EC2 → Launch instance → Ubuntu 24.04 → `t3.micro`
- Create/download a key pair
- Security group: allow SSH (22) from **your IP only**
- Launch, then connect via EC2 Instance Connect (browser terminal)

## 2. Install runtime + clone

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs git

# Use a short-lived, repo-scoped token; revoke it right after setup.
git clone https://<user>:<GITHUB_TOKEN>@github.com/munjjnn/john.git reverse-bot
cd reverse-bot

# IMPORTANT: check out the branch that actually has the fixes you want.
# The tests + retry/bounded-state fixes live on this branch:
git checkout claude/polymarket-reverse-bot-1pmar2

npm install
npm run build
```

## 3. Configure `.env`

Copy the template and fill it in. `.env` is gitignored — never commit it.

```bash
cp .env.example .env
```

Recommended values for the **first live test** (one tiny cheap order, hedge
off) — start here, confirm a real order lands, then scale up:

```
DRY_RUN=false
SIGNATURE_TYPE=0            # if auth fails, try 2, then 1
ENABLE_EXPENSIVE_HEDGE=false
CHEAP_ORDER_USDC=1
MAX_SHARES_PER_ORDER=5
PRIVATE_KEY=0x...           # Polymarket: Cash → ⋮ → Export Private Key
FUNDER_ADDRESS=0x...        # Polymarket wallet / deposit address
```

> **Minimum order size:** at `CHEAP_ORDER_USDC=1` and a 7–10¢ price, each level
> is ~5 shares ≈ $0.35–$0.50 notional. Polymarket enforces a per-order minimum
> (commonly ~$1 / 5 shares), so orders this small may be rejected for min-size.
> If you see repeated `Rejected … (will retry)` lines, raise `CHEAP_ORDER_USDC`
> (e.g. to 2–3) rather than assuming a region/auth problem.

Fund the Polymarket wallet with a few dollars of USDC first, or every order is
rejected for insufficient balance.

## 4. Run

```bash
npm start
```

- **Success looks like:** `  [TRADE] Placed BUY [CHEAP Up @ $0.08 × 5] → orderId=0x…`
  Then verify it appears on your Polymarket **activity tab** — the log is not
  proof by itself.
- **Auth failure:** try `SIGNATURE_TYPE=2`, then `1`, rebuilding is not needed
  (it is read from `.env` at start).
- **Region rejection / min-size:** the bot now **retries failed orders every
  poll cycle** (`… (will retry)`), so a persistent reject will loop. Stop with
  `Ctrl-C` and fix the cause rather than letting it spin.

## 5. Keep it running (systemd)

`npm start` dies when your SSH session ends. Install the unit in
`deploy/reverse-bot.service` (edit the `User`/`WorkingDirectory` placeholders):

```bash
sudo cp deploy/reverse-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now reverse-bot
journalctl -u reverse-bot -f      # follow logs
```

## 6. Post-deploy housekeeping

- **Destroy the old DigitalOcean droplet(s)** plus any Volumes/Snapshots to
  stop billing.
- **Rotate the Polymarket key** — it lived on the retired NY droplet. Move funds
  to a fresh wallet / re-export once the new box is running.
- **Revoke the GitHub token** used for cloning.

## Reality check

By its own design this is a negative-expectation strategy ("most cheap bets go
to zero"), and Polymarket fees (~5%) are not in the return math. Do the tiny
live test, confirm an order actually lands on your activity tab, and only scale
after that.
