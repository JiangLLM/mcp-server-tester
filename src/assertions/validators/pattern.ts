/**
 * Pattern Validator
 *
 * Validates that a response matches regex patterns.
 */

import type { ValidationResult, PatternValidatorOptions } from './types.js';
import { extractText } from './utils.js';

/**
 * Validates that a response matches all expected regex patterns
 *
 * Extracts text from the response and checks that each pattern matches.
 * Patterns can be strings (which are compiled to RegExp) or RegExp objects.
 * Each check starts at index zero and leaves the supplied RegExp's lastIndex unchanged.
 *
 * @param response - The response to validate
 * @param patterns - Expected pattern(s) to match
 * @param options - Validation options
 * @returns Validation result
 *
 * @example
 * ```typescript
 * // String pattern
 * const result = validatePattern(response, 'temperature: \\d+');
 *
 * // RegExp pattern
 * const result2 = validatePattern(response, /temperature: \d+/);
 *
 * // Multiple patterns
 * const result3 = validatePattern(response, [
 *   /temperature: \d+/,
 *   /humidity: \d+%/,
 * ]);
 *
 * // Case-insensitive matching
 * const result4 = validatePattern(response, 'HELLO', { caseSensitive: false });
 * ```
 */
export function validatePattern(
  response: unknown,
  patterns: string | RegExp | (string | RegExp)[],
  options: PatternValidatorOptions = {}
): ValidationResult {
  const { caseSensitive = true } = options;
  const caseInsensitive = !caseSensitive;

  // Normalize patterns to array
  const patternList = Array.isArray(patterns) ? patterns : [patterns];

  // Extract text from response
  const text = extractText(response);

  // Check each pattern
  const unmatched: string[] = [];
  for (const pattern of patternList) {
    const regex = toRegExp(pattern, caseInsensitive);
    if (!regex.test(text)) {
      unmatched.push(patternToString(pattern));
    }
  }

  if (unmatched.length === 0) {
    return {
      pass: true,
      message:
        patternList.length === 1
          ? `Response matches pattern`
          : `Response matches all ${patternList.length} patterns`,
    };
  }

  return {
    pass: false,
    message:
      unmatched.length === 1
        ? `Response does not match pattern: ${unmatched[0]}`
        : `Response does not match ${unmatched.length} patterns: ${unmatched.join(', ')}`,
    details: {
      unmatched,
      textLength: text.length,
      textPreview: truncateForDisplay(text),
    },
  };
}

/**
 * Converts a pattern to a RegExp
 */
function toRegExp(pattern: string | RegExp, caseInsensitive: boolean): RegExp {
  if (pattern instanceof RegExp) {
    // If caseInsensitive option is set but regex doesn't have it, add it
    if (caseInsensitive && !pattern.flags.includes('i')) {
      return new RegExp(pattern.source, pattern.flags + 'i');
    }
    // Keep global and sticky patterns independent of the caller's lastIndex.
    return new RegExp(pattern.source, pattern.flags);
  }

  // Compile string to RegExp
  const flags = caseInsensitive ? 'i' : '';
  return new RegExp(pattern, flags);
}

/**
 * Converts a pattern to a display string
 */
function patternToString(pattern: string | RegExp): string {
  if (pattern instanceof RegExp) {
    return pattern.toString();
  }
  return `/${pattern}/`;
}

/**
 * Truncates a string for display in error messages
 */
function truncateForDisplay(str: string, maxLength = 200): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, maxLength) + '... (truncated)';
}
