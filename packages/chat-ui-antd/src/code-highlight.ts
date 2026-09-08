import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";

const highlighter = hljs.newInstance();
for (const [name, language] of Object.entries({
  javascript,
  typescript,
  json,
  python,
  bash,
  xml,
  css,
})) {
  highlighter.registerLanguage(name, language);
}
/** Returns only library-escaped markup, never raw source HTML. */
export function highlightCode(
  code: string,
  language: string | undefined,
): string | undefined {
  if (
    code.length > 40_000 ||
    language === undefined ||
    highlighter.getLanguage(language) === undefined
  )
    return undefined;
  return highlighter.highlight(code, { language, ignoreIllegals: true }).value;
}
