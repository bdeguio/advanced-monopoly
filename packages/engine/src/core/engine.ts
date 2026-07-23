/**
 * Command processor. The UI submits Commands; the engine validates them against
 * the current projection and, if legal, appends events to the log. All rules
 * live here. The reducer (state.ts) stays rule-free.
 *
 * M2: the engine dispatches card lifecycle hooks through CardRegistry. The core
 * movement/rent/jail logic still knows nothing about loans; it only calls the
 * registry at GO (RULES §7) and exposes CreateCard / RepayLoan commands.
 */
import type { Account, GameEvent, PaymentReason, Phase, PlayerId } from "./events.js";
import {
  type GameState, type PlayerState, currentPlayer, alivePlayers, deckCardAt, project, reduce,
} from "./state.js";
import {
  BOARD_SIZE, GO_SALARY, JAIL_FINE, PURCHASABLE, RAILROAD_TILES, TILES, UTILITY_TILES,
  UNMORTGAGE_INTEREST, groupTiles, mortgageValue,
} from "../board/tiles.js";
import { Stream, die } from "../board/rng.js";
import type { DeckCard } from "../board/cards.js";
import { CardRegistry } from "../cards/registry.js";
import type { EngineContext, CardKind } from "../cards/CardModule.js";
import { type LoanState } from "../cards/loan/module.js";

export type Command =
  | { type: "Roll"; player: PlayerId }
  | { type: "PayJailFine"; player: PlayerId }
  | { type: "UseJailCard"; player: PlayerId }
  | { type: "BuyProperty"; player: PlayerId }
  | { type: "DeclineBuy"; player: PlayerId }
  | { type: "Bid"; player: PlayerId; amount: number }
  | { type: "PassAuction"; player: PlayerId }
  | { type: "Build"; player: PlayerId; tile: number }
  | { type: "SellHouse"; player: PlayerId; tile: number }
  | { type: "Mortgage"; player: PlayerId; tile: number }
  | { type: "Unmortgage"; player: PlayerId; tile: number }
  | { type: "SettleDebt"; player: PlayerId }
  | { type: "CreateCard"; player: PlayerId; kind: CardKind; params: unknown }
  | { type: "RepayLoan"; player: PlayerId; loanId: string; amount: number }
  | { type: "DeclareBankruptcy"; player: PlayerId }
  | { type: "EndTurn"; player: PlayerId };

export type Result =
  | { ok: true; events: GameEvent[] }
  | { ok: false; error: string };

const err = (error: string): Result => ({ ok: false, error });

/** Rent owed for landing on pos, given the dice total (utilities) and railroad multiplier. */
export function computeRent(w: GameState, pos: number, diceTotal: number, rrMult = 1): number {
  const tile = TILES[pos];
  const prop = w.properties[pos];
  if (!prop?.owner) return 0;
  if (tile.kind === "street") {
    if (prop.houses > 0) return tile.rent[prop.houses];
    const ownsGroup = groupTiles(tile.group).every((t) => w.properties[t]?.owner === prop.owner);
    return ownsGroup ? tile.rent[0] * 2 : tile.rent[0];
  }
  if (tile.kind === "railroad") {
    const owned = RAILROAD_TILES.filter((t) => w.properties[t]?.owner === prop.owner).length;
    return 25 * 2 ** (owned - 1) * rrMult;
  }
  if (tile.kind === "utility") {
    const owned = UTILITY_TILES.filter((t) => w.properties[t]?.owner === prop.owner).length;
    return diceTotal * (owned === 2 ? 10 : 4);
  }
  return 0;
}

export class Game {
  private events: GameEvent[] = [];
  private _state!: GameState;
  private pending: GameEvent[] = [];
  private work!: GameState;
  private registry = new CardRegistry();

  static create(names: string[], seed: number, startingCash = 1500): Game {
    if (names.length < 2 || names.length > 8) throw new Error("2-8 players required");
    const g = new Game();
    const start: GameEvent = {
      type: "GameStarted",
      players: names.map((name, i) => ({ id: `p${i + 1}`, name })),
      seed, startingCash,
    };
    g.events = [start];
    g._state = project(g.events);
    return g;
  }

  static replay(events: readonly GameEvent[]): Game {
    const g = new Game();
    g.events = [...events];
    g._state = project(g.events);
    return g;
  }

  get state(): GameState { return this._state; }
  get log(): readonly GameEvent[] { return this.events; }

  /** Context passed to card modules. Reads live `work` state; mints event objects. */
  private ctx(): EngineContext {
    return {
      state: this.work,
      nextCardId: (kind) => `${kind}-${this.work.cardSeq + 1}`,
      transfer: (from, to, amount, reason, memo) =>
        ({ type: "MoneyTransferred", from, to, amount, reason, memo }),
    };
  }

  // ---------------------------------------------------------------- plumbing
  private emit(e: GameEvent): void {
    this.pending.push(e);
    this.work = reduce(this.work, e);
  }

  private commit(): Result {
    this.events.push(...this.pending);
    this._state = this.work;
    const events = this.pending;
    this.pending = [];
    return { ok: true, events };
  }

  private pay(from: Account, to: Account, amount: number, reason: PaymentReason, memo?: string): boolean {
    if (amount <= 0) return true;
    if (from !== "bank" && this.work.players[from].cash < amount) {
      this.emit({ type: "DebtRecorded", debtor: from, creditor: to, amount, reason });
      return false;
    }
    this.emit({ type: "MoneyTransferred", from, to, amount, reason, memo });
    return true;
  }

  private finishPhase(): void {
    const w = this.work;
    if (w.winner || w.auction) return;
    if (w.pendingPurchase !== undefined) {
      this.emit({ type: "PhaseSet", phase: "awaitPurchase" });
      return;
    }
    const cur = currentPlayer(w);
    const doublesPending =
      !cur.bankrupt && !cur.inJail &&
      w.lastRoll !== undefined && w.lastRoll.d1 === w.lastRoll.d2 &&
      cur.doublesCount > 0 && cur.doublesCount < 3;
    this.emit({ type: "PhaseSet", phase: doublesPending ? "awaitRoll" : "awaitEnd" });
  }

  // ---------------------------------------------------------------- movement
  private moveTo(p: PlayerId, to: number, passedGo: boolean): void {
    const from = this.work.players[p].pos;
    this.emit({ type: "TokenMoved", player: p, from, to, passedGo });
    if (passedGo) {
      // RULES §7 step 1: collect salary first...
      this.pay("bank", p, GO_SALARY, "salary");
      // ...then resolve card obligations in priority order (loans, then M3+ kinds).
      this.runPassGo(p);
    }
  }

  /** RULES §7: dispatch onPassGo for every card whose subject just passed GO. */
  private runPassGo(p: PlayerId): void {
    const events = this.registry.collectPassGo(this.work, p, this.ctx());
    for (const e of events) {
      if (e.type === "MoneyTransferred") {
        // route through pay() so a shortfall becomes a debt (forced liquidation)
        this.pay(e.from, e.to, e.amount, e.reason, e.memo);
      } else {
        this.emit(e);
      }
    }
  }

  private advanceBy(p: PlayerId, steps: number): void {
    const from = this.work.players[p].pos;
    const to = (from + steps + BOARD_SIZE) % BOARD_SIZE;
    this.moveTo(p, to, steps > 0 && to < from);
  }

