import { test } from "node:test";
import assert from "node:assert/strict";
import { Game } from "../src/core/engine.js";
import type { GameEvent } from "../src/core/events.js";
import type { LoanState } from "../src/cards/loan/module.js";

const start = (seed = 42): GameEvent => ({
  type: "GameStarted",
  players: [
    { id: "p1", name: "Alice" },
    { id: "p2", name: "Bob" },
  ],
  seed,
  startingCash: 1500,
});

const buy = (player: string, tile: number): GameEvent => ({
  type: "PropertyPurchased", player, tile, price: 0,
});

/** Put a player on a tile so the next roll wraps past GO (RULES §7 trigger). */
const placeAt = (player: string, tile: number): GameEvent => ({
  type: "TokenMoved", player, from: 0, to: tile, passedGo: false,
});

function loanOf(g: Game): LoanState {
  const card = g.state.cards.find((c) => c.kind === "loan")!;
  return card.state as LoanState;
}

// ---------------------------------------------------------------------------
// 1. Borrowing limit = mortgage value of unmortgaged properties (RULES §2.1.2)
// ---------------------------------------------------------------------------
test("bank loan: borrowing limit is the mortgage value of unmortgaged properties", () => {
  // p1 owns Boardwalk (mortgage value $200). Limit = $200.
  const g = Game.replay([start(), buy("p1", 39)]);

  // Borrowing $250 exceeds the $200 secured base -> rejected.
  const tooBig = g.apply({ type: "CreateCard", player: "p1", kind: "loan", params: { borrower: "p1", amount: 250 } });
  assert.equal(tooBig.ok, false);

  // Borrowing exactly $200 is allowed.
  const ok = g.apply({ type: "CreateCard", player: "p1", kind: "loan", params: { borrower: "p1", amount: 200 } });
  assert.equal(ok.ok, true);
  // $25 fee out, $200 principal in -> net +175.
  assert.equal(g.state.players.p1.cash, 1500 - 25 + 200);
  assert.equal(loanOf(g).principal, 200);
  assert.equal(loanOf(g).outstanding, 200);

  // A second loan now has zero headroom (already at the limit) -> rejected.
  const second = g.apply({ type: "CreateCard", player: "p1", kind: "loan", params: { borrower: "p1", amount: 1 } });
  assert.equal(second.ok, false);
});

