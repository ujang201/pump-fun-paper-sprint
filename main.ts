// Pump.fun Paper Sprint — early sniper (paper trading only, no real funds).
//
// The harness speaks agent-fun/replay/v2 over stdin/stdout as newline-delimited
// JSON: a `hello` line, then one `batch` per slot that carries universe records,
// then `done`. Every batch carries that slot's chain events, the current marks
// (bonding-curve reserves per mint), the fills of our earlier orders and our
// account. We answer each batch with one `reply` line echoing its seq and
// listing the orders we want placed. An order decided on the batch for slot s
// resolves two slots later, at the curve as it stands then.
//
// Strategy, in one paragraph: snipe new coins at birth. On the dev window the
// whole edge lives in a coin's first one or two trades — the median coin is
// already up 7% by its first trade and 14% by its second, and entries made
// after that lose money, while entries made at the first feasible moment win
// about two thirds of the time. So the first time a coin shows a real trade we
// buy it at once, sized to what the 1%-of-real-reserves order cap allows
// (0.8% for margin, never below the 0.01 SOL round-trip floor, never above
// 0.20 SOL), and only if the price has not already run more than 12% from
// its creation print. A coin that ran too far, or whose reserves cannot yet
// fund the floor in that first batch, is never chased later: later entries
// lose money on the dev window, and waiting for reserves to grow only buys
// the pump at a worse price. One entry per mint, ever. Exits are tight: take
// profit at +10% over the filled entry price, stop loss at -10%, a trailing
// exit once up 10% that sells after a 10% give-back from the peak, or a hard
// exit after 600 slots.
//
// All decisions come from the event stream alone: no clock, no randomness,
// no network, no environment. The same replay therefore produces the same
// action log byte for byte.

import * as readline from "node:readline";

// ---------------------------------------------------------------------------
// Tunables (lamports; 1 SOL = 1_000_000_000 lamports)
// ---------------------------------------------------------------------------

const BUY_SIZE_LAMPORTS = 200_000_000; // 0.20 SOL per ticket, the most we spend
const MIN_BUY_LAMPORTS = 10_000_000; // 0.01 SOL, the guardrail round-trip floor
const MAX_BUY_BPS_OF_REAL_RESERVE = 80; // 0.8% of real SOL reserves (cap is 1%)
const MAX_RUNUP_TO_ENTER = 0.12; // skip if already up > 12% from creation print
const TAKE_PROFIT = 0.1; // sell at +10% over entry
const STOP_LOSS = 0.1; // sell at -10% under entry
const TRAIL_TRIGGER = 0.1; // trailing exit arms once up 10%
const TRAIL_GIVEBACK = 0.1; // ... then sell after giving back 10% from peak
const MAX_HOLD_SLOTS = 600; // hard exit after ~4 min in a position
const MAX_SLIPPAGE_BPS = 500;
const MAX_ORDERS_PER_BATCH = 16;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Bonding-curve price in lamports per token unit, from virtual reserves.
function curvePrice(virtualQuote: string, virtualToken: string): number {
  const quote = Number(virtualQuote);
  const token = Number(virtualToken);
  if (!(quote > 0) || !(token > 0)) return 0;
  return quote / token;
}

