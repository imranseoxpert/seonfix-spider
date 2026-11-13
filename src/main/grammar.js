'use strict';
/* Basic rule-based grammar check (v2.1). Deliberately conservative: each
 * rule targets a pattern that is almost always wrong in English body copy,
 * so false positives stay low. It is not a full grammar engine (no
 * LanguageTool); it catches repeated words, a/an misuse, "could of",
 * lowercase sentence starts and missing spaces after punctuation. */

// Words starting with a vowel letter but a consonant sound ("a user").
const A_EXCEPTIONS = /^(one|once|use|user|usual|usage|util|uniform|unique|union|unit|univers|euro|eu|ewe|ufo|usb|url|ubiquit)/i;
// Words starting with a consonant letter but a vowel sound ("an hour").
const AN_EXCEPTIONS = /^(hour|honest|honor|honour|heir|fbi|faq|html|http|mba|mri|seo|sms|xml|x-ray|llc|nda|rss|svg|mp3|mp4|hr$)/i;

const RULES = [
  {
    id: 'repeated-word', name: 'Repeated word',
    find(text) {
      const out = [];
      const re = /\b([A-Za-z]{2,})\s+\1\b/gi;
      let m;
      while ((m = re.exec(text))) {
        const w = m[1].toLowerCase();
        if (['that', 'had', 'is', 'bye', 'no', 'very', 'so', 'ha', 'la', 'boo'].includes(w)) continue;
        out.push(m[0]);
      }
      return out;
    },
  },
  {
    id: 'a-vs-an', name: 'Use "an" before a vowel sound',
    find(text) {
      const out = [];
      const re = /(?:^|[\s(])(a)\s+([A-Za-z][\w-]*)/g;
      let m;
      while ((m = re.exec(text))) {
        const next = m[2];
        if (/^[aeiou]/i.test(next) && !A_EXCEPTIONS.test(next) && !/^[A-Z]{2,}$/.test(next)) out.push(`a ${next}`);
      }
      return out;
    },
  },
  {
    id: 'an-vs-a', name: 'Use "a" before a consonant sound',
    find(text) {
      const out = [];
      const re = /(?:^|[\s(])(an)\s+([A-Za-z][\w-]*)/gi;
      let m;
      while ((m = re.exec(text))) {
        const next = m[2];
        if (/^[bcdfgjklmnpqstvwxyz]/i.test(next) && !AN_EXCEPTIONS.test(next) && !/^[A-Z]{2,}$/.test(next)) out.push(`${m[1]} ${next}`);
      }
      return out;
    },
  },
  {
    id: 'could-of', name: '"could of" should be "could have"',
    find(text) { return (text.match(/\b(could|should|would|must|might)\s+of\b/gi) || []); },
  },
  {
    id: 'lowercase-sentence', name: 'Sentence starts with a lowercase letter',
    find(text) {
      const out = [];
      const re = /[a-z]{2,}[.!?]\s+([a-z][a-z]+)\b/g;
      let m;
      while ((m = re.exec(text))) {
        const pre = text.slice(Math.max(0, m.index - 6), m.index + m[0].length);
        if (/\b(e\.g|i\.e|etc|vs|approx|incl|no|fig|st|mr|mrs|dr)\.\s/i.test(pre)) continue;
        out.push(m[0].trim());
      }
      return out;
    },
  },
  {
    id: 'missing-space', name: 'Missing space after punctuation',
    find(text) {
      const out = [];
      const re = /\b[a-z]{3,}[,;]([A-Za-z]{3,})\b/g;
      let m;
      while ((m = re.exec(text))) out.push(m[0]);
      return out;
    },
  },
];

/* Returns { errors, matches: [{ rule, text }] } (matches capped at 30). */
function checkGrammar(text) {
  const src = String(text || '');
  if (!src) return { errors: 0, matches: [] };
  let errors = 0; const matches = [];
  for (const rule of RULES) {
    const found = rule.find(src);
    errors += found.length;
    for (const f of found) if (matches.length < 30) matches.push({ rule: rule.name, text: f });
  }
  return { errors, matches };
}

module.exports = { checkGrammar, RULES };