  private resolveTile(p: PlayerId, depth = 0): void {
    if (depth > 4) return;
    const w = this.work;
    const pos = w.players[p].pos;
    const tile = TILES[pos];
    switch (tile.kind) {
      case "go":
      case "jail":
      case "freeParking":
        return;
      case "goToJail":
        this.emit({ type: "SentToJail", player: p });
        return;
      case "tax":
        this.pay(p, "bank", tile.amount, "tax", tile.name);
        return;
      case "chance":
        this.drawCard(p, "chance", depth);
        return;
      case "chest":
        this.drawCard(p, "chest", depth);
        return;
      case "street":
      case "railroad":
      case "utility": {
        const prop = w.properties[pos];
        if (!prop || prop.owner === undefined) {
          this.emit({ type: "PurchasePending", player: p, tile: pos });
          return;
        }
        if (prop.owner === p || prop.mortgaged) return;
        const rent = this.rentFor(pos, w.lastRoll ? w.lastRoll.d1 + w.lastRoll.d2 : 7);
        this.pay(p, prop.owner, rent, "rent", TILES[pos].name);
        return;
      }
    }
  }

  private rentFor(pos: number, diceTotal: number, rrMult = 1): number {
    return computeRent(this.work, pos, diceTotal, rrMult);
  }

  // ---------------------------------------------------------------- deck cards
  private drawCard(p: PlayerId, deck: "chance" | "chest", depth: number): void {
    const w = this.work;
    let cursor = deck === "chance" ? w.chanceCursor : w.chestCursor;
    let card: DeckCard = deckCardAt(w, deck, cursor);
    while (card.effect === "getOutOfJail" && w.jailCardsOut[deck]) {
      cursor++;
      card = deckCardAt(w, deck, cursor);
    }
    this.emit({ type: "CardDrawn", player: p, deck, cardId: card.id, text: card.text });
    this.applyCard(p, deck, card, depth);
  }

  private applyCard(p: PlayerId, deck: "chance" | "chest", card: DeckCard, depth: number): void {
    const w = this.work;
    switch (card.effect) {
      case "advance": {
        const from = w.players[p].pos;
        this.moveTo(p, card.to, card.to <= from);
        this.resolveTile(p, depth + 1);
        return;
      }
      case "advanceNearest": {
        const tiles = card.target === "railroad" ? RAILROAD_TILES : UTILITY_TILES;
        const from = w.players[p].pos;
        const to = tiles.find((t) => t > from) ?? tiles[0];
        this.moveTo(p, to, to <= from);
        const prop = this.work.properties[to];
        if (!prop || prop.owner === undefined) {
          this.emit({ type: "PurchasePending", player: p, tile: to });
          return;
        }
        if (prop.owner === p || prop.mortgaged) return;
        if (card.target === "railroad") {
          const rent = this.rentFor(to, 0, 2);
          this.pay(p, prop.owner, rent, "rent", `${TILES[to].name} (double rent)`);
        } else {
          const d1 = die(w.seed, Stream.UtilityRoll, this.work.utilCursor);
          const d2 = die(w.seed, Stream.UtilityRoll, this.work.utilCursor + 1);
          this.emit({ type: "UtilityRolled", player: p, d1, d2 });
          this.pay(p, prop.owner, (d1 + d2) * 10, "rent", `${TILES[to].name} (10x roll ${d1}+${d2})`);
        }
        return;
      }
      case "goBack": {
        const from = w.players[p].pos;
        this.moveTo(p, (from - card.spaces + BOARD_SIZE) % BOARD_SIZE, false);
        this.resolveTile(p, depth + 1);
        return;
      }
      case "goToJail":
        this.emit({ type: "SentToJail", player: p });
        return;
      case "getOutOfJail":
        this.emit({ type: "JailCardGranted", player: p, deck });
        return;
      case "collect":
        this.pay("bank", p, card.amount, "card", card.id);
        return;
      case "pay":
        this.pay(p, "bank", card.amount, "card", card.id);
        return;
      case "collectFromEach":
        for (const other of alivePlayers(w)) {
          if (other.id !== p) this.pay(other.id, p, card.amount, "card", card.id);
        }
        return;
      case "payEach":
        for (const other of alivePlayers(w)) {
          if (other.id !== p) this.pay(p, other.id, card.amount, "card", card.id);
        }
        return;
      case "repairs": {
        let cost = 0;
        for (const [t, prop] of Object.entries(this.work.properties)) {
          if (prop.owner !== p) continue;
          void t;
          cost += prop.houses === 5 ? card.perHotel : prop.houses * card.perHouse;
        }
        this.pay(p, "bank", cost, "card", card.id);
        return;
      }
    }
  }

  // ---------------------------------------------------------------- helpers
  private liquidationValue(p: PlayerId): number {
    const w = this.work;
    let total = w.players[p].cash;
    for (const [t, prop] of Object.entries(w.properties)) {
      if (prop.owner !== p) continue;
      const tileIdx = Number(t);
      const tile = TILES[tileIdx];
      if (tile.kind === "street" && prop.houses > 0) {
        const units = prop.houses === 5 ? 5 : prop.houses;
        total += (units * tile.houseCost) / 2;
      }
      if (!prop.mortgaged) total += mortgageValue(tileIdx);
    }
    return total;
  }

  private totalDebtsOf(p: PlayerId): number {
    return this.work.debts.filter((d) => d.debtor === p).reduce((a, d) => a + d.amount, 0);
  }

  private managementAllowed(p: PlayerId): string | null {
    const w = this.work;
    if (w.phase === "liquidation") {
      const head = w.debts[0];
      if (!head || head.debtor !== p) return "Only the indebted player may act during liquidation";
      return null;
    }
    if (w.phase === "awaitRoll" || w.phase === "awaitEnd" || w.phase === "awaitPurchase") {
      if (currentPlayer(w).id !== p) return "Not your turn";
      return null;
    }
    return `Not allowed during ${w.phase}`;
  }

  private checkWinner(): void {
    const alive = alivePlayers(this.work);
    if (alive.length === 1 && !this.work.winner) {
      this.emit({ type: "GameEnded", winner: alive[0].id });
    }
  }

  // ---------------------------------------------------------------- commands
  apply(cmd: Command): Result {
    this.pending = [];
    this.work = this._state;
    const w = this.work;
    if (w.phase === "gameOver") return err("Game is over");
    const player = w.players[cmd.player];
    if (!player) return err(`Unknown player ${cmd.player}`);
    if (player.bankrupt) return err("You are bankrupt");

    switch (cmd.type) {
      case "Roll": return this.cmdRoll(cmd.player);
      case "PayJailFine": return this.cmdPayJailFine(cmd.player);
      case "UseJailCard": return this.cmdUseJailCard(cmd.player);
      case "BuyProperty": return this.cmdBuy(cmd.player);
      case "DeclineBuy": return this.cmdDecline(cmd.player);
      case "Bid": return this.cmdBid(cmd.player, cmd.amount);
      case "PassAuction": return this.cmdPassAuction(cmd.player);
      case "Build": return this.cmdBuild(cmd.player, cmd.tile);
      case "SellHouse": return this.cmdSellHouse(cmd.player, cmd.tile);
      case "Mortgage": return this.cmdMortgage(cmd.player, cmd.tile);
      case "Unmortgage": return this.cmdUnmortgage(cmd.player, cmd.tile);
      case "SettleDebt": return this.cmdSettleDebt(cmd.player);
      case "CreateCard": return this.cmdCreateCard(cmd.player, cmd.kind, cmd.params);
      case "RepayLoan": return this.cmdRepayLoan(cmd.player, cmd.loanId, cmd.amount);
      case "DeclareBankruptcy": return this.cmdBankruptcy(cmd.player);
      case "EndTurn": return this.cmdEndTurn(cmd.player);
    }
  }

