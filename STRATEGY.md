# STRATEGY.md — Surge Rider

## The market

The replay streams pump.fun bonding-curve events (`CreateEvent`,
`TradeEvent`, `CompleteEvent`) for a 1-in-16 sample of launches. Capital is
10 SOL, at most 5 open positions, each buy capped at 1% of the curve's real
SOL reserve, at most 16 orders per batch, orders fill 2 slots after they are
decided. Every fill pays 95 bps protocol + 30 bps creator curve fees (2.5%
per round trip) plus a 105,000-lamport transaction fee, and 2% of
transactions fail (fee lost, no fill). The guardrails demand a round trip of
at least 0.01 SOL on at least 20 coins and a maximum drawdown of 50% or
less; a prize needs net PnL above 0 SOL.

## What the dev window measured

All numbers below are from the kit's full 24-hour dev dataset (1,222 coins,
Nov 2–3 2026), measured with the kit's own replay simulator.

- Half of all coins spike 20% or more within 10 slots of creation; 29%
  exceed +50%, 11% exceed +100%.
- But buying at age 3, the median coin's *future* max run-up is only +1%
  and its median return 10 slots later is −1%. The early spike is mostly
  uncatchable: by the time a bot can buy, the move is done. This is why
  mature-momentum entries (age 60+, the kit pilot's approach) lose heavily
  on this window.
- The strongest entry-time predictors of a later +50% run are sustained
  crowd buying (≥10 distinct buyers, net inflow > 1 SOL over 50 slots) and a
  rising price at age ~100 — but even the best group only reaches a ~40%
  hit rate, and the 2-slot fill latency plus fast reversals eat most of it
  in execution.
- Letting runners run with a trailing stop loses more than it gains here:
  prices crash faster than a 2-slot-late exit can follow. Fixed take-profit
  and stop-loss with a short hold win.
- The binding cost is friction: 2.5% curve fees per round trip. Cutting the
  number of trips matters as much as picking better coins.

## The strategy

`strategy.ts` implements one bot, `createStrategy(DEFAULT_PARAMS)`:

1. **Entry — launch sniper.** A coin is bought once, at age 0–3 slots, as
   soon as its size cap (`maxBuyLamports`, 1% of real SOL) reaches the 0.3
   SOL stake. No momentum filter beyond one trade existing: at this age
   there is nothing else to measure. Skipped when the creator has already
   sold or bought more than 2.5 SOL in the create slot.
2. **Size — 0.3 SOL, once.** No pyramiding. Five concurrent positions max,
   so capital cycles through many coins.
3. **Exits — fast and symmetric.** Take-profit +15%, stop-loss −15%,
   maximum hold 10 slots (the hold does not apply while the position is up
   at least 5%). Creator sells while held, or the curve completes, also
   exit. Sells go out with wide slippage (10,000 bps) so a fill is never
   refused for the price moving in the 2-slot latency.
4. **Forced exits.** If sells are ever sent with tight slippage (not the
   default), a rejection is free and the sell is retried next batch; after
   `maxSellRejects` rejections or `maxExitWait` slots the exit is forced
   with wide slippage so the position slot frees up.
5. **Guardrail probes.** If filled orders or distinct coins lag a pace of
   30 coins / 300 fills over 6 hours of block time, the bot opens a 0.02
   SOL probe on a liquid coin and sells it as soon as the buy lands. On
   the dev window the main strategy trades 484 coins, so probes almost
   never fire — they are insurance for a quiet final window.

## Parameters (DEFAULT_PARAMS)

| Knob | Value | Why |
|---|---|---|
| Entry age | 0–3 slots | The move happens at launch |
| Stake | 0.3 SOL | Flat region: 0.25–0.4 SOL score within 0.01 SOL |
| Take-profit / stop-loss | +15% / −15% | Symmetric, fast; TP 12–18% all similar |
| Max hold | 10 slots | Longer holds bleed; shorter holds cut winners |
| Buy slippage | 1500 bps | Fills must not be refused for launch volatility |
| Sell slippage | 10000 bps | Never refuse a sell for the price moving |

## Results

Local simulator on the full dev dataset (the official `grade-local` run on
the same bot agrees within ~0.05 SOL; see README):

| Metric | Value |
|---|---|
| Net PnL | −0.341 SOL |
| Coins traded | 484 |
| Round trips | 537 (103 winners) |
| Max drawdown | 4.8% |

This is the best of ~100 configurations swept on the dev window — and it
still loses. The dev window is a bad window: the kit's own momentum pilot
scores −9.7 SOL on it, its sniper −0.42 SOL, and doing nothing scores 0.
The bot is designed for the final 6-hour window, where a fresh set of
launches either repeats this regime (then nobody scores above zero and the
prize refunds) or offers fast early spikes (which this bot banks at +15%
each while capping every loss at −15%).

## Determinism

No clock, no randomness, no I/O. State lives in insertion-ordered maps fed
by the batch stream only, so the grader's two executions produce
byte-identical action logs.
