/** Chance & Community Chest decks as pure data; effects are interpreted by the engine. */
export type DeckCard =
  | { id: string; text: string; effect: "advance"; to: number }
  | { id: string; text: string; effect: "advanceNearest"; target: "railroad" | "utility" }
  | { id: string; text: string; effect: "goBack"; spaces: number }
  | { id: string; text: string; effect: "goToJail" }
  | { id: string; text: string; effect: "getOutOfJail" }
  | { id: string; text: string; effect: "collect"; amount: number }
  | { id: string; text: string; effect: "pay"; amount: number }
  | { id: string; text: string; effect: "collectFromEach"; amount: number }
  | { id: string; text: string; effect: "payEach"; amount: number }
  | { id: string; text: string; effect: "repairs"; perHouse: number; perHotel: number };

export const CHANCE_DECK: readonly DeckCard[] = [
  { id: "CH-GO", text: "Advance to GO. Collect $200.", effect: "advance", to: 0 },
  { id: "CH-IL", text: "Advance to Illinois Avenue.", effect: "advance", to: 24 },
  { id: "CH-SC", text: "Advance to St. Charles Place.", effect: "advance", to: 11 },
  { id: "CH-UT", text: "Advance to the nearest Utility. If owned, pay 10x a dice roll.", effect: "advanceNearest", target: "utility" },
  { id: "CH-RR1", text: "Advance to the nearest Railroad. Pay double rent.", effect: "advanceNearest", target: "railroad" },
  { id: "CH-RR2", text: "Advance to the nearest Railroad. Pay double rent.", effect: "advanceNearest", target: "railroad" },
  { id: "CH-DIV", text: "Bank pays you a dividend of $50.", effect: "collect", amount: 50 },
  { id: "CH-GOJF", text: "Get Out of Jail Free.", effect: "getOutOfJail" },
  { id: "CH-BACK3", text: "Go back 3 spaces.", effect: "goBack", spaces: 3 },
  { id: "CH-JAIL", text: "Go directly to Jail.", effect: "goToJail" },
  { id: "CH-REP", text: "Make general repairs: $25 per house, $100 per hotel.", effect: "repairs", perHouse: 25, perHotel: 100 },
  { id: "CH-TAX", text: "Pay poor tax of $15.", effect: "pay", amount: 15 },
  { id: "CH-RDG", text: "Take a trip to Reading Railroad.", effect: "advance", to: 5 },
  { id: "CH-BW", text: "Take a walk on the Boardwalk.", effect: "advance", to: 39 },
  { id: "CH-CHAIR", text: "You have been elected Chairman of the Board. Pay each player $50.", effect: "payEach", amount: 50 },
  { id: "CH-LOAN", text: "Your building loan matures. Collect $150.", effect: "collect", amount: 150 },
];

export const CHEST_DECK: readonly DeckCard[] = [
  { id: "CC-GO", text: "Advance to GO. Collect $200.", effect: "advance", to: 0 },
  { id: "CC-ERR", text: "Bank error in your favor. Collect $200.", effect: "collect", amount: 200 },
  { id: "CC-DOC", text: "Doctor's fee. Pay $50.", effect: "pay", amount: 50 },
  { id: "CC-STOCK", text: "From sale of stock you get $50.", effect: "collect", amount: 50 },
  { id: "CC-GOJF", text: "Get Out of Jail Free.", effect: "getOutOfJail" },
  { id: "CC-JAIL", text: "Go directly to Jail.", effect: "goToJail" },
  { id: "CC-HOLIDAY", text: "Holiday fund matures. Collect $100.", effect: "collect", amount: 100 },
  { id: "CC-REFUND", text: "Income tax refund. Collect $20.", effect: "collect", amount: 20 },
  { id: "CC-BDAY", text: "It is your birthday. Collect $10 from every player.", effect: "collectFromEach", amount: 10 },
  { id: "CC-LIFE", text: "Life insurance matures. Collect $100.", effect: "collect", amount: 100 },
  { id: "CC-HOSP", text: "Pay hospital fees of $100.", effect: "pay", amount: 100 },
  { id: "CC-SCHOOL", text: "Pay school fees of $50.", effect: "pay", amount: 50 },
  { id: "CC-CONSULT", text: "Receive $25 consultancy fee.", effect: "collect", amount: 25 },
  { id: "CC-REP", text: "Street repairs: $40 per house, $115 per hotel.", effect: "repairs", perHouse: 40, perHotel: 115 },
  { id: "CC-BEAUTY", text: "You won second prize in a beauty contest. Collect $10.", effect: "collect", amount: 10 },
  { id: "CC-INHERIT", text: "You inherit $100.", effect: "collect", amount: 100 },
];
