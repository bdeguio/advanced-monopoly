/**
 * GameState is a projection: state = events.reduce(reduce, undefined).
 * The reducer applies each event's literal effect and contains no game rules —
 * all rules live in the command processor (engine.ts).
 */
import type { Account, GameEvent, PaymentReason, Phase, PlayerId } from "./events.js";
import type { Card } from "../cards/CardModule.js";
import { CHANCE_DECK, CHEST_DECK, type DeckCard } from "../board/cards.js";
import { HOTEL_SUPPLY, HOUSE_SUPPLY, JAIL_POS } from "../board/tiles.js";
import { Stream, shuffledIndices } from "../board/rng.js";

export type { Phase };

export interface PlayerState {
  id: PlayerId;
  name: string;
  cash: number;
  pos: number;
  inJail: boolean;
  jailAttempts: number;
  jailCards: ("chance" | "chest")[];
  bankrupt: boolean;
  doublesCount: number;
}

export interface PropertyState {
  owner?: PlayerId;
  houses: number;
  mortgaged: boolean;
}

export interface AuctionState {
  tile: number;
  active: PlayerId[];
  turnPtr: number;
  highBid: number;
  highBidder?: PlayerId;
}

export interface DebtState {
  debtor: PlayerId;
  creditor: Account;
  amount: number;
  reason: PaymentReason;
}

export interface GameState {
  seed: number;
  phase: Phase;
  turn: number;
  players: Record<PlayerId, PlayerState>;
  order: PlayerId[];
  currentIdx: number;
  properties: Record<number, PropertyState>;
  houseSupply: number;
  hotelSupply: number;
  chanceOrder: number[];
  chestOrder: number[];
  chanceCursor: number;
  chestCursor: number;
  jailCardsOut: { chance: boolean; chest: boolean };
  diceCursor: number;
  utilCursor: number;
  lastRoll?: { d1: number; d2: number };
  auction?: AuctionState;
  debts: DebtState[];
  /** M2: live financial-instrument cards, in creation order. */
  cards: Card[];
  /** M2: monotonic counter for deterministic card ids. */
  cardSeq: number;
  pendingPurchase?: number;
  resumePhase?: Phase;
  winner?: PlayerId;
}

export function currentPlayer(s: GameState): PlayerState {
  return s.players[s.order[s.currentIdx]];
}

export function alivePlayers(s: GameState): PlayerState[] {
  return s.order.map((id) => s.players[id]).filter((p) => !p.bankrupt);
}

export function deckCardAt(s: GameState, deck: "chance" | "chest", cursor: number): DeckCard {
  const order = deck === "chance" ? s.chanceOrder : s.chestOrder;
  const defs = deck === "chance" ? CHANCE_DECK : CHEST_DECK;
  return defs[order[cursor % order.length]];
}

function transfer(s: GameState, from: Account, to: Account, amount: number): void {
  if (from !== "bank") s.players[from].cash -= amount;
  if (to !== "bank") s.players[to].cash += amount;
}

function setPhase(s: GameState, phase: Phase): void {
  if (s.debts.length > 0) {
    s.resumePhase = phase;
    s.phase = "liquidation";
  } else {
    s.phase = phase;
  }
}

