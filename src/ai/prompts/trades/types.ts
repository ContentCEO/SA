/** What a draft needs to know about one trade: its words, and what to ask before quoting. */
export type TradePrompt = {
  /** Shown to the model as "Trade" in the business block. */
  name: string;
  /** Terms customers and the owner use, to understand and use naturally. */
  vocabulary: string[];
  /** What to find out before giving any number. The drafter asks only for what's missing. */
  quoteQuestions: string[];
};
