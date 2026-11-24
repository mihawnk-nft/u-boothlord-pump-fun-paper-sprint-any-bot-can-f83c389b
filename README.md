# Surge Rider — Pump.fun Paper Sprint

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/mihawnk-nft/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/mihawnk-nft/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A launch-sniper bot for the [Pump.fun Paper Sprint](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) on make.fun. It paper-trades pump.fun bonding curves on a 6-hour replay; highest net PnL wins.

## Strategy in one paragraph

On pump.fun the move happens in the first slots after a curve is created — half the coins spike 20% or more within ten slots, and by the time a mature momentum signal fires the move is over. So this bot buys at the launch itself (age 0–3 slots, as soon as the 1%-of-real-reserve size cap lets it buy a meaningful amount), takes profit fast (+15%), cuts losers fast (−15%), and never holds past ten slots unless the position is already up. Each bet is 0.3 SOL, never pyramided. Launches whose creator already sold, or whose creator bought an outsized chunk, are skipped. A pacing probe guarantees the guardrail (a round trip of ≥0.01 SOL on ≥20 coins) even on a quiet window. See [STRATEGY.md](STRATEGY.md) for the full write-up, including what the dev window measured.

## Layout

- `main.ts` — entrypoint; the grader runs `node /bot/main.ts`.
- `strategy.ts` — the whole strategy (one file, no dependencies beyond the SDK).
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte for byte.

## Run

Requires Node 22+ (the grader runs Node 22.23.4). No install step — pure TypeScript, no dependencies.

```sh
# Grade locally against the kit's dev window (needs the unpacked kit):
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

## Dev-window result (local simulator, full dev dataset)

| Metric | Value |
|---|---|
| Net PnL | −0.341 SOL |
| Coins traded | 484 |
| Round trips | 537 (103 winners) |
| Max drawdown | 4.8% |

The 24-hour dev window punishes every active strategy (the kit's own pilots score worse); this bot is the least-bad of ~100 configurations tested, built to be near-breakeven in a bad window and to bank the fast early spikes in a good one.

## License

MIT — see [LICENSE](LICENSE).