  private cmdRoll(p: PlayerId): Result {
    const w = this.work;
    if (w.phase !== "awaitRoll") return err(`Cannot roll during ${w.phase}`);
    if (currentPlayer(w).id !== p) return err("Not your turn");

    const d1 = die(w.seed, Stream.Dice, w.diceCursor);
    const d2 = die(w.seed, Stream.Dice, w.diceCursor + 1);
    this.emit({ type: "DiceRolled", player: p, d1, d2 });
    const me = this.work.players[p];

    if (me.inJail) {
      if (d1 === d2) {
        this.emit({ type: "LeftJail", player: p, via: "doubles" });
        this.work.players[p].doublesCount = 0;
        this.advanceBy(p, d1 + d2);
        this.resolveTile(p);
        if (!this.work.pendingPurchase && !this.work.auction && !this.work.winner) {
          this.emit({ type: "PhaseSet", phase: "awaitEnd" });
          return this.commit();
        }
        this.finishPhase();
        return this.commit();
      }
      const attempt = me.jailAttempts + 1;
      this.emit({ type: "JailTurnServed", player: p, attempt });
      if (attempt >= 3) {
        this.pay(p, "bank", JAIL_FINE, "jailFine");
        this.emit({ type: "LeftJail", player: p, via: "forcedFine" });
        this.advanceBy(p, d1 + d2);
        this.resolveTile(p);
        if (!this.work.pendingPurchase && !this.work.auction && !this.work.winner) {
          this.emit({ type: "PhaseSet", phase: "awaitEnd" });
          return this.commit();
        }
        this.finishPhase();
        return this.commit();
      }
      this.emit({ type: "PhaseSet", phase: "awaitEnd" });
      return this.commit();
    }

    if (this.work.players[p].doublesCount >= 3) {
      this.emit({ type: "SpeedingToJail", player: p });
      this.emit({ type: "SentToJail", player: p });
      this.emit({ type: "PhaseSet", phase: "awaitEnd" });
      return this.commit();
    }

    this.advanceBy(p, d1 + d2);
    this.resolveTile(p);
    this.finishPhase();
    return this.commit();
  }

  private cmdPayJailFine(p: PlayerId): Result {
    const w = this.work;
    if (w.phase !== "awaitRoll") return err("Can only pay the fine before rolling");
    if (currentPlayer(w).id !== p) return err("Not your turn");
    if (!w.players[p].inJail) return err("You are not in jail");
    if (w.players[p].cash < JAIL_FINE) return err(`Need $${JAIL_FINE}`);
    this.pay(p, "bank", JAIL_FINE, "jailFine");
    this.emit({ type: "LeftJail", player: p, via: "fine" });
    this.emit({ type: "PhaseSet", phase: "awaitRoll" });
    return this.commit();
  }

  private cmdUseJailCard(p: PlayerId): Result {
    const w = this.work;
    if (w.phase !== "awaitRoll") return err("Can only use the card before rolling");
    if (currentPlayer(w).id !== p) return err("Not your turn");
    if (!w.players[p].inJail) return err("You are not in jail");
    const deck = w.players[p].jailCards[0];
    if (!deck) return err("You have no Get Out of Jail Free card");
    this.emit({ type: "JailCardUsed", player: p, deck });
    this.emit({ type: "LeftJail", player: p, via: "card" });
    this.emit({ type: "PhaseSet", phase: "awaitRoll" });
    return this.commit();
  }

  private cmdBuy(p: PlayerId): Result {
    const w = this.work;
    if (w.phase !== "awaitPurchase") return err("Nothing to buy");
    if (currentPlayer(w).id !== p) return err("Not your turn");
    const tileIdx = w.pendingPurchase!;
    const tile = TILES[tileIdx];
    if (tile.kind !== "street" && tile.kind !== "railroad" && tile.kind !== "utility") {
      return err("Tile is not purchasable");
    }
    if (w.players[p].cash < tile.price) {
      return err(`Need $${tile.price} (mortgage or sell first, or decline to auction)`);
    }
    this.emit({ type: "MoneyTransferred", from: p, to: "bank", amount: tile.price, reason: "purchase", memo: tile.name });
    this.emit({ type: "PropertyPurchased", player: p, tile: tileIdx, price: tile.price });
    this.finishPhase();
    return this.commit();
  }

  private cmdDecline(p: PlayerId): Result {
    const w = this.work;
    if (w.phase !== "awaitPurchase") return err("Nothing to decline");
    if (currentPlayer(w).id !== p) return err("Not your turn");
    const tileIdx = w.pendingPurchase!;
    this.emit({ type: "PurchaseDeclined", player: p, tile: tileIdx });
    const bidders = alivePlayers(this.work).map((x) => x.id);
    this.emit({ type: "AuctionStarted", tile: tileIdx, bidders });
    return this.commit();
  }

  private auctionTryEnd(): void {
    const a = this.work.auction;
    if (!a) return;
    if (a.active.length === 0) {
      this.emit({ type: "AuctionAbandoned", tile: a.tile });
      this.finishPhase();
      return;
    }
    if (a.active.length === 1 && a.highBidder === a.active[0]) {
      const winner = a.active[0];
      const tile = a.tile;
      const price = a.highBid;
      this.emit({ type: "MoneyTransferred", from: winner, to: "bank", amount: price, reason: "auction", memo: TILES[tile].name });
      this.emit({ type: "AuctionWon", player: winner, tile, price });
      this.finishPhase();
    }
  }

  private cmdBid(p: PlayerId, amount: number): Result {
    const w = this.work;
    if (w.phase !== "auction" || !w.auction) return err("No auction in progress");
    const a = w.auction;
    if (a.active[a.turnPtr] !== p) return err("Not your bid");
    if (!Number.isInteger(amount) || amount <= a.highBid) return err(`Bid must exceed $${a.highBid}`);
    if (amount > w.players[p].cash) return err("You cannot bid more cash than you have");
    this.emit({ type: "BidPlaced", player: p, amount });
    this.auctionTryEnd();
    return this.commit();
  }

  private cmdPassAuction(p: PlayerId): Result {
    const w = this.work;
    if (w.phase !== "auction" || !w.auction) return err("No auction in progress");
    const a = w.auction;
    if (a.active[a.turnPtr] !== p) return err("Not your bid");
    this.emit({ type: "AuctionPassed", player: p });
    this.auctionTryEnd();
    return this.commit();
  }

