/**
 * Smoke test: random bots play complete games. After every command we assert
 * the core invariants:
 *   1. No player's cash is ever negative.
 *   2. Total player cash equals starting cash plus the bank's net outflow
 *      (tracked incrementally from emitted events). This now accounts for loan
 *      principal (bank -> borrower), interest and repayment (borrower -> bank),
 *      and the $25 creation fee — all ordinary MoneyTransferred events to/from
 *      the bank, so conservation holds automatically.
 *   3. House/hotel supplies stay within physical bounds.
 * M2: bots sometimes take a bank loan and sometimes repay it, so the loan
 * subsystem (minting from the infinite bank, interest at GO, forced
 * liquidation) is exercised under the same invariant.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Game, type Command } from "../src/core/engine.js";
import { TILES, mortgageValue } from "../src/board/tiles.js";
import { borrowingBase, outstandingPrincipal } from "../src/cards/loan/module.js";

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ranked candidate commands for whoever must act; first accepted one is used. */
function botCandidates(g: Game, rand: () => number): Command[] {
  const s = g.state;
  switch (s.phase) {
    case "gameOver":
      return [];
    case "awaitRoll": {
      const p = s.players[s.order[s.currentIdx]];
      const out: Command[] = [];
      if (p.inJail) {
        if (p.jailCards.length > 0 && rand() < 0.5) out.push({ type: "UseJailCard", player: p.id });
        else if (p.cash >= 50 && rand() < 0.3) out.push({ type: "PayJailFine", player: p.id });
      }
      // M2: sometimes borrow against unmortgaged property (within the secured limit)
      const headroom = borrowingBase(s, p.id) - outstandingPrincipal(s, p.id);
      if (headroom >= 50 && p.cash >= 25 && rand() < 0.15) {
        const amount = Math.max(1, Math.floor(headroom * (0.3 + rand() * 0.6)));
        out.push({ type: "CreateCard", player: p.id, kind: "loan", params: { borrower: p.id, amount } });
      }
      out.push({ type: "Roll", player: p.id });
      return out;
    }
    case "awaitPurchase": {
      const p = s.players[s.order[s.currentIdx]];
      const tile = TILES[s.pendingPurchase!];
      const price = "price" in tile ? tile.price : 0;
      const out: Command[] = [];
      if (p.cash >= price && rand() < 0.7) out.push({ type: "BuyProperty", player: p.id });
      out.push({ type: "DeclineBuy", player: p.id });
      return out;
    }
    case "auction": {
      const a = s.auction!;
      const bidder = s.players[a.active[a.turnPtr]];
      const next = a.highBid + 1 + Math.floor(rand() * 50);
      const out: Command[] = [];
      if (next <= bidder.cash && rand() < 0.5) out.push({ type: "Bid", player: bidder.id, amount: next });
      out.push({ type: "PassAuction", player: bidder.id });
      return out;
    }
    case "awaitEnd": {
      const p = s.players[s.order[s.currentIdx]];
      const out: Command[] = [];
      // M2: sometimes repay an outstanding loan (partial or full)
      const myLoan = s.cards.find((c) => c.kind === "loan" && c.subject === p.id && (c.state as { outstanding: number }).outstanding > 0);
      if (myLoan && rand() < 0.4) {
        const outstanding = (myLoan.state as { outstanding: number }).outstanding;
        const amount = Math.max(1, Math.min(p.cash, Math.floor(outstanding * (0.2 + rand() * 0.9))));
        if (amount > 0 && p.cash >= amount) out.push({ type: "RepayLoan", player: p.id, loanId: myLoan.id, amount });
      }
      if (rand() < 0.3) {
        for (const [t, prop] of Object.entries(s.properties)) {
          if (prop.owner === p.id) out.push({ type: "Build", player: p.id, tile: Number(t) });
        }
      }
      out.push({ type: "EndTurn", player: p.id });
      return out;
    }
    case "liquidation": {
      const head = s.debts[0];
      const p = s.players[head.debtor];
      const out: Command[] = [];
      if (p.cash >= head.amount) {
        out.push({ type: "SettleDebt", player: p.id });
        return out;
      }
      for (const [t, prop] of Object.entries(s.properties)) {
        if (prop.owner === p.id && prop.houses > 0) out.push({ type: "SellHouse", player: p.id, tile: Number(t) });
      }
      for (const [t, prop] of Object.entries(s.properties)) {
        if (prop.owner === p.id && !prop.mortgaged && mortgageValue(Number(t)) > 0) {
          out.push({ type: "Mortgage", player: p.id, tile: Number(t) });
        }
      }
      out.push({ type: "DeclareBankruptcy", player: p.id });
      out.push({ type: "SettleDebt", player: p.id });
      return out;
    }
  }
}

