// Surge Rider — a launch sniper for the pump.fun bonding-curve replay
// (agent-fun/replay/v2, make.fun competition
// u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b).
//
// Idea, in one paragraph: on pump.fun the move happens in the first slots
// after a curve is created — half the coins spike 20% or more within ten
// slots, and by the time a mature momentum signal fires the move is over.
// So this bot buys at the launch itself (age 0-3 slots, as soon as the 1%
// of-real-reserve size cap lets it buy a meaningful amount), takes profit
// fast (+15%), cuts losers fast (-15%), and never holds past ten slots
// unless the position is already up. A 2.5% round-trip curve fee means
// every trade must earn its keep, so the bot keeps each bet small (0.3 SOL),
// never pyramids, and skips launches whose creator already sold or whose
// creator bought an outsized chunk. A pacing probe guarantees the
// competition's guardrail (a round trip of at least 0.01 SOL on at least 20
// coins) even on a quiet window.
//
// What the dev window taught us (measured, not assumed): buying at age 3,
// the median coin's future max run-up is only +1% — the early spike is
// mostly uncatchable, and every active strategy loses on this 24-hour
// window, including the kit's own pilots. This bot is the least-bad of
// ~100 configurations tested on the full dev dataset: -0.34 SOL, 484 coins,
// 5% max drawdown. It is built to be near-breakeven in a bad window and to
// bank the fast early spikes in a good one.
//
// Deterministic by construction: no clock, no randomness, no I/O, iteration
// only over insertion-ordered maps fed by the batch stream, so two runs of
// the grader produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry lookback in slots. */
  window: number;
  /** Net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Price now over price at the window start, minus 1. */
  minPriceUp: number;
  /** Upper bound on that rise: skip curves that already ran too far. */
  maxPriceUp: number;
  /** Newer-half net inflow must be at least this multiple of the older half. */
  accel: number;
  /** Price now at least this share of the window's high. */
  nearHigh: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** Slots since the CreateEvent after which a first buy is no longer tried. */
  maxAge: number;
  /** Creator's own buys in the create slot above this (SOL) disqualify the coin. */
  maxDevBuySol: number;
  /** Distinct buying wallets in the window, at most (0 = off): a launch crowded by many wallets early is usually a dump in waiting. */
  maxBuyers: number;
  /** SOL to put into one position in total. */
  stakeSol: number;
  /** First buy of a position (SOL). */
  firstSol: number;
  /** Each add-on buy (SOL). */
  addSol: number;
  /** Most add-on buys per position. */
  maxAdds: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells use sellSlipBps. */
  buySlipBps: number;
  /** Slippage on sells (bps); a sell that would fill worse than this is rejected and retried next batch. */
  sellSlipBps: number;
  /** Exit when the position is worth this much over its cost (fraction). */
  takeProfit: number;
  /** Exit when the position is worth this much under its cost (fraction). */
  stopLoss: number;
  /** Trailing stop: arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Trailing stop: exit on a fall of this fraction from the best value. */
  trail: number;
  /** Exit after holding this many slots (unless up at least holdIfUp). */
  maxHold: number;
  /** The time limit does not apply while the position is up at least this much. */
  holdIfUp: number;
  /** Exit when net SOL over the fade window falls below minus this (SOL). */
  fadeWindow: number;
  fadeNetSol: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most momentum positions open at once (the rest of the cap is for probes). */
  maxMain: number;
  /** Guardrail pacing targets: coins and fills over paceSecs of block time. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  /** Probe round-trip size (SOL). */
  probeSol: number;
  /** Most probes open at once. */
  maxProbes: number;
  /** Most sell rejections (usually slippage) before an exit is forced with wide slippage. */
  maxSellRejects: number;
  /** Most slots an exit may wait for a good fill before it is forced with wide slippage. */
  maxExitWait: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
}

/** Settings traded with. Chosen on the full dev window with the local simulator (a faithful port of the harness), preferring flat regions over single best cells: stake 0.25-0.4 SOL, TP 15%, SL 15%, hold 10 slots all score within 0.01 SOL of each other. */
export const DEFAULT_PARAMS: Params = {
  window: 10,
  minNetSol: 0,
  minBuys: 1,
  minBuyers: 1,
  minPriceUp: 0,
  maxPriceUp: 10,
  accel: 1,
  nearHigh: 0,
  minRqSol: 0.3,
  maxRqSol: 30,
  minAge: 0,
  maxAge: 3,
  maxDevBuySol: 2.5,
  maxBuyers: 0,
  stakeSol: 0.3,
  firstSol: 0.3,
  addSol: 0.04,
  maxAdds: 0,
  minBuySol: 0.01,
  buySlipBps: 1500,
  sellSlipBps: 10_000,
  maxSellRejects: 3,
  maxExitWait: 30,
  takeProfit: 0.15,
  stopLoss: 0.15,
  trailArm: 100,
  trail: 0.3,
  maxHold: 10,
  holdIfUp: 0.05,
  fadeWindow: 20,
  fadeNetSol: 1000,
  cooldown: 150,
  maxEntries: 2,
  maxMain: 5,
  targetCoins: 30,
  targetFills: 300,
  paceSecs: 21_600,
  probeSol: 0.02,
  maxProbes: 1,
  maxExposureSol: 6,
};

