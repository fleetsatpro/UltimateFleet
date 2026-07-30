/**
 * Every `catch` block must either rethrow, or observably handle the error —
 * log it and/or return a typed error result. A catch that does neither swallows
 * a failure, which in an ingestion pipeline means data loss with no signal.
 *
 * Coding standard: brief section 9, "Error handling".
 */

/** @type {import('eslint').Rule.RuleModule} */
export const noSilentCatch = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require every catch block to rethrow, return, or call something (e.g. a logger)',
    },
    schema: [],
    messages: {
      silentCatch:
        'Catch block silently swallows the error. Rethrow it, or log with {{ correlationId, context }} and return a typed error result.',
    },
  },
  create(context) {
    return {
      CatchClause(node) {
        const body = node.body.body;

        // An empty catch is always a violation; `no-empty` also reports it, but
        // reporting here keeps the message actionable.
        if (body.length === 0) {
          context.report({ node, messageId: 'silentCatch' });
          return;
        }

        let handled = false;

        const walk = (n) => {
          if (handled || n === null || typeof n !== 'object') return;

          if (Array.isArray(n)) {
            for (const child of n) walk(child);
            return;
          }

          if (typeof n.type === 'string') {
            // Rethrow, propagate, or hand off to something that observes the error.
            if (
              n.type === 'ThrowStatement' ||
              n.type === 'ReturnStatement' ||
              n.type === 'CallExpression' ||
              n.type === 'AwaitExpression'
            ) {
              handled = true;
              return;
            }
          }

          for (const key of Object.keys(n)) {
            if (key === 'parent') continue;
            walk(n[key]);
          }
        };

        walk(body);

        if (!handled) {
          context.report({ node, messageId: 'silentCatch' });
        }
      },
    };
  },
};

export default { rules: { 'no-silent-catch': noSilentCatch } };