  private cmdBuild(p: PlayerId, tileIdx: number): Result {
    const gate = this.managementAllowed(p);
    if (gate) return err(gate);
    if (this.work.phase === "liquidation") return err("Cannot build while settling debts");
    const w = this.work;
    const tile = TILES[tileIdx];
    if (tile.kind !== "street") return err("Can only build on streets");
    const prop = w.properties[tileIdx];
    if (prop?.owner !== p) return err("You do not own this property");
    const group = groupTiles(tile.group);
    if (!group.every((t) => w.properties[t]?.owner === p)) return err("You need the full color set");
    if (group.some((t) => w.properties[t]!.mortgaged)) return err("Unmortgage the whole set first");
    if (prop.houses >= 5) return err("Already has a hotel");
    const minHouses = Math.min(...group.map((t) => w.properties[t]!.houses));
    if (prop.houses > minHouses) return err("Build evenly across the set");
    const buildingHotel = prop.houses === 4;
    if (buildingHotel && w.hotelSupply < 1) return err("No hotels left in the bank");
    if (!buildingHotel && w.houseSupply < 1) return err("No houses left in the bank");
    if (w.players[p].cash < tile.houseCost) return err(`Need $${tile.houseCost}`);
    this.emit({ type: "MoneyTransferred", from: p, to: "bank", amount: tile.houseCost, reason: "houseBuild", memo: tile.name });
    this.emit({ type: "HouseBuilt", player: p, tile: tileIdx });
    return this.commit();
  }

  private cmdSellHouse(p: PlayerId, tileIdx: number): Result {
    const gate = this.managementAllowed(p);
    if (gate) return err(gate);
    const w = this.work;
    const tile = TILES[tileIdx];
    if (tile.kind !== "street") return err("No buildings there");
    const prop = w.properties[tileIdx];
    if (prop?.owner !== p) return err("You do not own this property");
    if (prop.houses === 0) return err("Nothing to sell");
    const group = groupTiles(tile.group);
    const maxHouses = Math.max(...group.map((t) => w.properties[t]!.houses));
    if (prop.houses < maxHouses) return err("Sell evenly across the set");
    if (prop.houses === 5 && w.houseSupply < 4) return err("Bank lacks 4 houses to break the hotel");
    this.emit({ type: "HouseSold", player: p, tile: tileIdx });
    this.emit({ type: "MoneyTransferred", from: "bank", to: p, amount: tile.houseCost / 2, reason: "houseSale", memo: tile.name });
    return this.commit();
  }

  private cmdMortgage(p: PlayerId, tileIdx: number): Result {
    const gate = this.managementAllowed(p);
    if (gate) return err(gate);
    const w = this.work;
    const prop = w.properties[tileIdx];
    if (prop?.owner !== p) return err("You do not own this property");
    if (prop.mortgaged) return err("Already mortgaged");
    const tile = TILES[tileIdx];
    if (tile.kind === "street") {
      const group = groupTiles(tile.group);
      if (group.some((t) => (w.properties[t]?.houses ?? 0) > 0)) {
        return err("Sell all buildings in the set first");
      }
    }
    this.emit({ type: "PropertyMortgaged", player: p, tile: tileIdx });
    this.emit({ type: "MoneyTransferred", from: "bank", to: p, amount: mortgageValue(tileIdx), reason: "mortgage", memo: TILES[tileIdx].name });
    return this.commit();
  }

  private cmdUnmortgage(p: PlayerId, tileIdx: number): Result {
    const gate = this.managementAllowed(p);
    if (gate) return err(gate);
    if (this.work.phase === "liquidation") return err("Cannot unmortgage while settling debts");
    const w = this.work;
    const prop = w.properties[tileIdx];
    if (prop?.owner !== p) return err("You do not own this property");
    if (!prop.mortgaged) return err("Not mortgaged");
    const cost = Math.ceil((mortgageValue(tileIdx) * (10 + UNMORTGAGE_INTEREST * 10)) / 10);
    if (w.players[p].cash < cost) return err(`Need $${cost}`);
    this.emit({ type: "MoneyTransferred", from: p, to: "bank", amount: cost, reason: "unmortgage", memo: TILES[tileIdx].name });
    this.emit({ type: "PropertyUnmortgaged", player: p, tile: tileIdx });
    return this.commit();
  }

  // ---------------------------------------------------------------- M2 card commands
  private cmdCreateCard(p: PlayerId, kind: CardKind, params: unknown): Result {
    const w = this.work;
    // Cards may only be created on your own turn (RULES §1.1.3), not mid-obligation.
    if (w.phase !== "awaitRoll" && w.phase !== "awaitEnd") {
      return err(`cannot create a card during ${w.phase}`);
    }
    if (currentPlayer(w).id !== p) return err("Not your turn");
    const v = this.registry.validateCreate(kind, params, w);
    if (!v.ok) return err(v.error!);
    for (const e of this.registry.onCreate(kind, params, this.ctx())) this.emit(e);
    return this.commit();
  }

  private cmdRepayLoan(p: PlayerId, loanId: string, amount: number): Result {
    const w = this.work;
    if (w.phase !== "awaitRoll" && w.phase !== "awaitEnd") {
      return err(`cannot repay during ${w.phase}`);
    }
    if (currentPlayer(w).id !== p) return err("Not your turn");
    const card = w.cards.find((c) => c.id === loanId && c.kind === "loan");
    if (!card) return err("no such loan");
    if (card.subject !== p) return err("not your loan");
    const st = card.state as LoanState;
    if (st.outstanding <= 0) return err("loan already repaid");
    if (!Number.isInteger(amount) || amount <= 0) return err("repayment must be a positive integer");
    const payAmt = Math.min(amount, st.outstanding); // partial repayment allowed (§2.1.5)
    if (w.players[p].cash < payAmt) return err(`Need $${payAmt}`);
    const remaining = st.outstanding - payAmt;
    this.emit({ type: "MoneyTransferred", from: p, to: card.owner, amount: payAmt, reason: "loanRepayment", memo: `loan ${loanId}` });
    this.emit({ type: "LoanRepaid", loanId, amount: payAmt, remaining });
    return this.commit();
  }

  private cmdSettleDebt(p: PlayerId): Result {
    const w = this.work;
    if (w.phase !== "liquidation") return err("No debts to settle");
    const head = w.debts[0];
    if (head.debtor !== p) return err("The head debt is not yours");
    if (w.players[p].cash < head.amount) return err(`Need $${head.amount} — sell or mortgage first`);
    this.emit({ type: "MoneyTransferred", from: p, to: head.creditor, amount: head.amount, reason: "debtSettlement", memo: head.reason });
    this.emit({ type: "DebtSettled", debtor: p, creditor: head.creditor, amount: head.amount });
    return this.commit();
  }

  private cmdBankruptcy(p: PlayerId): Result {
    const w = this.work;
    if (w.phase !== "liquidation") return err("You have no unpayable debt");
    const head = w.debts[0];
    if (head.debtor !== p) return err("The head debt is not yours");
    if (this.liquidationValue(p) >= this.totalDebtsOf(p)) {
      return err("You can still raise the money — sell and mortgage instead");
    }
    const creditor = head.creditor;

    // 1. Sell all buildings (proceeds join the estate).
    for (const [t, prop] of Object.entries(this.work.properties)) {
      if (prop.owner !== p) continue;
      const tileIdx = Number(t);
      const tile = TILES[tileIdx];
      if (tile.kind !== "street") continue;
      while (this.work.properties[tileIdx].houses > 0) {
        this.emit({ type: "HouseSold", player: p, tile: tileIdx });
        this.emit({ type: "MoneyTransferred", from: "bank", to: p, amount: tile.houseCost / 2, reason: "houseSale", memo: `${tile.name} (bankruptcy)` });
      }
    }

    // 2. Hand every remaining dollar to the creditor (waterfall priority 1 = bank loan).
    const estateCash = this.work.players[p].cash;
    if (estateCash > 0) {
      this.emit({ type: "MoneyTransferred", from: p, to: creditor, amount: estateCash, reason: "bankruptcyTransfer" });
    }

    // 3. Transfer properties.
    for (const [t, prop] of Object.entries(this.work.properties)) {
      if (prop.owner !== p) continue;
      this.emit({ type: "PropertyTransferred", tile: Number(t), from: p, to: creditor, mortgaged: prop.mortgaged });
    }

    // 4. Mark bankrupt (clears debts; PlayerBankrupted reducer voids the borrower's loans).
    this.emit({ type: "PlayerBankrupted", player: p, creditor });
    this.checkWinner();

    if (!this.work.winner) {
      if (currentPlayer(this.work).id === p) {
        this.emit({ type: "TurnEnded", player: p });
        const next = currentPlayer(this.work);
        this.emit({ type: "TurnStarted", player: next.id, turn: this.work.turn + 1 });
      } else if (this.work.debts.length === 0) {
        this.finishPhase();
      }
    }
    return this.commit();
  }