export function reduce(s: GameState | undefined, e: GameEvent): GameState {
  if (e.type === "GameStarted") {
    const players: Record<PlayerId, PlayerState> = {};
    for (const p of e.players) {
      players[p.id] = {
        id: p.id, name: p.name, cash: e.startingCash, pos: 0,
        inJail: false, jailAttempts: 0, jailCards: [], bankrupt: false, doublesCount: 0,
      };
    }
    return {
      seed: e.seed,
      phase: "awaitRoll",
      turn: 1,
      players,
      order: e.players.map((p) => p.id),
      currentIdx: 0,
      properties: {},
      houseSupply: HOUSE_SUPPLY,
      hotelSupply: HOTEL_SUPPLY,
      chanceOrder: shuffledIndices(e.seed, Stream.ShuffleChance, CHANCE_DECK.length),
      chestOrder: shuffledIndices(e.seed, Stream.ShuffleChest, CHEST_DECK.length),
      chanceCursor: 0,
      chestCursor: 0,
      jailCardsOut: { chance: false, chest: false },
      diceCursor: 0,
      utilCursor: 0,
      debts: [],
      cards: [],
      cardSeq: 0,
    };
  }

  if (!s) throw new Error("First event must be GameStarted");
  const n: GameState = structuredClone(s);

  switch (e.type) {
    case "TurnStarted": {
      n.turn = e.turn;
      n.currentIdx = n.order.indexOf(e.player);
      n.phase = "awaitRoll";
      n.players[e.player].doublesCount = 0;
      n.lastRoll = undefined;
      break;
    }
    case "DiceRolled": {
      n.lastRoll = { d1: e.d1, d2: e.d2 };
      n.diceCursor += 2;
      const p = n.players[e.player];
      p.doublesCount = e.d1 === e.d2 ? p.doublesCount + 1 : 0;
      break;
    }
    case "UtilityRolled":
      n.utilCursor += 2;
      break;
    case "SpeedingToJail":
      break;
    case "TokenMoved":
      n.players[e.player].pos = e.to;
      break;
    case "MoneyTransferred":
      transfer(n, e.from, e.to, e.amount);
      break;
    case "PurchasePending":
      n.pendingPurchase = e.tile;
      break;
    case "PropertyPurchased":
      n.properties[e.tile] = { owner: e.player, houses: 0, mortgaged: false };
      n.pendingPurchase = undefined;
      break;
    case "PurchaseDeclined":
      n.pendingPurchase = undefined;
      break;
    case "AuctionStarted":
      n.auction = { tile: e.tile, active: [...e.bidders], turnPtr: 0, highBid: 0 };
      n.phase = "auction";
      break;
    case "BidPlaced": {
      const a = n.auction!;
      a.highBid = e.amount;
      a.highBidder = e.player;
      a.turnPtr = (a.active.indexOf(e.player) + 1) % a.active.length;
      break;
    }
    case "AuctionPassed": {
      const a = n.auction!;
      const idx = a.active.indexOf(e.player);
      a.active.splice(idx, 1);
      if (a.active.length > 0) a.turnPtr = idx % a.active.length;
      break;
    }
    case "AuctionWon":
      n.properties[e.tile] = { owner: e.player, houses: 0, mortgaged: false };
      n.auction = undefined;
      break;
    case "AuctionAbandoned":
      n.auction = undefined;
      break;
    case "CardDrawn": {
      const order = e.deck === "chance" ? n.chanceOrder : n.chestOrder;
      const defs = e.deck === "chance" ? CHANCE_DECK : CHEST_DECK;
      let c = e.deck === "chance" ? n.chanceCursor : n.chestCursor;
      let guard = 0;
      while (defs[order[c % order.length]].id !== e.cardId && guard++ < order.length) c++;
      c++;
      if (e.deck === "chance") n.chanceCursor = c;
      else n.chestCursor = c;
      break;
    }
    case "JailCardGranted":
      n.players[e.player].jailCards.push(e.deck);
      n.jailCardsOut[e.deck] = true;
      break;
    case "JailCardUsed": {
      const cards = n.players[e.player].jailCards;
      cards.splice(cards.indexOf(e.deck), 1);
      n.jailCardsOut[e.deck] = false;
      break;
    }
    case "SentToJail": {
      const p = n.players[e.player];
      p.pos = JAIL_POS;
      p.inJail = true;
      p.jailAttempts = 0;
      p.doublesCount = 0;
      break;
    }
    case "LeftJail": {
      const p = n.players[e.player];
      p.inJail = false;
      p.jailAttempts = 0;
      break;
    }
    case "JailTurnServed":
      n.players[e.player].jailAttempts = e.attempt;
      break;
    case "HouseBuilt": {
      const prop = n.properties[e.tile];
      prop.houses += 1;
      if (prop.houses === 5) {
        n.hotelSupply -= 1;
        n.houseSupply += 4;
      } else {
        n.houseSupply -= 1;
      }
      break;
    }
    case "HouseSold": {
      const prop = n.properties[e.tile];
      if (prop.houses === 5) {
        n.hotelSupply += 1;
        n.houseSupply -= 4;
      } else {
        n.houseSupply += 1;
      }
      prop.houses -= 1;
      break;
    }
    case "PropertyMortgaged":
      n.properties[e.tile].mortgaged = true;
      break;
    case "PropertyUnmortgaged":
      n.properties[e.tile].mortgaged = false;
      break;
    case "DebtRecorded": {
      if (n.debts.length === 0) n.resumePhase = n.phase === "liquidation" ? n.resumePhase : n.phase;
      n.debts.push({ debtor: e.debtor, creditor: e.creditor, amount: e.amount, reason: e.reason });
      n.phase = "liquidation";
      break;
    }
    case "DebtSettled": {
      n.debts.shift();
      if (n.debts.length === 0) {
        n.phase = n.resumePhase ?? "awaitEnd";
        n.resumePhase = undefined;
      }
      break;
    }
    case "PhaseSet":
      setPhase(n, e.phase);
      break;
    case "PropertyTransferred": {
      if (e.to === "bank") {
        delete n.properties[e.tile];
      } else {
        n.properties[e.tile] = { owner: e.to, houses: 0, mortgaged: e.mortgaged };
      }
      break;
    }
    case "CardCreated": {
      n.cards.push({
        id: e.card.id,
        kind: e.card.kind,
        owner: e.card.owner,
        subject: e.card.subject,
        state: e.card.state,
      });
      n.cardSeq += 1;
      break;
    }
    case "InterestCharged":
      break;
    case "LoanRepaid": {
      const card = n.cards.find((c) => c.id === e.loanId);
      if (card) {
        card.state = { ...(card.state as object), outstanding: e.remaining } as typeof card.state;
      }
      break;
    }
    case "CardVoided":
      n.cards = n.cards.filter((c) => c.id !== e.cardId);
      break;
    case "PlayerBankrupted": {
      const p = n.players[e.player];
      p.bankrupt = true;
      p.cash = 0;
      for (const deck of p.jailCards) n.jailCardsOut[deck] = false;
      p.jailCards = [];
      n.debts = n.debts.filter((d) => d.debtor !== e.player);
      n.cards = n.cards.filter((c) => !(c.kind === "loan" && c.subject === e.player));
      if (n.debts.length === 0 && n.phase === "liquidation") {
        n.phase = n.resumePhase ?? "awaitEnd";
        n.resumePhase = undefined;
      }
      break;
    }
    case "TurnEnded": {
      let idx = n.currentIdx;
      do {
        idx = (idx + 1) % n.order.length;
      } while (n.players[n.order[idx]].bankrupt);
      n.currentIdx = idx;
      n.phase = "awaitRoll";
      break;
    }
    case "GameEnded":
      n.winner = e.winner;
      n.phase = "gameOver";
      break;
  }

  return n;
}

export function project(events: readonly GameEvent[]): GameState {
  let s: GameState | undefined;
  for (const e of events) s = reduce(s, e);
  if (!s) throw new Error("Empty event log");
  return s;
}
