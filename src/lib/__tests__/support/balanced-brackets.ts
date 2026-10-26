import { blankLiterals } from "./strip-comments";

const CLOSE_FOR: Readonly<Record<string, string>> = { "(": ")", "{": "}", "[": "]" };

/** Read a bracketed region, preserving original text and inclusive closing offset.
 *
 * Literal/comment masking belongs to the shared lexer. Callers that already
 * hold offset-preserving masked code pass it as `structure`: masking twice is
 * unsafe because a blanked regex has lost its closing slash.
 * `parts` splits on commas outside nested parentheses, braces and brackets.
 * An invalid opener or an unclosed region throws rather than hiding a site.
 */
export function balancedBrackets(
  source: string,
  start: number,
  structure = blankLiterals(source),
): {
  text: string;
  end: number;
  parts: string[];
} {
  const code = structure;
  if (CLOSE_FOR[code[start] ?? ""] === undefined) {
    throw new Error(`Expected opening bracket at offset ${start}`);
  }

  const stack: string[] = [];
  let partStart = start + 1;
  const parts: string[] = [];
  for (let index = start; index < code.length; index += 1) {
    const char = code[index]!;
    const close = CLOSE_FOR[char];
    if (close !== undefined) stack.push(close);
    else if (")]}".includes(char) && stack.pop() !== char) {
      throw new Error(`Mismatched bracket at offset ${index}`);
    }

    if (stack.length === 0) {
      parts.push(source.slice(partStart, index));
      return {
        text: source.slice(start, index + 1),
        end: index,
        parts: parts.map((part) => part.trim()).filter(Boolean),
      };
    }
    if (char === "," && stack.length === 1) {
      parts.push(source.slice(partStart, index));
      partStart = index + 1;
    }
  }
  throw new Error(`Unbalanced brackets at offset ${start}`);
}