  private cmdEndTurn(p: PlayerId): Result {
    const w = this.work;
    if (w.phase !== "awaitEnd") return err(`Cannot end turn during ${w.phase}`);
    if (currentPlayer(w).id !== p) return err("Not your turn");
    this.emit({ type: "TurnEnded", player: p });
    const next = currentPlayer(this.work);
    this.emit({ type: "TurnStarted", player: next.id, turn: this.work.turn + 1 });
    return this.commit();
  }
}
/**
 * Command processor. The UI submits Commands; the engine validates them against
 * the current projection and, if legal, appends events to the log. All rules
 * live here. The reducer (state.ts) stays rule-free.
 */
import type { Account, GameEvent, PaymentReason, Phase, PlayerId } from "./events.js";
import {
  type GameState, type PlayerState, currentPlayer, alivePlayers, deckCardAt, project, reduce,
} from "./state.js";
import {
  BOARD_SIZE, GO_SALARY, JAIL_FINE, PURCHASABLE, RAILROAD_TILES, TILES, UTILITY_TILES,
  UNMORTGAGE_INTEREST, groupTiles, mortgageValue,
} from "../board/tiles.js";
import { Stream, die } from "../board/rng.js";
import type { DeckCard } from "../board/cards.js";

export type Command =
  | { type: "Roll"; player: PlayerId }
  | { type: "PayJailFine"; player: PlayerId }
  | { type: "UseJailCard"; player: PlayerId }
  | { type: "BuyProperty"; player: PlayerId }
  | { type: "DeclineBuy"; player: PlayerId }
  | { type: "Bid"; player: PlayerId; amount: number }
  | { type: "PassAuction"; player: PlayerId }
  | { type: "Build"; player: PlayerId; tile: number }
  | { type: "SellHouse"; player: PlayerId; tile: number }
  | { type: "Mortgage"; player: PlayerId; tile: number }
  | { type: "Unmortgage"; player: PlayerId; tile: number }
  | { type: "SettleDebt"; player: PlayerId }
  | { type: "DeclareBankruptcy"; player: PlayerId }
  | { type: "EndTurn"; player: PlayerId };

export type Result =
  | { ok: true; events: GameEvent[] }
  | { ok: false; error: string };

const err = (error: string): Result => ({ ok: false, error });

/** Rent owed for landing on pos, given the dice total (utilities) and railroad multiplier. */
export function computeRent(w: GameState, pos: number, diceTotal: number, rrMult = 1): number {
  const tile = TILES[pos];
  const prop = w.properties[pos];
  if (!prop?.owner) return 0;
  if (tile.kind === "street") {
    if (prop.houses > 0) return tile.rent[prop.houses];
    const ownsGroup = groupTiles(tile.group).every((t) => w.properties[t]?.owner === prop.owner);
    return ownsGroup ? tile.rent[0] * 2 : tile.rent[0];
  }
  if (tile.kind === "railroad") {
    const owned = RAILROAD_TILES.filter((t) => w.properties[t]?.owner === prop.owner).length;
    return 25 * 2 ** (owned - 1) * rrMult;
  }
  if (tile.kind === "utility") {
    const owned = UTILITY_TILES.filter((t) => w.properties[t]?.owner === prop.owner).length;
    return diceTotal * (owned === 2 ? 10 : 4);
  }
  return 0;
}

export class Game {
  private events: GameEvent[] = [];
  private _state!: GameState;
  /** Working buffers during command processing. */
  private pending: GameEvent[] = [];
  private work!: GameState;

  static create(names: string[], seed: number, startingCash = 1500): Game {
    if (names.length < 2 || names.length > 8) throw new Error("2-8 players required");
    const g = new Game();
    const start: GameEvent = {
      type: "GameStarted",
      players: names.map((name, i) => ({ id: `p${i + 1}`, name })),
      seed, startingCash,
    };
    g.events = [start];
    g._state = project(g.events);
    return g;
  }

  static replay(events: readonly GameEvent[]): Game {
    const g = new Game();
    g.events = [...events];
    g._state = project(g.events);
    return g;
  }

  get state(): GameState { return this._state; }
  get log(): readonly GameEvent[] { return this.events; }

  // ---------------------------------------------------------------- plumbing
  private emit(e: GameEvent): void {
    this.pending.push(e);
    this.work = reduce(this.work, e);
  }

  private commit(): Result {
    this.events.push(...this.pending);
    this._state = this.work;
    const events = this.pending;
    this.pending = [];
    return { ok: true, events };
  }

  /**
   * Attempt a payment. If the payer lacks cash, the shortfall becomes a debt
   * (full amount owed; nothing partial is transferred) and play enters
   * liquidation once the current command finishes processing.
   */
  private pay(from: Account, to: Account, amount: number, reason: PaymentReason, memo?: string): boolean {
    if (amount <= 0) return true;
    if (from !== "bank" && this.work.players[from].cash < amount) {
      this.emit({ type: "DebtRecorded", debtor: from, creditor: to, amount, reason });
      return false;
    }
    this.emit({ type: "MoneyTransferred", from, to, amount, reason, memo });
    return true;
  }

  /** Phase to land in after a roll/purchase/auction fully resolves. */
  private finishPhase(): void {
    const w = this.work;
    if (w.winner || w.auction) return; // GameEnded / AuctionStarted set phase already
    if (w.pendingPurchase !== undefined) {
      this.emit({ type: "PhaseSet", phase: "awaitPurchase" });
      return;
    }
    const cur = currentPlayer(w);
    const doublesPending =
      !cur.bankrupt && !cur.inJail &&
      w.lastRoll !== undefined && w.lastRoll.d1 === w.lastRoll.d2 &&
      cur.doublesCount > 0 && cur.doublesCount < 3;
    this.emit({ type: "PhaseSet", phase: doublesPending ? "awaitRoll" : "awaitEnd" });
  }

  // ---------------------------------------------------------------- movement
  private moveTo(p: PlayerId, to: number, passedGo: boolean): void {
    const from = this.work.players[p].pos;
    this.emit({ type: "TokenMoved", player: p, from, to, passedGo });
    if (passedGo) this.pay("bank", p, GO_SALARY, "salary");
  }

  private advanceBy(p: PlayerId, steps: number): void {
    const from = this.work.players[p].pos;
    const to = (from + steps + BOARD_SIZE) % BOARD_SIZE;
    // forward movement passes GO iff the position wrapped
    this.moveTo(p, to, steps > 0 && to < from);
  }