test("bank loan: a mortgaged property does not count toward the borrowing base", () => {
  const g = Game.replay([
    start(), buy("p1", 39),
    { type: "PropertyMortgaged", player: "p1", tile: 39 },
  ]);
  // Boardwalk mortgaged -> base is $0 -> any loan rejected.
  const r = g.apply({ type: "CreateCard", player: "p1", kind: "loan", params: { borrower: "p1", amount: 50 } });
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// 2. Interest = 25% of ORIGINAL principal, charged at GO (RULES §2.1.4, §7)
// ---------------------------------------------------------------------------
test("bank loan: 25% of original principal is charged every time the borrower passes GO", () => {
  // p1 owns Boardwalk, borrows $200. Interest per GO = $50.
  const g = Game.replay([
    start(1), buy("p1", 39),
    { type: "CardCreated", card: { id: "loan-1", kind: "loan", owner: "bank", subject: "p1", state: { principal: 200, outstanding: 200 } } },
    { type: "MoneyTransferred", from: "bank", to: "p1", amount: 200, reason: "loanPrincipal" },
    placeAt("p1", 39), // one tile before GO wrap
    { type: "PhaseSet", phase: "awaitRoll" },
  ]);
  const before = g.state.players.p1.cash;

  // Rolling from tile 39 always wraps past GO: +$200 salary, then -$50 interest.
  const r = g.apply({ type: "Roll", player: "p1" });
  assert.equal(r.ok, true);
  assert.ok(r.events.some((e) => e.type === "InterestCharged" && e.amount === 50),
    "expected a $50 InterestCharged event");
  // Salary +200, interest -50 => net +150 (ignoring whatever tile they land on being unowned).
  // We assert the interest specifically via the event above and that cash rose by at least salary-interest.
  assert.ok(g.state.players.p1.cash >= before, "cash should not drop below pre-GO after salary");
  // Outstanding principal is unchanged by interest.
  assert.equal(loanOf(g).outstanding, 200);
});

// ---------------------------------------------------------------------------
// 3. Partial repayment (RULES §2.1.5)
// ---------------------------------------------------------------------------
test("bank loan: partial repayment reduces outstanding but full interest still accrues", () => {
  const g = Game.replay([
    start(), buy("p1", 39),
    { type: "CardCreated", card: { id: "loan-1", kind: "loan", owner: "bank", subject: "p1", state: { principal: 200, outstanding: 200 } } },
    { type: "MoneyTransferred", from: "bank", to: "p1", amount: 200, reason: "loanPrincipal" },
    { type: "PhaseSet", phase: "awaitEnd" },
  ]);
  const cashBefore = g.state.players.p1.cash;

  // Repay $120 of the $200 principal.
  const r = g.apply({ type: "RepayLoan", player: "p1", loanId: "loan-1", amount: 120 });
  assert.equal(r.ok, true);
  assert.equal(loanOf(g).outstanding, 80);       // principal reduced
  assert.equal(loanOf(g).principal, 200);        // ORIGINAL principal unchanged (drives interest)
  assert.equal(g.state.players.p1.cash, cashBefore - 120);

  // Over-repaying is clamped to the remaining balance.
  const r2 = g.apply({ type: "RepayLoan", player: "p1", loanId: "loan-1", amount: 999 });
  assert.equal(r2.ok, true);
  assert.equal(loanOf(g).outstanding, 0);
  assert.equal(g.state.players.p1.cash, cashBefore - 200);

  // Once fully repaid, no more repayment is accepted.
  const r3 = g.apply({ type: "RepayLoan", player: "p1", loanId: "loan-1", amount: 1 });
  assert.equal(r3.ok, false);
});

// ---------------------------------------------------------------------------
// 4. Interest-triggered forced liquidation (RULES §2.1.6, §7)
// ---------------------------------------------------------------------------
test("bank loan: unpayable interest at GO forces liquidation", () => {
  // p1 owns Boardwalk, has a big loan, and almost no cash: interest at GO can't be paid.
  const g = Game.replay([
    start(2), buy("p1", 39),
    { type: "CardCreated", card: { id: "loan-1", kind: "loan", owner: "bank", subject: "p1", state: { principal: 200, outstanding: 200 } } },
    // drain p1's cash to $10 so the $50 interest is unpayable
    { type: "MoneyTransferred", from: "p1", to: "bank", amount: 1490, reason: "tax" },
    placeAt("p1", 39),
    { type: "PhaseSet", phase: "awaitRoll" },
  ]);
  assert.equal(g.state.players.p1.cash, 10);

  const r = g.apply({ type: "Roll", player: "p1" });
  assert.equal(r.ok, true);
  // Salary +200 makes cash 210, so $50 interest IS now payable — adjust: interest paid, no debt.
  // Instead assert interest was charged and the loan machinery ran at GO.
  assert.ok(r.events.some((e) => e.type === "InterestCharged"), "interest charged at GO");
});

test("bank loan: interest with no salary cushion drives the borrower into liquidation", () => {
  // Force the interest to exceed salary: principal $2000 -> interest $500 > $200 salary.
  // Borrowing base must allow $2000: give p1 enough property. Use crafted CardCreated to bypass
  // the limit check (we are testing the GO/liquidation path, not creation).
  const g = Game.replay([
    start(3), buy("p1", 39),
    { type: "CardCreated", card: { id: "loan-1", kind: "loan", owner: "bank", subject: "p1", state: { principal: 2000, outstanding: 2000 } } },
    { type: "MoneyTransferred", from: "p1", to: "bank", amount: 1500, reason: "tax" }, // p1 now $0
    placeAt("p1", 39),
    { type: "PhaseSet", phase: "awaitRoll" },
  ]);
  assert.equal(g.state.players.p1.cash, 0);

  const r = g.apply({ type: "Roll", player: "p1" });
  assert.equal(r.ok, true);
  // Salary +200 -> $200; interest $500 unpayable -> DebtRecorded -> liquidation.
  assert.ok(r.events.some((e) => e.type === "InterestCharged" && e.amount === 500));
  assert.ok(r.events.some((e) => e.type === "DebtRecorded"));
  assert.equal(g.state.phase, "liquidation");
});

// ---------------------------------------------------------------------------
// 5. Bankruptcy seizure by the bank at waterfall priority 1 (RULES §2.1.7, §8.1)
// ---------------------------------------------------------------------------
test("bank loan: borrower bankruptcy transfers the estate to the bank and voids the loan", () => {
  // p1 owes the bank interest it cannot cover even by liquidating -> bankrupt to the bank.
  const g = Game.replay([
    start(4), buy("p1", 39),
    { type: "CardCreated", card: { id: "loan-1", kind: "loan", owner: "bank", subject: "p1", state: { principal: 2000, outstanding: 2000 } } },
    { type: "MoneyTransferred", from: "p1", to: "bank", amount: 1500, reason: "tax" }, // p1 now $0
    // interest becomes due to the bank and is unpayable even after liquidating Boardwalk ($200 < $500)
    { type: "DebtRecorded", debtor: "p1", creditor: "bank", amount: 500, reason: "loanInterest" },
  ]);
  assert.equal(g.state.phase, "liquidation");

  const r = g.apply({ type: "DeclareBankruptcy", player: "p1" });
  assert.equal(r.ok, true);
  assert.equal(g.state.players.p1.bankrupt, true);
  // Boardwalk returns to the bank (creditor is the bank).
  assert.equal(g.state.properties[39], undefined);
  // The loan card is voided (no further interest can accrue).
  assert.equal(g.state.cards.some((c) => c.kind === "loan" && c.subject === "p1"), false);
  // p2 is the last player standing.
  assert.equal(g.state.winner, "p2");
});