function lamports(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ---------------------------------------------------------------------------
// Per-coin tape state
// ---------------------------------------------------------------------------

interface Coin {
  mint: string;
  firstSlot: number;
  firstPrice: number; // price at the coin's first event (usually its creation)
  lastPrice: number;
  peakPrice: number;
  lastSlot: number;
  trades: number; // real TradeEvents seen (CreateEvent does not count)
  realSol: number; // latest real SOL reserves, lamports
  evaluated: boolean; // we already took our one entry decision on this coin
}

interface Position {
  mint: string;
  tokens: number;
  entryPrice: number; // lamports per token, from our buy fill
  entrySlot: number;
  peakPrice: number;
}

const coins = new Map<string, Coin>();
const positions = new Map<string, Position>();
let orderCounter = 0;
let maxOpenPositions = 5;
let cashLamports = 0;

function noteTrade(
  mint: string,
  slot: number,
  price: number,
  realSol: number,
): void {
  if (price <= 0) return;
  let coin = coins.get(mint);
  if (coin === undefined) {
    coin = {
      mint,
      firstSlot: slot,
      firstPrice: price,
      lastPrice: price,
      peakPrice: price,
      lastSlot: slot,
      trades: 0,
      realSol,
      evaluated: false,
    };
    coins.set(mint, coin);
  }
  coin.lastPrice = price;
  coin.lastSlot = slot;
  if (price > coin.peakPrice) coin.peakPrice = price;
  if (realSol > 0) coin.realSol = realSol;
  coin.trades += 1;
}

function noteCreate(mint: string, slot: number, price: number): void {
  if (price <= 0) return;
  if (coins.has(mint)) return;
  coins.set(mint, {
    mint,
    firstSlot: slot,
    firstPrice: price,
    lastPrice: price,
    peakPrice: price,
    lastSlot: slot,
    trades: 0,
    realSol: 0,
    evaluated: false,
  });
}

function noteMark(
  mint: string,
  slot: number,
  virtualQuote: string,
  virtualToken: string,
  realQuote: string,
): void {
  const price = curvePrice(virtualQuote, virtualToken);
  if (price <= 0) return;
  let coin = coins.get(mint);
  if (coin === undefined) {
    coin = {
      mint,
      firstSlot: slot,
      firstPrice: price,
      lastPrice: price,
      peakPrice: price,
      lastSlot: slot,
      trades: 0,
      realSol: lamports(realQuote),
      evaluated: false,
    };
    coins.set(mint, coin);
  }
  coin.lastPrice = price;
  coin.lastSlot = slot;
  if (price > coin.peakPrice) coin.peakPrice = price;
  const real = lamports(realQuote);
  if (real > 0) coin.realSol = real;
}

// ---------------------------------------------------------------------------
// Order decisions for one batch
// ---------------------------------------------------------------------------

interface Order {
  side: "buy" | "sell";
  client_id: string;
  mint: string;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
}

function nextClientId(kind: string, seq: number): string {
  orderCounter += 1;
  return `${kind}-${seq}-${orderCounter}`;
}

function decideOrders(seq: number, slot: number): Order[] {
  const orders: Order[] = [];

  // --- exits first: free the position slots before we look for entries. ---
  for (const pos of positions.values()) {
    const coin = coins.get(pos.mint);
    const price = coin !== undefined ? coin.lastPrice : 0;
    if (price <= 0 || pos.tokens <= 0) continue;
    if (price > pos.peakPrice) pos.peakPrice = price;
    const gain = price / pos.entryPrice - 1;
    const peakGain = pos.peakPrice / pos.entryPrice - 1;
    const giveback = pos.peakPrice > 0 ? price / pos.peakPrice - 1 : 0;
    const agedOut = slot - pos.entrySlot >= MAX_HOLD_SLOTS;
    const takeProfit = gain >= TAKE_PROFIT;
    const stoppedOut = gain <= -STOP_LOSS;
    const trailedOut =
      peakGain >= TRAIL_TRIGGER && giveback <= -TRAIL_GIVEBACK;
    if (takeProfit || stoppedOut || trailedOut || agedOut) {
      orders.push({
        side: "sell",
        client_id: nextClientId("s", seq),
        mint: pos.mint,
        token_amount: String(Math.floor(pos.tokens)),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
    }
  }

  // --- entries: snipe each coin once, on the first batch it shows a trade.
  // The run-up is measured against the coin's creation print: a coin that
  // already ran more than MAX_RUNUP_TO_ENTER, or whose real reserves cannot
  // fund the 0.01 SOL floor in that first batch, is passed on and never
  // reconsidered — later entries lose money on the dev window, and waiting
  // for reserves to grow only buys the pump at a worse price.
  const openCount = positions.size;
  const sellsPlanned = orders.length;
  const freeSlots = maxOpenPositions - (openCount - sellsPlanned);
  if (freeSlots <= 0 || cashLamports < MIN_BUY_LAMPORTS) return orders;

  let tickets = Math.min(freeSlots, MAX_ORDERS_PER_BATCH - orders.length);
  for (const coin of coins.values()) {
    if (tickets <= 0) break;
    if (coin.evaluated || coin.trades < 1) continue;
    coin.evaluated = true;
    if (positions.has(coin.mint)) continue;
    const runup =
      coin.firstPrice > 0 ? coin.lastPrice / coin.firstPrice - 1 : 0;
    if (runup > MAX_RUNUP_TO_ENTER) continue;
    // Stay under the 1%-of-real-reserve order cap with margin to spare.
    const reserveCap = Math.floor(
      (coin.realSol * MAX_BUY_BPS_OF_REAL_RESERVE) / 10000,
    );
    const size = Math.min(BUY_SIZE_LAMPORTS, reserveCap, cashLamports);
    if (size < MIN_BUY_LAMPORTS) continue;
    orders.push({
      side: "buy",
      client_id: nextClientId("b", seq),
      mint: coin.mint,
      quote_lamports: String(size),
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
    cashLamports -= size;
    tickets -= 1;
  }
  return orders;
}

// ---------------------------------------------------------------------------
// Message handling: hello, batch, done
// ---------------------------------------------------------------------------

function onHello(msg: any): void {
  cashLamports = lamports(msg?.capital?.lamports ?? "0");
  if (typeof msg?.caps?.max_open_positions === "number") {
    maxOpenPositions = msg.caps.max_open_positions;
  }
}

function onBatch(msg: any): Order[] {
  const seq = typeof msg.seq === "number" ? msg.seq : 0;
  const slot = typeof msg.slot === "number" ? msg.slot : 0;

  // Account snapshot is the source of truth for cash and holdings.
  if (msg.account !== undefined && msg.account !== null) {
    cashLamports = lamports(msg.account.cash_lamports ?? "0");
    const held = new Set<string>();
    const list = Array.isArray(msg.account.positions)
      ? msg.account.positions
      : [];
    for (const p of list) {
      const mint = String(p.mint);
      held.add(mint);
      const tokens = lamports(p.token_amount ?? "0");
      const cost = lamports(p.cost_lamports ?? "0");
      const known = positions.get(mint);
      if (known !== undefined) {
        known.tokens = tokens;
        if (tokens > 0 && cost > 0) known.entryPrice = cost / tokens;
      } else if (tokens > 0) {
        positions.set(mint, {
          mint,
          tokens,
          entryPrice: cost > 0 ? cost / tokens : 0,
          entrySlot: slot,
          peakPrice: 0,
        });
      }
    }
    for (const mint of [...positions.keys()]) {
      if (!held.has(mint)) positions.delete(mint);
    }
  }

  // Fills pin down the true entry price of each buy (cost / tokens filled).
  const fills = Array.isArray(msg.fills) ? msg.fills : [];
  for (const fill of fills) {
    if (fill.status !== "filled") continue;
    const mint = String(fill.mint);
    const tokens = lamports(fill.token_amount ?? "0");
    const quote = lamports(fill.quote_lamports ?? "0");
    if (fill.side === "buy" && tokens > 0 && quote > 0) {
      const pos = positions.get(mint);
      const entryPrice = quote / tokens;
      if (pos !== undefined) {
        pos.entryPrice = entryPrice;
        pos.entrySlot = typeof fill.slot === "number" ? fill.slot : slot;
        pos.peakPrice = entryPrice;
      } else {
        positions.set(mint, {
          mint,
          tokens,
          entryPrice,
          entrySlot: typeof fill.slot === "number" ? fill.slot : slot,
          peakPrice: entryPrice,
        });
      }
    }
  }

  // Tape: every trade event updates its coin's price and reserves.
  const events = Array.isArray(msg.events) ? msg.events : [];
  for (const event of events) {
    if (event.event === "TradeEvent") {
      const price = curvePrice(
        event.virtual_sol_reserves,
        event.virtual_token_reserves,
      );
      noteTrade(
        String(event.mint),
        typeof event.slot === "number" ? event.slot : slot,
        price,
        lamports(event.real_sol_reserves ?? "0"),
      );
    } else if (event.event === "CreateEvent") {
      const price = curvePrice(
        event.virtual_sol_reserves,
        event.virtual_token_reserves,
      );
      noteCreate(
        String(event.mint),
        typeof event.slot === "number" ? event.slot : slot,
        price,
      );
    }
  }

  // Marks refresh the latest price of every coin the harness still tracks.
  const marks = Array.isArray(msg.marks) ? msg.marks : [];
  for (const mark of marks) {
    noteMark(
      String(mark.mint),
      typeof mark.slot === "number" ? mark.slot : slot,
      mark.virtual_quote_reserves,
      mark.virtual_token_reserves,
      mark.real_quote_reserves,
    );
  }

  // Forget coins that stopped trading long ago, so the tape stays small.
  if (coins.size > 20000) {
    for (const [mint, coin] of coins) {
      if (slot - coin.lastSlot > 20000 && !positions.has(mint)) {
        coins.delete(mint);
      }
    }
  }

  return decideOrders(seq, slot);
}

async function main(): Promise<void> {
  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    const text = line.trim();
    if (text.length === 0) continue;
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      continue;
    }
    if (msg.type === "hello") {
      onHello(msg);
    } else if (msg.type === "batch") {
      const orders = onBatch(msg);
      process.stdout.write(
        JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n",
      );
    } else if (msg.type === "done") {
      break;
    }
  }
}

main().catch(() => {
  process.exitCode = 1;
});