  private resolveTile(p: PlayerId, depth = 0): void {
    if (depth > 4) return; // safety against pathological card chains
    const w = this.work;
    const pos = w.players[p].pos;
    const tile = TILES[pos];
    switch (tile.kind) {
      case "go":
      case "jail":
      case "freeParking":
        return;
      case "goToJail":
        this.emit({ type: "SentToJail", player: p });
        return;
      case "tax":
        this.pay(p, "bank", tile.amount, "tax", tile.name);
        return;
      case "chance":
        this.drawCard(p, "chance", depth);
        return;
      case "chest":
        this.drawCard(p, "chest", depth);
        return;
      case "street":
      case "railroad":
      case "utility": {
        const prop = w.properties[pos];
        if (!prop || prop.owner === undefined) {
          this.emit({ type: "PurchasePending", player: p, tile: pos });
          return;
        }
        if (prop.owner === p || prop.mortgaged) return;
        const rent = this.rentFor(pos, w.lastRoll ? w.lastRoll.d1 + w.lastRoll.d2 : 7);
        this.pay(p, prop.owner, rent, "rent", TILES[pos].name);
        return;
      }
    }
  }

  private rentFor(pos: number, diceTotal: number, rrMult = 1): number {
    return computeRent(this.work, pos, diceTotal, rrMult);
  }

  // ---------------------------------------------------------------- cards
  private drawCard(p: PlayerId, deck: "chance" | "chest", depth: number): void {
    const w = this.work;
    // peek forward, skipping a GOJF card that is currently held by a player
    let cursor = deck === "chance" ? w.chanceCursor : w.chestCursor;
    let card: DeckCard = deckCardAt(w, deck, cursor);
    while (card.effect === "getOutOfJail" && w.jailCardsOut[deck]) {
      cursor++;
      card = deckCardAt(w, deck, cursor);
    }
    this.emit({ type: "CardDrawn", player: p, deck, cardId: card.id, text: card.text });
    this.applyCard(p, deck, card, depth);
  }

  private applyCard(p: PlayerId, deck: "chance" | "chest", card: DeckCard, depth: number): void {
    const w = this.work;
    switch (card.effect) {
      case "advance": {
        const from = w.players[p].pos;
        this.moveTo(p, card.to, card.to <= from); // advancing forward; wrap => passed GO
        this.resolveTile(p, depth + 1);
        return;
      }
      case "advanceNearest": {
        const tiles = card.target === "railroad" ? RAILROAD_TILES : UTILITY_TILES;
        const from = w.players[p].pos;
        const to = tiles.find((t) => t > from) ?? tiles[0];
        this.moveTo(p, to, to <= from);
        const prop = this.work.properties[to];
        if (!prop || prop.owner === undefined) {
          this.emit({ type: "PurchasePending", player: p, tile: to });
          return;
        }
        if (prop.owner === p || prop.mortgaged) return;
        if (card.target === "railroad") {
          const rent = this.rentFor(to, 0, 2); // double railroad rent
          this.pay(p, prop.owner, rent, "rent", `${TILES[to].name} (double rent)`);
        } else {
          const d1 = die(w.seed, Stream.UtilityRoll, this.work.utilCursor);
          const d2 = die(w.seed, Stream.UtilityRoll, this.work.utilCursor + 1);
          this.emit({ type: "UtilityRolled", player: p, d1, d2 });
          this.pay(p, prop.owner, (d1 + d2) * 10, "rent", `${TILES[to].name} (10x roll ${d1}+${d2})`);
        }
        return;
      }
      case "goBack": {
        const from = w.players[p].pos;
        this.moveTo(p, (from - card.spaces + BOARD_SIZE) % BOARD_SIZE, false);
        this.resolveTile(p, depth + 1);
        return;
      }
      case "goToJail":
        this.emit({ type: "SentToJail", player: p });
        return;
      case "getOutOfJail":
        this.emit({ type: "JailCardGranted", player: p, deck });
        return;
      case "collect":
        this.pay("bank", p, card.amount, "card", card.id);
        return;
      case "pay":
        this.pay(p, "bank", card.amount, "card", card.id);
        return;
      case "collectFromEach":
        for (const other of alivePlayers(w)) {
          if (other.id !== p) this.pay(other.id, p, card.amount, "card", card.id);
        }
        return;
      case "payEach":
        for (const other of alivePlayers(w)) {
          if (other.id !== p) this.pay(p, other.id, card.amount, "card", card.id);
        }
        return;
      case "repairs": {
        let cost = 0;
        for (const [t, prop] of Object.entries(this.work.properties)) {
          if (prop.owner !== p) continue;
          void t;
          cost += prop.houses === 5 ? card.perHotel : prop.houses * card.perHouse;
        }
        this.pay(p, "bank", cost, "card", card.id);
        return;
      }
    }
  }

  // ---------------------------------------------------------------- helpers
  /** Everything a player could raise by selling all houses and mortgaging everything. */
  private liquidationValue(p: PlayerId): number {
    const w = this.work;
    let total = w.players[p].cash;
    for (const [t, prop] of Object.entries(w.properties)) {
      if (prop.owner !== p) continue;
      const tileIdx = Number(t);
      const tile = TILES[tileIdx];
      if (tile.kind === "street" && prop.houses > 0) {
        const units = prop.houses === 5 ? 5 : prop.houses;
        total += (units * tile.houseCost) / 2;
      }
      if (!prop.mortgaged) total += mortgageValue(tileIdx);
    }
    return total;
  }

  private totalDebtsOf(p: PlayerId): number {
    return this.work.debts.filter((d) => d.debtor === p).reduce((a, d) => a + d.amount, 0);
  }

  private managementAllowed(p: PlayerId): string | null {
    const w = this.work;
    if (w.phase === "liquidation") {
      const head = w.debts[0];
      if (!head || head.debtor !== p) return "Only the indebted player may act during liquidation";
      return null;
    }
    if (w.phase === "awaitRoll" || w.phase === "awaitEnd" || w.phase === "awaitPurchase") {
      if (currentPlayer(w).id !== p) return "Not your turn";
      return null;
    }
    return `Not allowed during ${w.phase}`;
  }

  private checkWinner(): void {
    const alive = alivePlayers(this.work);
    if (alive.length === 1 && !this.work.winner) {
      this.emit({ type: "GameEnded", winner: alive[0].id });
    }
  }

  // ---------------------------------------------------------------- commands
  apply(cmd: Command): Result {
    this.pending = [];
    this.work = this._state;
    const w = this.work;
    if (w.phase === "gameOver") return err("Game is over");
    const player = w.players[cmd.player];
    if (!player) return err(`Unknown player ${cmd.player}`);
    if (player.bankrupt) return err("You are bankrupt");

    switch (cmd.type) {
      case "Roll": return this.cmdRoll(cmd.player);
      case "PayJailFine": return this.cmdPayJailFine(cmd.player);
      case "UseJailCard": return this.cmdUseJailCard(cmd.player);
      case "BuyProperty": return this.cmdBuy(cmd.player);
      case "DeclineBuy": return this.cmdDecline(cmd.player);
      case "Bid": return this.cmdBid(cmd.player, cmd.amount);
      case "PassAuction": return this.cmdPassAuction(cmd.player);
      case "Build": return this.cmdBuild(cmd.player, cmd.tile);
      case "SellHouse": return this.cmdSellHouse(cmd.player, cmd.tile);
      case "Mortgage": return this.cmdMortgage(cmd.player, cmd.tile);
      case "Unmortgage": return this.cmdUnmortgage(cmd.player, cmd.tile);
      case "SettleDebt": return this.cmdSettleDebt(cmd.player);
      case "DeclareBankruptcy": return this.cmdBankruptcy(cmd.player);
      case "EndTurn": return this.cmdEndTurn(cmd.player);
    }
  }