test("random bots: 25 full games, invariants hold every step (with loans)", { timeout: 180_000 }, () => {
  let sawLoanFlow = false;

  for (let game = 0; game < 25; game++) {
    const seed = 1000 + game * 17;
    const nPlayers = 2 + (game % 3);
    const names = Array.from({ length: nPlayers }, (_, i) => `Bot${i + 1}`);
    const g = Game.create(names, seed);
    const startingTotal = 1500 * nPlayers;
    const rand = mulberry(seed * 7 + 1);

    let bankNet = 0; // bank outflow minus inflow (includes loan principal/interest/repayment)
    let steps = 0;
    const MAX_STEPS = 4000;

    while (g.state.phase !== "gameOver" && steps < MAX_STEPS) {
      const candidates = botCandidates(g, rand);
      assert.ok(candidates.length > 0, `no candidates before gameOver (seed ${seed}, step ${steps})`);

      let accepted = false;
      let lastError = "";
      for (const cmd of candidates) {
        const r = g.apply(cmd);
        if (r.ok) {
          for (const e of r.events) {
            if (e.type === "MoneyTransferred") {
              if (e.from === "bank") bankNet += e.amount;
              if (e.to === "bank") bankNet -= e.amount;
              if (e.reason === "loanPrincipal" || e.reason === "loanInterest" || e.reason === "loanRepayment") {
                sawLoanFlow = true;
              }
            }
          }
          accepted = true;
          break;
        }
        lastError = r.error;
      }
      assert.ok(accepted, `deadlock: every candidate rejected, last error "${lastError}" (seed ${seed}, step ${steps}, phase ${g.state.phase})`);

      const s = g.state;
      let totalCash = 0;
      for (const id of s.order) {
        const p = s.players[id];
        assert.ok(p.cash >= 0, `${id} negative cash ${p.cash} (seed ${seed}, step ${steps})`);
        totalCash += p.cash;
      }
      assert.equal(totalCash, startingTotal + bankNet, `money conservation violated (seed ${seed}, step ${steps})`);
      assert.ok(s.houseSupply >= 0 && s.houseSupply <= 32, `house supply ${s.houseSupply}`);
      assert.ok(s.hotelSupply >= 0 && s.hotelSupply <= 12, `hotel supply ${s.hotelSupply}`);

      // Loan invariant: outstanding principal never exceeds the secured base at the moment of borrowing
      // is enforced by validateCreate; here we just assert no negative outstanding sneaks in.
      for (const c of s.cards) {
        if (c.kind === "loan") {
          const st = c.state as { principal: number; outstanding: number };
          assert.ok(st.outstanding >= 0 && st.outstanding <= st.principal, `loan ${c.id} bad outstanding ${st.outstanding}/${st.principal}`);
        }
      }

      steps++;
    }
  }

  // The bots are stochastic but over 25 games they should exercise the loan path at least once.
  assert.ok(sawLoanFlow, "expected bots to borrow/repay at least once across 25 games");
});

