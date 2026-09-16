import type { ConversationAction } from "./botResponse";

export const CREDIT_BALANCE_ACTION: ConversationAction = {
  id: "credits",
  label: "Credits",
  inputText: "credits",
};

export function isCreditBalanceCommand(text: string): boolean {
  return /^(?:\/?credits|\/?saldo)$/iu.test(text.trim());
}
