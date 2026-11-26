// Structural mutation operators: drops non-tuning call-site option keys.

import { isTuningIdentifier, maskStringLiterals } from './mutate.mjs';

const EXEMPT_KEYS = new Set(['encoding', 'recursive', 'force']);

const NON_CALL_KEYWORDS = new Set([
  'if', 'while', 'for', 'switch', 'catch', 'with', 'function',
  'return', 'throw', 'typeof', 'void', 'delete', 'yield', 'default', 'case', 'new',
]);

export function dropObjectArgKey(line) {
  if (typeof line !== 'string') return null;
  if (line.includes('\n') || line.includes('\r')) return null;

  const masked = maskStringLiterals(line);
  if (masked.includes('...')) return null;

  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '(') parenDepth++;
    else if (ch === ')') { parenDepth--; if (parenDepth < 0) return null; }
    else if (ch === '{') braceDepth++;
    else if (ch === '}') { braceDepth--; if (braceDepth < 0) return null; }
    else if (ch === '[') bracketDepth++;
    else if (ch === ']') { bracketDepth--; if (bracketDepth < 0) return null; }
  }
  if (parenDepth !== 0 || braceDepth !== 0 || bracketDepth !== 0) return null;

  if (/\b(?:const|let|var)\s*\{/.test(masked)) return null;
  if (/}\s*=/.test(masked)) return null;
  if (/\b(?:import|export|function)\b/.test(masked)) return null;
  if (/=>/.test(masked)) return null;

  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== '{') continue;
    const openBrace = i;
    let depth = 1;
    let closeBrace = -1;
    for (let j = openBrace + 1; j < masked.length; j++) {
      if (masked[j] === '{') depth++;
      else if (masked[j] === '}') {
        depth--;
        if (depth === 0) {
          closeBrace = j;
          break;
        }
      }
    }
    if (closeBrace === -1) continue;

    let pDepth = 0, bDepth = 0, brDepth = 0;
    let enclosingParen = -1;
    for (let k = openBrace - 1; k >= 0; k--) {
      const c = masked[k];
      if (c === ')') pDepth++;
      else if (c === '(') {
        if (pDepth === 0 && bDepth === 0 && brDepth === 0) {
          enclosingParen = k;
          break;
        }
        pDepth--;
      } else if (c === '}') bDepth++;
      else if (c === '{') {
        if (pDepth === 0 && bDepth === 0 && brDepth === 0) break;
        bDepth--;
      } else if (c === ']') brDepth++;
      else if (c === '[') {
        if (pDepth === 0 && bDepth === 0 && brDepth === 0) break;
        brDepth--;
      }
    }
    if (enclosingParen === -1) continue;

    const beforeParen = masked.slice(0, enclosingParen).trimEnd();
    if (!beforeParen) continue;
    const calleeMatch = beforeParen.match(/([a-zA-Z_$][\w$]*)$/);
    if (!calleeMatch && !beforeParen.endsWith(')') && !beforeParen.endsWith(']')) {
      continue;
    }
    if (calleeMatch) {
      const word = calleeMatch[1];
      if (NON_CALL_KEYWORDS.has(word)) continue;
    }
    if (beforeParen.endsWith(')')) {
      let d = 0;
      let matchingP = -1;
      for (let k = beforeParen.length - 1; k >= 0; k--) {
        if (beforeParen[k] === ')') d++;
        else if (beforeParen[k] === '(') {
          d--;
          if (d === 0) { matchingP = k; break; }
        }
      }
      if (matchingP > 0) {
        const priorWord = beforeParen.slice(0, matchingP).trimEnd().match(/([a-zA-Z_$][\w$]*)$/);
        if (priorWord && NON_CALL_KEYWORDS.has(priorWord[1])) continue;
      }
    }

    const props = [];
    let segStart = openBrace + 1;
    let curParen = 0, curBrace = 0, curBracket = 0;

    for (let j = openBrace + 1; j <= closeBrace; j++) {
      if (j === closeBrace || (curParen === 0 && curBrace === 0 && curBracket === 0 && masked[j] === ',')) {
        const segText = line.slice(segStart, j);
        const trimmed = segText.trim();
        if (trimmed.length > 0) {
          const leadMatch = segText.match(/^\s*/)[0].length;
          const trailMatch = segText.match(/\s*$/)[0].length;
          const pStart = segStart + leadMatch;
          const pEnd = j - trailMatch;

          let colonIdx = -1;
          let subP = 0, subB = 0, subBr = 0;
          for (let m = pStart; m < pEnd; m++) {
            const ch = masked[m];
            if (ch === '(') subP++;
            else if (ch === ')') subP--;
            else if (ch === '{') subB++;
            else if (ch === '}') subB--;
            else if (ch === '[') subBr++;
            else if (ch === ']') subBr--;
            else if (ch === ':' && subP === 0 && subB === 0 && subBr === 0) {
              colonIdx = m;
              break;
            }
          }
          const rawKey = (colonIdx !== -1 ? line.slice(pStart, colonIdx) : line.slice(pStart, pEnd)).trim();
          const key = rawKey.replace(/^['"`](.*)['"`]$/, '$1').trim();
          props.push({ start: pStart, end: pEnd, key });
        }
        segStart = j + 1;
      } else {
        const ch = masked[j];
        if (ch === '(') curParen++;
        else if (ch === ')') curParen--;
        else if (ch === '{') curBrace++;
        else if (ch === '}') curBrace--;
        else if (ch === '[') curBracket++;
        else if (ch === ']') curBracket--;
      }
    }

    if (props.length < 2) continue;

    const nonExemptIndices = [];
    for (let pIdx = 0; pIdx < props.length; pIdx++) {
      const k = props[pIdx].key;
      const isExempt = EXEMPT_KEYS.has(k) || isTuningIdentifier(k);
      if (!isExempt) {
        nonExemptIndices.push(pIdx);
      }
    }

    if (nonExemptIndices.length < 1) continue;

    const dropIdx = nonExemptIndices[nonExemptIndices.length - 1];
    return line.slice(0, openBrace + 1) + ' ' + props.filter((_, idx) => idx !== dropIdx).map((p) => line.slice(p.start, p.end).trim()).join(', ') + ' ' + line.slice(closeBrace);
  }

  return null;
}

export const STRUCTURAL_FALLBACK_OPERATORS = Object.freeze([
  Object.freeze({
    name: 'object-arg-key-drop',
    apply: dropObjectArgKey,
  }),
]);