  private cmdRoll(p: PlayerId): Result {
    const w = this.work;
    if (w.phase !== "awaitRoll") return err(`Cannot roll during ${w.phase}`);
    if (currentPlayer(w).id !== p) return err("Not your turn");

    const d1 = die(w.seed, Stream.Dice, w.diceCursor);
    const d2 = die(w.seed, Stream.Dice, w.diceCursor + 1);
    this.emit({ type: "DiceRolled", player: p, d1, d2 });
    const me = this.work.players[p];

    if (me.inJail) {
      if (d1 === d2) {
        this.emit({ type: "LeftJail", player: p, via: "doubles" });
        this.work.players[p].doublesCount = 0; // doubles out of jail grant no bonus roll
        this.advanceBy(p, d1 + d2);
        this.resolveTile(p);
        // force no re-roll: doubles from jail don't repeat
        if (!this.work.pendingPurchase && !this.work.auction && !this.work.winner) {
          this.emit({ type: "PhaseSet", phase: "awaitEnd" });
          return this.commit();
        }
        this.finishPhase();
        return this.commit();
      }
      const attempt = me.jailAttempts + 1;
      this.emit({ type: "JailTurnServed", player: p, attempt });
      if (attempt >= 3) {
        // must pay the fine and move by this roll
        this.pay(p, "bank", JAIL_FINE, "jailFine");
        this.emit({ type: "LeftJail", player: p, via: "forcedFine" });
        this.advanceBy(p, d1 + d2);
        this.resolveTile(p);
        if (!this.work.pendingPurchase && !this.work.auction && !this.work.winner) {
          this.emit({ type: "PhaseSet", phase: "awaitEnd" });
          return this.commit();
        }
        this.finishPhase();
        return this.commit();
      }
      this.emit({ type: "PhaseSet", phase: "awaitEnd" });
      return this.commit();
    }

    if (this.work.players[p].doublesCount >= 3) {
      this.emit({ type: "SpeedingToJail", player: p });
      this.emit({ type: "SentToJail", player: p });
      this.emit({ type: "PhaseSet", phase: "awaitEnd" });
      return this.commit();
    }

    this.advanceBy(p, d1 + d2);
    this.resolveTile(p);
    this.finishPhase();
    return this.commit();
  }

  private cmdPayJailFine(p: PlayerId): Result {
    const w = this.work;
    if (w.phase !== "awaitRoll") return err("Can only pay the fine before rolling");
    if (currentPlayer(w).id !== p) return err("Not your turn");
    if (!w.players[p].inJail) return err("You are not in jail");
    if (w.players[p].cash < JAIL_FINE) return err(`Need $${JAIL_FINE}`);
    this.pay(p, "bank", JAIL_FINE, "jailFine");
    this.emit({ type: "LeftJail", player: p, via: "fine" });
    this.emit({ type: "PhaseSet", phase: "awaitRoll" }); // now roll and move normally
    return this.commit();
  }

  private cmdUseJailCard(p: PlayerId): Result {
    const w = this.work;
    if (w.phase !== "awaitRoll") return err("Can only use the card before rolling");
    if (currentPlayer(w).id !== p) return err("Not your turn");
    if (!w.players[p].inJail) return err("You are not in jail");
    const deck = w.players[p].jailCards[0];
    if (!deck) return err("You have no Get Out of Jail Free card");
    this.emit({ type: "JailCardUsed", player: p, deck });
    this.emit({ type: "LeftJail", player: p, via: "card" });
    this.emit({ type: "PhaseSet", phase: "awaitRoll" });
    return this.commit();
  }

  private cmdBuy(p: PlayerId): Result {
    const w = this.work;
    if (w.phase !== "awaitPurchase") return err("Nothing to buy");
    if (currentPlayer(w).id !== p) return err("Not your turn");
    const tileIdx = w.pendingPurchase!;
    const tile = TILES[tileIdx];
    if (tile.kind !== "street" && tile.kind !== "railroad" && tile.kind !== "utility") {
      return err("Tile is not purchasable");
    }
    if (w.players[p].cash < tile.price) {
      return err(`Need $${tile.price} (mortgage or sell first, or decline to auction)`);
    }
    this.emit({ type: "MoneyTransferred", from: p, to: "bank", amount: tile.price, reason: "purchase", memo: tile.name });
    this.emit({ type: "PropertyPurchased", player: p, tile: tileIdx, price: tile.price });
    this.finishPhase();
    return this.commit();
  }

  private cmdDecline(p: PlayerId): Result {
    const w = this.work;
    if (w.phase !== "awaitPurchase") return err("Nothing to decline");
    if (currentPlayer(w).id !== p) return err("Not your turn");
    const tileIdx = w.pendingPurchase!;
    this.emit({ type: "PurchaseDeclined", player: p, tile: tileIdx });
    const bidders = alivePlayers(this.work).map((x) => x.id);
    this.emit({ type: "AuctionStarted", tile: tileIdx, bidders });
    return this.commit();
  }

  private auctionTryEnd(): void {
    const a = this.work.auction;
    if (!a) return;
    if (a.active.length === 0) {
      this.emit({ type: "AuctionAbandoned", tile: a.tile });
      this.finishPhase();
      return;
    }
    if (a.active.length === 1 && a.highBidder === a.active[0]) {
      const winner = a.active[0];
      const tile = a.tile;
      const price = a.highBid;
      this.emit({ type: "MoneyTransferred", from: winner, to: "bank", amount: price, reason: "auction", memo: TILES[tile].name });
      this.emit({ type: "AuctionWon", player: winner, tile, price });
      this.finishPhase();
    }
  }

  private cmdBid(p: PlayerId, amount: number): Result {
    const w = this.work;
    if (w.phase !== "auction" || !w.auction) return err("No auction in progress");
    const a = w.auction;
    if (a.active[a.turnPtr] !== p) return err("Not your bid");
    if (!Number.isInteger(amount) || amount <= a.highBid) return err(`Bid must exceed $${a.highBid}`);
    if (amount > w.players[p].cash) return err("You cannot bid more cash than you have");
    this.emit({ type: "BidPlaced", player: p, amount });
    this.auctionTryEnd();
    return this.commit();
  }

  private cmdPassAuction(p: PlayerId): Result {
    const w = this.work;
    if (w.phase !== "auction" || !w.auction) return err("No auction in progress");
    const a = w.auction;
    if (a.active[a.turnPtr] !== p) return err("Not your bid");
    this.emit({ type: "AuctionPassed", player: p });
    this.auctionTryEnd();
    return this.commit();
  }