test("replay: folding a finished game's log reproduces the final state", { timeout: 60_000 }, () => {
  const g = Game.create(["A", "B"], 555);
  const rand = mulberry(99);
  for (let i = 0; i < 500 && g.state.phase !== "gameOver"; i++) {
    const candidates = botCandidates(g, rand);
    if (candidates.length === 0) break;
    let ok = false;
    for (const cmd of candidates) {
      if (g.apply(cmd).ok) { ok = true; break; }
    }
    assert.ok(ok, "replay-source game deadlocked");
  }
  const replayed = Game.replay(g.log);
  assert.deepEqual(replayed.state, g.state);
});
/**
 * Smoke test: random bots play complete games. After every command we assert
 * the core invariants:
 *   1. No player's cash is ever negative.
 *   2. Total player cash equals starting cash plus the bank's net outflow
 *      (tracked incrementally from emitted events).
 *   3. House/hotel supplies stay within physical bounds.
 * Bots produce a ranked list of candidate commands; if none is accepted,
 * that's an engine deadlock — fail loudly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Game, type Command } from "../src/core/engine.js";
import { TILES, mortgageValue } from "../src/board/tiles.js";

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ranked candidate commands for whoever must act; first accepted one is used. */
function botCandidates(g: Game, rand: () => number): Command[] {
  const s = g.state;
  switch (s.phase) {
    case "gameOver":
      return [];
    case "awaitRoll": {
      const p = s.players[s.order[s.currentIdx]];
      const out: Command[] = [];
      if (p.inJail) {
        if (p.jailCards.length > 0 && rand() < 0.5) out.push({ type: "UseJailCard", player: p.id });
        else if (p.cash >= 50 && rand() < 0.3) out.push({ type: "PayJailFine", player: p.id });
      }
      out.push({ type: "Roll", player: p.id });
      return out;
    }
    case "awaitPurchase": {
      const p = s.players[s.order[s.currentIdx]];
      const tile = TILES[s.pendingPurchase!];
      const price = "price" in tile ? tile.price : 0;
      const out: Command[] = [];
      if (p.cash >= price && rand() < 0.7) out.push({ type: "BuyProperty", player: p.id });
      out.push({ type: "DeclineBuy", player: p.id });
      return out;
    }
    case "auction": {
      const a = s.auction!;
      const bidder = s.players[a.active[a.turnPtr]];
      const next = a.highBid + 1 + Math.floor(rand() * 50);
      const out: Command[] = [];
      if (next <= bidder.cash && rand() < 0.5) out.push({ type: "Bid", player: bidder.id, amount: next });
      out.push({ type: "PassAuction", player: bidder.id });
      return out;
    }
    case "awaitEnd": {
      const p = s.players[s.order[s.currentIdx]];
      const out: Command[] = [];
      if (rand() < 0.3) {
        for (const [t, prop] of Object.entries(s.properties)) {
          if (prop.owner === p.id) out.push({ type: "Build", player: p.id, tile: Number(t) });
        }
      }
      out.push({ type: "EndTurn", player: p.id });
      return out;
    }
    case "liquidation": {
      const head = s.debts[0];
      const p = s.players[head.debtor];
      const out: Command[] = [];
      if (p.cash >= head.amount) {
        out.push({ type: "SettleDebt", player: p.id });
        return out;
      }
      for (const [t, prop] of Object.entries(s.properties)) {
        if (prop.owner === p.id && prop.houses > 0) out.push({ type: "SellHouse", player: p.id, tile: Number(t) });
      }
      for (const [t, prop] of Object.entries(s.properties)) {
        if (prop.owner === p.id && !prop.mortgaged && mortgageValue(Number(t)) > 0) {
          out.push({ type: "Mortgage", player: p.id, tile: Number(t) });
        }
      }
      out.push({ type: "DeclareBankruptcy", player: p.id });
      // last resort: settle again in case selling above already covered it
      out.push({ type: "SettleDebt", player: p.id });
      return out;
    }
  }
}

test("random bots: 25 full games, invariants hold every step", { timeout: 180_000 }, () => {
  for (let game = 0; game < 25; game++) {
    const seed = 1000 + game * 17;
    const nPlayers = 2 + (game % 3);
    const names = Array.from({ length: nPlayers }, (_, i) => `Bot${i + 1}`);
    const g = Game.create(names, seed);
    const startingTotal = 1500 * nPlayers;
    const rand = mulberry(seed * 7 + 1);

    let bankNet = 0; // incremental: bank outflow minus inflow
    let steps = 0;
    const MAX_STEPS = 3000;

    while (g.state.phase !== "gameOver" && steps < MAX_STEPS) {
      const candidates = botCandidates(g, rand);
      assert.ok(candidates.length > 0, `no candidates before gameOver (seed ${seed}, step ${steps})`);

      let accepted = false;
      let lastError = "";
      for (const cmd of candidates) {
        const r = g.apply(cmd);
        if (r.ok) {
          for (const e of r.events) {
            if (e.type === "MoneyTransferred") {
              if (e.from === "bank") bankNet += e.amount;
              if (e.to === "bank") bankNet -= e.amount;
            }
          }
          accepted = true;
          break;
        }
        lastError = r.error;
      }
      assert.ok(accepted, `deadlock: every candidate rejected, last error "${lastError}" (seed ${seed}, step ${steps}, phase ${g.state.phase})`);

      const s = g.state;
      let totalCash = 0;
      for (const id of s.order) {
        const p = s.players[id];
        assert.ok(p.cash >= 0, `${id} negative cash ${p.cash} (seed ${seed}, step ${steps})`);
        totalCash += p.cash;
      }
      assert.equal(totalCash, startingTotal + bankNet, `money conservation violated (seed ${seed}, step ${steps})`);
      assert.ok(s.houseSupply >= 0 && s.houseSupply <= 32, `house supply ${s.houseSupply}`);
      assert.ok(s.hotelSupply >= 0 && s.hotelSupply <= 12, `hotel supply ${s.hotelSupply}`);

      steps++;
    }
    // Long stalemates are fine (bots don't trade); crashes and deadlocks are not.
  }
});

test("replay: folding a finished game's log reproduces the final state", { timeout: 60_000 }, () => {
  const g = Game.create(["A", "B"], 555);
  const rand = mulberry(99);
  for (let i = 0; i < 400 && g.state.phase !== "gameOver"; i++) {
    const candidates = botCandidates(g, rand);
    if (candidates.length === 0) break;
    let ok = false;
    for (const cmd of candidates) {
      if (g.apply(cmd).ok) { ok = true; break; }
    }
    assert.ok(ok, "replay-source game deadlocked");
  }
  const replayed = Game.replay(g.log);
  assert.deepEqual(replayed.state, g.state);
});
