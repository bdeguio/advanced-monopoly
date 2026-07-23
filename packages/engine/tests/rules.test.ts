import { test } from "node:test";
import assert from "node:assert/strict";
import { Game, computeRent } from "../src/core/engine.js";
import { project } from "../src/core/state.js";
import type { GameEvent } from "../src/core/events.js";

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

test("street rent: base, monopoly double, houses", () => {
  // Baltic (tile 3) alone: $4
  let s = project([start(), buy("p1", 3)]);
  assert.equal(computeRent(s, 3, 7), 4);
  // Full brown set, unimproved: double base rent
  s = project([start(), buy("p1", 1), buy("p1", 3)]);
  assert.equal(computeRent(s, 3, 7), 8);
  assert.equal(computeRent(s, 1, 7), 4);
  // With 2 houses on Baltic: $60 (set bonus no longer applies)
  s = project([
    start(), buy("p1", 1), buy("p1", 3),
    { type: "HouseBuilt", player: "p1", tile: 3 },
    { type: "HouseBuilt", player: "p1", tile: 1 },
    { type: "HouseBuilt", player: "p1", tile: 3 },
  ]);
  assert.equal(computeRent(s, 3, 7), 60);
});

test("railroad rent scales with count; utility rent uses dice", () => {
  let s = project([start(), buy("p1", 5)]);
  assert.equal(computeRent(s, 5, 7), 25);
  s = project([start(), buy("p1", 5), buy("p1", 15), buy("p1", 25)]);
  assert.equal(computeRent(s, 5, 7), 100);
  assert.equal(computeRent(s, 5, 7, 2), 200); // chance card: double railroad rent
  s = project([start(), buy("p1", 12)]);
  assert.equal(computeRent(s, 12, 9), 36); // one utility: 4x
  s = project([start(), buy("p1", 12), buy("p1", 28)]);
  assert.equal(computeRent(s, 12, 9), 90); // both: 10x
});

test("mortgaged property in the set still counts toward the monopoly double", () => {
  const s = project([
    start(), buy("p1", 1), buy("p1", 3),
    { type: "PropertyMortgaged", player: "p1", tile: 1 },
  ]);
  assert.equal(computeRent(s, 3, 7), 8); // landed tile unmortgaged: still doubled
});

test("building: requires full set, even build, cash; hotel supply mechanics", () => {
  const g = Game.replay([start(), buy("p1", 1), buy("p1", 3)]);
  // build Baltic
  assert.equal(g.apply({ type: "Build", player: "p1", tile: 3 }).ok, true);
  // uneven second build on Baltic rejected
  const r = g.apply({ type: "Build", player: "p1", tile: 3 });
  assert.equal(r.ok, false);
  // build Mediterranean, then Baltic again is fine
  assert.equal(g.apply({ type: "Build", player: "p1", tile: 1 }).ok, true);
  assert.equal(g.apply({ type: "Build", player: "p1", tile: 3 }).ok, true);
  assert.equal(g.state.properties[3].houses, 2);
  assert.equal(g.state.houseSupply, 32 - 3);
  assert.equal(g.state.players.p1.cash, 1500 - 150);
});

test("building to hotel returns four houses to the bank", () => {
  const events: GameEvent[] = [start(), buy("p1", 1), buy("p1", 3)];
  for (let i = 0; i < 4; i++) {
    events.push({ type: "HouseBuilt", player: "p1", tile: 1 });
    events.push({ type: "HouseBuilt", player: "p1", tile: 3 });
  }
  const g = Game.replay(events);
  assert.equal(g.state.houseSupply, 32 - 8);
  const r = g.apply({ type: "Build", player: "p1", tile: 3 }); // 5th = hotel
  assert.equal(r.ok, true);
  assert.equal(g.state.properties[3].houses, 5);
  assert.equal(g.state.hotelSupply, 11);
  assert.equal(g.state.houseSupply, 32 - 8 + 4);
});

test("cannot build on a set containing a mortgaged property", () => {
  const g = Game.replay([
    start(), buy("p1", 1), buy("p1", 3),
    { type: "PropertyMortgaged", player: "p1", tile: 1 },
  ]);
  assert.equal(g.apply({ type: "Build", player: "p1", tile: 3 }).ok, false);
});

test("mortgage pays half price; unmortgage costs 110%", () => {
  const g = Game.replay([start(), buy("p1", 39)]); // Boardwalk, $400
  assert.equal(g.apply({ type: "Mortgage", player: "p1", tile: 39 }).ok, true);
  assert.equal(g.state.players.p1.cash, 1700);
  assert.equal(g.state.properties[39].mortgaged, true);
  assert.equal(g.apply({ type: "Unmortgage", player: "p1", tile: 39 }).ok, true);
  assert.equal(g.state.players.p1.cash, 1700 - 220);
  assert.equal(g.state.properties[39].mortgaged, false);
});