const LAMPORTS = 1e9;
/** Curve fee on a sale: protocol 95 bps + creator 30 bps = 1.25%. */
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Coin {
  created: number | null;
  creator: string | null;
  devBuySol: number;
  devSold: boolean;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position. */
  invested: number;
  exiting: boolean;
  filled: boolean;
  /** Decision price (virtual quote / virtual token) of the last buy. */
  lastBuyPrice: number;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
  adds: number;
  /** Slot the exit was first decided on (-1 while not exiting). */
  exitSince: number;
  /** Sell orders on this position the harness rejected (usually slippage). */
  rejects: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint. */
  const probes = new Set<Pubkey>();
  /** Exit bookkeeping for probes (same forced-sell logic as positions). */
  const probeState = new Map<Pubkey, { exitSince: number; rejects: number }>();
  /** The bot's own filled orders and the coins they were on. */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.window, p.fadeWindow) + 5;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = { created: null, creator: null, devBuySol: 0, devSold: false, trades: [], entries: 0, lastExit: -1e12 };
      coins.set(mint, c);
    }
    return c;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (c: Coin, now: number, w: number): number => {
    let net = 0;
    for (let i = c.trades.length - 1; i >= 0; i--) {
      const tr = c.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Entry signal on a coin's tape at slot `now`. */
  const entrySignal = (c: Coin, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (c.created === null || now - c.created < p.minAge || now - c.created > p.maxAge) return false;
    if (c.devSold || c.devBuySol > p.maxDevBuySol) return false;
    const from = now - p.window;
    const mid = now - p.window / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of c.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    if (p.maxBuyers > 0 && byUser.size > p.maxBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (startPrice <= 0 || last <= 0) return false;
    const up = last / startPrice - 1;
    if (up < p.minPriceUp || up > p.maxPriceUp) return false;
    if (last < high * p.nearHigh) return false;
    if (netNew <= 0 || netNew < p.accel * netOld) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
        if (f.status === 'rejected' && f.side === 'sell' && !f.client_id.startsWith('_')) {
          const h = held.get(f.mint);
          if (h !== undefined) h.rejects++;
          const pr = probeState.get(f.mint);
          if (pr !== undefined) pr.rejects++;
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.created = e.slot;
          c.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          c.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
          if (c.creator !== null && e.user === c.creator) {
            if (e.is_buy && e.slot === c.created) c.devBuySol += sol;
            else if (!e.is_buy) c.devSold = true;
          }
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) c.trades.length = 0;
        }
      }
      for (const mint of traded) {
        const c = coins.get(mint)!;
        let cut = 0;
        while (cut < c.trades.length && c.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) c.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }
      const hasPendingSell = (mint: Pubkey): boolean => {
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') return true;
        }
        return false;
      };

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      /** Close value of a position in SOL, curve and tx fees deducted. */
      const closeValue = (mint: Pubkey, tokens: bigint): number => {
        const mk = marks.get(mint);
        const curve = state.curves.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : curve ? Number(curve.virtual_quote_reserves) : 0;
        const vt = mk ? Number(mk.virtual_token_reserves) : curve ? Number(curve.virtual_token_reserves) : 0;
        if (vq <= 0 || vt <= 0) return 0;
        const t = Number(tokens);
        return ((t * vq) / (vt + t) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      };

      // Exits first: stops, take-profit, trailing stop, hold limit, creator sell, flow reversal.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const c = coinOf(mint);
            if (h.filled) c.lastExit = now;
            else c.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = closeValue(mint, pos.token_amount);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const c = coinOf(mint);
        let exit = h.exiting;
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value <= h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit && c.devSold) exit = true;
        if (!exit && flow(c, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (h.exitSince < 0) h.exitSince = now;
        if (hasPendingSell(mint)) continue;
        if (orders.length >= cap) break;
        // A tight sell slippage refuses to sell into a crash; the order is rejected for free
        // and retried next batch. After enough rejections (or waiting too long) force the exit
        // with wide slippage so the position slot frees up.
        const forced = h.rejects >= p.maxSellRejects || now - h.exitSince > p.maxExitWait;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: forced ? 10_000 : p.sellSlipBps });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed. A probe stays
      // tracked until its position is gone, so a slippage-rejected sell is retried, not orphaned.
      for (const mint of [...probes]) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            probes.delete(mint);
            probeState.delete(mint);
          }
          continue;
        }
        if (curve === undefined || curve.complete || hasPendingSell(mint)) continue;
        if (orders.length >= cap) break;
        const pr = probeState.get(mint)!;
        if (pr.exitSince < 0) pr.exitSince = now;
        const forced = pr.rejects >= p.maxSellRejects || now - pr.exitSince > p.maxExitWait;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: forced ? 10_000 : p.sellSlipBps });
      }

      // Then entries and adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const c = coins.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (c.entries >= p.maxEntries || now - c.lastExit < p.cooldown) continue;
          if (!entrySignal(c, now, rqSol)) continue;
          want = p.firstSol;
        } else {
          // Add only into strength: price stepped up from the last buy and flow still positive.
          if (h.exiting || !h.filled || h.adds >= p.maxAdds || h.invested >= p.stakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price <= h.lastBuyPrice) continue;
          if (h.lastValue < Number(pos.cost_lamports) / LAMPORTS) continue;
          if (flow(c, now, p.window) < p.minNetSol / 2) continue;
          if (rqSol > p.maxRqSol) continue;
          want = Math.min(p.addSol, p.stakeSol - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, {
            opened: now,
            peakValue: 0,
            invested: amount,
            exiting: false,
            filled: false,
            lastBuyPrice: price,
            lastValue: 0,
            adds: 0,
            exitSince: -1,
            rejects: 0,
          });
          c.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.lastBuyPrice = price;
          h.adds++;
        }
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.add(mint);
            probeState.set(mint, { exitSince: -1, rejects: 0 });
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
