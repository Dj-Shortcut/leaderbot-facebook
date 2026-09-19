import { t, type Lang } from "./i18n";

// Match emoji sequences without treating ordinary digits or letters as emoji.
const EMOJI_SEQUENCE =
  /(?:[#*0-9]\uFE0F?\u20E3|\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*[\u{E0020}-\u{E007F}]*)/gu;

export function getSocialReply(
  raw: string | undefined,
  lang: Lang
): string | null {
  if (!raw?.trim()) return null;
  const text = raw.normalize("NFKC").trim().toLowerCase();
  const emoji = text.match(EMOJI_SEQUENCE) ?? [];
  const words = text
    .replace(EMOJI_SEQUENCE, " ")
    .replace(/[.!?,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (emoji.length && !words) {
    if (/[👎😞😔😢😭😡😠💔]/u.test(text)) return t(lang, "socialNegative");
    if (/[👍❤♥😊😁😄😍🥰🎉👏🙌🙏🔥😂🤣]/u.test(text))
      return t(lang, "socialPositive");
    return t(lang, "socialReaction");
  }
  if (
    /^(?:(?:heel(?: erg)?|super|hartelijk|erg)\s+)?(?:bedankt|dank ?je(?: ?wel)?|dank u(?: wel)?|dank|merci(?:kes)?|thanks(?: a lot)?|thank you(?: very much)?|thx|tks)(?:\s+(?:voor (?:de |je |het )?(?:mooie |leuke )?(?:foto|afbeelding|hulp|resultaat)|for (?:the |your )?(?:photo|image|help)))?$/.test(
      words
    )
  ) {
    return t(lang, "socialThanks");
  }
  if (
    /^(?:graag gedaan|geen probleem|geen dank|you're welcome|you are welcome|no problem)$/.test(
      words
    )
  )
    return t(lang, "socialCourtesy");
  if (
    /^(?:mooi|prachtig|geweldig|super|top|perfect|nice|great|beautiful)(?:\s+(?:gedaan|gemaakt|bedankt|merci))?$/.test(
      words
    )
  )
    return t(lang, "socialPositive");
  if (/^(?:tot ziens|tot later|doei|dag|bye|goodbye|see you)$/.test(words))
    return t(lang, "socialGoodbye");
  return null;
}