test("jail: paying the fine frees you to roll normally", () => {
  const g = Game.replay([start(), { type: "SentToJail", player: "p1" }]);
  assert.equal(g.state.players.p1.inJail, true);
  const r = g.apply({ type: "PayJailFine", player: "p1" });
  assert.equal(r.ok, true);
  assert.equal(g.state.players.p1.inJail, false);
  assert.equal(g.state.players.p1.cash, 1450);
  assert.equal(g.state.phase, "awaitRoll");
});

test("jail: rolling either escapes on doubles or serves an attempt", () => {
  const g = Game.replay([start(7), { type: "SentToJail", player: "p1" }]);
  const before = g.state.players.p1;
  assert.equal(before.inJail, true);
  const r = g.apply({ type: "Roll", player: "p1" });
  assert.equal(r.ok, true);
  const roll = g.state.lastRoll!;
  if (roll.d1 === roll.d2) {
    assert.equal(g.state.players.p1.inJail, false);
    assert.notEqual(g.state.players.p1.pos, 10);
  } else {
    assert.equal(g.state.players.p1.inJail, true);
    assert.equal(g.state.players.p1.jailAttempts, 1);
    assert.equal(g.state.players.p1.pos, 10);
  }
});

test("auction: decline -> bid -> pass awards property to high bidder", () => {
  const g = Game.replay([
    start(),
    { type: "PurchasePending", player: "p1", tile: 39 },
    { type: "PhaseSet", phase: "awaitPurchase" },
  ]);
  assert.equal(g.apply({ type: "DeclineBuy", player: "p1" }).ok, true);
  assert.equal(g.state.phase, "auction");
  assert.equal(g.apply({ type: "Bid", player: "p1", amount: 50 }).ok, true);
  assert.equal(g.apply({ type: "Bid", player: "p2", amount: 120 }).ok, true);
  assert.equal(g.apply({ type: "PassAuction", player: "p1" }).ok, true);
  assert.equal(g.state.properties[39]?.owner, "p2");
  assert.equal(g.state.players.p2.cash, 1500 - 120);
  assert.equal(g.state.auction, undefined);
});

test("auction: everyone passing abandons the property", () => {
  const g = Game.replay([
    start(),
    { type: "PurchasePending", player: "p1", tile: 5 },
    { type: "PhaseSet", phase: "awaitPurchase" },
  ]);
  g.apply({ type: "DeclineBuy", player: "p1" });
  g.apply({ type: "PassAuction", player: "p1" });
  g.apply({ type: "PassAuction", player: "p2" });
  assert.equal(g.state.properties[5], undefined);
  assert.equal(g.state.auction, undefined);
});

test("liquidation: debtor must raise funds; settling resumes play", () => {
  const g = Game.replay([
    start(), buy("p2", 39),
    { type: "DebtRecorded", debtor: "p2", creditor: "p1", amount: 1600, reason: "rent" },
  ]);
  assert.equal(g.state.phase, "liquidation");
  // can't settle yet
  assert.equal(g.apply({ type: "SettleDebt", player: "p2" }).ok, false);
  // can't declare bankruptcy either: mortgage value covers it
  assert.equal(g.apply({ type: "DeclareBankruptcy", player: "p2" }).ok, false);
  // mortgage Boardwalk (+$200) then settle
  assert.equal(g.apply({ type: "Mortgage", player: "p2", tile: 39 }).ok, true);
  assert.equal(g.apply({ type: "SettleDebt", player: "p2" }).ok, true);
  assert.equal(g.state.phase === "liquidation", false);
  assert.equal(g.state.players.p2.cash, 1500 + 200 - 1600);
  assert.equal(g.state.players.p1.cash, 1500 + 1600);
});

test("bankruptcy: estate transfers to creditor and the game ends", () => {
  const r0 = Game.replay([
    start(), buy("p2", 39),
    { type: "DebtRecorded", debtor: "p2", creditor: "p1", amount: 5000, reason: "rent" },
  ]);
  const r = r0.apply({ type: "DeclareBankruptcy", player: "p2" });
  assert.equal(r.ok, true);
  assert.equal(r0.state.players.p2.bankrupt, true);
  assert.equal(r0.state.players.p1.cash, 1500 + 1500); // whole estate cash
  assert.equal(r0.state.properties[39]?.owner, "p1"); // Boardwalk transfers
  assert.equal(r0.state.winner, "p1");
  assert.equal(r0.state.phase, "gameOver");
});

test("determinism: same seed and commands produce identical logs", () => {
  const run = () => {
    const g = Game.create(["A", "B"], 123);
    g.apply({ type: "Roll", player: "p1" });
    if (g.state.phase === "awaitPurchase") g.apply({ type: "BuyProperty", player: "p1" });
    if (g.state.phase === "awaitEnd") g.apply({ type: "EndTurn", player: "p1" });
    return JSON.stringify(g.log);
  };
  assert.equal(run(), run());
});
