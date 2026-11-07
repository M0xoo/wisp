// The line patterns that open blocks, shared by the block and list parsers.

export const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
export const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
export const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
export const QUOTE = /^ {0,3}> ?/;
/** A list item: indent, marker (bullet, or number and delimiter), the spaces after it, content. */
export const ITEM = /^( {0,3})([-*+]|(\d{1,9})([.)]))( +|$)(.*)$/;
/** List markers that may cut a paragraph short: bullets, and an ordered list only if it starts at 1. */
const INTERRUPTING_ITEM = /^ {0,3}([-*+]|1[.)])( +|$)/;

export const blank = (line: string | undefined): boolean => line === undefined || line.trim() === '';

/** Whether `line` opens a block other than a paragraph (so a paragraph ends before it). */
export function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || INTERRUPTING_ITEM.test(line);
}
