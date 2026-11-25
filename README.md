[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/ujang201/pump-fun-paper-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/ujang201/pump-fun-paper-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Pump.fun Paper Sprint — early sniper

A paper-trading bot for the [Pump.fun Paper Sprint](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on make.fun. It trades pump.fun bonding curves on a 6-hour replay, ranked by net PnL. Paper trading only — no real funds, no real transactions, ever.

## Strategy

New pump.fun coins pump hardest in their first one or two trades (the median
coin is already up 7% by its first trade and 14% by its second on the dev
window), then fade toward zero. Entries made after that lose money, so this
bot snipes coins at birth:

- **Entry:** on the first batch a coin shows a real trade, buy it at once —
  but only if the price has not already run more than 12% from its creation
  print, and only if its real SOL reserves can fund at least the 0.01 SOL
  round-trip floor. Ticket size is 0.8% of real reserves (the order cap is
  1%), capped at 0.20 SOL. One entry per mint, ever; a coin that ran too far
  or cannot fund the floor in that first batch is never chased later.
- **Exits:** take profit at +10% over the filled entry price, stop loss at
  −10%, a trailing exit once up 10% that sells after a 10% give-back from the
  peak, or a hard exit after 600 slots (~4 minutes). At most 5 open
  positions.
- **Determinism:** every decision comes from the event stream alone — no
  clock, no randomness, no network, no environment. The same replay produces
  the same action log byte for byte.

## Results (dev window, kit grade-local, process driver)

- Net PnL **−0.029 SOL** on 35 coins / 35 round trips (win rate 20%),
  max drawdown 0.3%. Guardrails met (≥20 coins with ≥0.01 SOL round trips).
- The dev window is a hard regime for every simple strategy we tested
  (momentum-chasing lost −2.49 SOL); this sniper is the closest to
  break-even of the variants tried, and its 90% interval nearly touches
  zero, so it is the best shot at the unseen 6-hour final window.

## How to run

The harness speaks `agent-fun/replay/v2` over stdin/stdout (NDJSON: `hello`,
then one `batch` per slot, then `done`; the bot answers each batch with one
`reply` line). Grade it locally with the kit:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process --worktree
```

Requires Node 22.18+ (the grader runs Node 22.23.4). `main.ts` is the only
program; it reads the replay from stdin and writes replies to stdout.

## Files

- `main.ts` — the bot (TypeScript, Node 22, no dependencies)
- `prompt.txt` — the build brief
- `LICENSE` — MIT

---

Built for the make.fun bounty — [make.fun](https://make.fun/r/wfjv7kgb)
