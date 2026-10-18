/**
 * Check 38 P2: Massachusetts' home improvement deposit rule, in one place for the profile form,
 * the draft check and any future help page. M.G.L. c.142A §2(a)(6): a deposit paid before work
 * starts "shall not exceed the greater of one-third of the total contract price or the actual
 * cost of any materials or equipment of a special order or custom made nature"; §17(16) makes
 * taking more a prohibited act. The wording below waits on Davi's approval (legal text).
 */
export const MA_DEPOSIT_MAX_SHARE = 1 / 3;

/** Under "How do you get paid?" when the owner works in MA and their terms ask for more. */
export const MA_DEPOSIT_SETTINGS_LINE =
  "In Massachusetts a deposit can't be more than one-third of the contract, unless special-order materials cost more (c.142A §2). Check this line.";

/** On a draft that asks for more than a third, for an MA shop. */
export const MA_DEPOSIT_DRAFT_FLAG =
  "Massachusetts caps a deposit at one-third, or the cost of special-order materials if higher. Check this before sending.";