  private cmdBuild(p: PlayerId, tileIdx: number): Result {
    const gate = this.managementAllowed(p);
    if (gate) return err(gate);
    if (this.work.phase === "liquidation") return err("Cannot build while settling debts");
    const w = this.work;
    const tile = TILES[tileIdx];
    if (tile.kind !== "street") return err("Can only build on streets");
    const prop = w.properties[tileIdx];
    if (prop?.owner !== p) return err("You do not own this property");
    const group = groupTiles(tile.group);
    if (!group.every((t) => w.properties[t]?.owner === p)) return err("You need the full color set");
    if (group.some((t) => w.properties[t]!.mortgaged)) return err("Unmortgage the whole set first");
    if (prop.houses >= 5) return err("Already has a hotel");
    const minHouses = Math.min(...group.map((t) => w.properties[t]!.houses));
    if (prop.houses > minHouses) return err("Build evenly across the set");
    const buildingHotel = prop.houses === 4;
    if (buildingHotel && w.hotelSupply < 1) return err("No hotels left in the bank");
    if (!buildingHotel && w.houseSupply < 1) return err("No houses left in the bank");
    if (w.players[p].cash < tile.houseCost) return err(`Need $${tile.houseCost}`);
    this.emit({ type: "MoneyTransferred", from: p, to: "bank", amount: tile.houseCost, reason: "houseBuild", memo: tile.name });
    this.emit({ type: "HouseBuilt", player: p, tile: tileIdx });
    return this.commit();
  }

  private cmdSellHouse(p: PlayerId, tileIdx: number): Result {
    const gate = this.managementAllowed(p);
    if (gate) return err(gate);
    const w = this.work;
    const tile = TILES[tileIdx];
    if (tile.kind !== "street") return err("No buildings there");
    const prop = w.properties[tileIdx];
    if (prop?.owner !== p) return err("You do not own this property");
    if (prop.houses === 0) return err("Nothing to sell");
    const group = groupTiles(tile.group);
    const maxHouses = Math.max(...group.map((t) => w.properties[t]!.houses));
    if (prop.houses < maxHouses) return err("Sell evenly across the set");
    if (prop.houses === 5 && w.houseSupply < 4) return err("Bank lacks 4 houses to break the hotel");
    this.emit({ type: "HouseSold", player: p, tile: tileIdx });
    this.emit({ type: "MoneyTransferred", from: "bank", to: p, amount: tile.houseCost / 2, reason: "houseSale", memo: tile.name });
    return this.commit();
  }

  private cmdMortgage(p: PlayerId, tileIdx: number): Result {
    const gate = this.managementAllowed(p);
    if (gate) return err(gate);
    const w = this.work;
    const prop = w.properties[tileIdx];
    if (prop?.owner !== p) return err("You do not own this property");
    if (prop.mortgaged) return err("Already mortgaged");
    const tile = TILES[tileIdx];
    if (tile.kind === "street") {
      const group = groupTiles(tile.group);
      if (group.some((t) => (w.properties[t]?.houses ?? 0) > 0)) {
        return err("Sell all buildings in the set first");
      }
    }
    this.emit({ type: "PropertyMortgaged", player: p, tile: tileIdx });
    this.emit({ type: "MoneyTransferred", from: "bank", to: p, amount: mortgageValue(tileIdx), reason: "mortgage", memo: TILES[tileIdx].name });
    return this.commit();
  }

  private cmdUnmortgage(p: PlayerId, tileIdx: number): Result {
    const gate = this.managementAllowed(p);
    if (gate) return err(gate);
    if (this.work.phase === "liquidation") return err("Cannot unmortgage while settling debts");
    const w = this.work;
    const prop = w.properties[tileIdx];
    if (prop?.owner !== p) return err("You do not own this property");
    if (!prop.mortgaged) return err("Not mortgaged");
    // integer math: 110% of mortgage value, rounded up (avoids float drift like 200*1.1 = 220.00000000000003)
    const cost = Math.ceil((mortgageValue(tileIdx) * (10 + UNMORTGAGE_INTEREST * 10)) / 10);
    if (w.players[p].cash < cost) return err(`Need $${cost}`);
    this.emit({ type: "MoneyTransferred", from: p, to: "bank", amount: cost, reason: "unmortgage", memo: TILES[tileIdx].name });
    this.emit({ type: "PropertyUnmortgaged", player: p, tile: tileIdx });
    return this.commit();
  }

  private cmdSettleDebt(p: PlayerId): Result {
    const w = this.work;
    if (w.phase !== "liquidation") return err("No debts to settle");
    const head = w.debts[0];
    if (head.debtor !== p) return err("The head debt is not yours");
    if (w.players[p].cash < head.amount) return err(`Need $${head.amount} — sell or mortgage first`);
    this.emit({ type: "MoneyTransferred", from: p, to: head.creditor, amount: head.amount, reason: "debtSettlement", memo: head.reason });
    this.emit({ type: "DebtSettled", debtor: p, creditor: head.creditor, amount: head.amount });
    return this.commit();
  }

  private cmdBankruptcy(p: PlayerId): Result {
    const w = this.work;
    if (w.phase !== "liquidation") return err("You have no unpayable debt");
    const head = w.debts[0];
    if (head.debtor !== p) return err("The head debt is not yours");
    if (this.liquidationValue(p) >= this.totalDebtsOf(p)) {
      return err("You can still raise the money — sell and mortgage instead");
    }
    const creditor = head.creditor;

    // 1. Sell all buildings (proceeds join the estate).
    for (const [t, prop] of Object.entries(this.work.properties)) {
      if (prop.owner !== p) continue;
      const tileIdx = Number(t);
      const tile = TILES[tileIdx];
      if (tile.kind !== "street") continue;
      while (this.work.properties[tileIdx].houses > 0) {
        this.emit({ type: "HouseSold", player: p, tile: tileIdx });
        this.emit({ type: "MoneyTransferred", from: "bank", to: p, amount: tile.houseCost / 2, reason: "houseSale", memo: `${tile.name} (bankruptcy)` });
      }
    }

    // 2. Hand every remaining dollar to the creditor.
    const estateCash = this.work.players[p].cash;
    if (estateCash > 0) {
      this.emit({ type: "MoneyTransferred", from: p, to: creditor, amount: estateCash, reason: "bankruptcyTransfer" });
    }

    // 3. Transfer properties (to a player: mortgages ride along; to bank: back on the market).
    for (const [t, prop] of Object.entries(this.work.properties)) {
      if (prop.owner !== p) continue;
      this.emit({ type: "PropertyTransferred", tile: Number(t), from: p, to: creditor, mortgaged: prop.mortgaged });
    }

    // 4. Mark bankrupt (clears this player's remaining debts).
    this.emit({ type: "PlayerBankrupted", player: p, creditor });
    this.checkWinner();

    if (!this.work.winner) {
      if (currentPlayer(this.work).id === p) {
        // the bankrupt player's turn is over
        this.emit({ type: "TurnEnded", player: p });
        const next = currentPlayer(this.work);
        this.emit({ type: "TurnStarted", player: next.id, turn: this.work.turn + 1 });
      } else if (this.work.debts.length === 0) {
        this.finishPhase();
      }
    }
    return this.commit();
  }

  private cmdEndTurn(p: PlayerId): Result {
    const w = this.work;
    if (w.phase !== "awaitEnd") return err(`Cannot end turn during ${w.phase}`);
    if (currentPlayer(w).id !== p) return err("Not your turn");
    this.emit({ type: "TurnEnded", player: p });
    const next = currentPlayer(this.work);
    this.emit({ type: "TurnStarted", player: next.id, turn: this.work.turn + 1 });
    return this.commit();
  }
}
