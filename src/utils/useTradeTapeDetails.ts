import { useEffect, useMemo, useState } from 'react';
import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { MAINNET_RPC_URL, RPC_HTTP_OPTS } from '../config';
import type { Trade } from './priceHistory';
import { actionFromReceipt, actionFromTransaction, isKnownActionTarget } from './tradeTape';

export type TradeTapeDetails = {
  actions: ReadonlyMap<string, string>;
};

const client = createPublicClient({
  chain: mainnet,
  transport: http(MAINNET_RPC_URL, { ...RPC_HTTP_OPTS, batch: { batchSize: 50 } }),
});

// null means that the immutable receipt was read successfully and has no protocol override.
const actionCache = new Map<string, string | null>();
const actionRequests = new Map<string, Promise<string | null | undefined>>();

const EMPTY: TradeTapeDetails = { actions: new Map() };

async function loadAction(hash: string): Promise<string | null | undefined> {
  if (actionCache.has(hash)) return actionCache.get(hash);
  const pending = actionRequests.get(hash);
  if (pending) return pending;

  const txHash = hash as `0x${string}`;
  const request = client.getTransactionReceipt({ hash: txHash })
    .then(async (receipt) => {
      const receiptAction = actionFromReceipt(receipt);

      // Ordinary Uniswap rows need no second RPC call. Read calldata only when the receipt's
      // top-level destination is one of the verified Valinity contracts; nested/router actions
      // still receive their authoritative event label without extra traffic.
      const knownTarget = isKnownActionTarget(receipt.to);
      const transaction = knownTarget
        ? await client.getTransaction({ hash: txHash }).catch(() => undefined)
        : undefined;
      const transactionAction = transaction ? actionFromTransaction(transaction) : undefined;

      // Prefer the literal top-level method signature. The receipt adds the one distinction
      // calldata cannot make: whether repayLoan fully closed the position.
      const action = receiptAction === 'Valinity Loan · Closed loan'
        ? receiptAction
        : transactionAction ?? receiptAction;
      if (action !== undefined) {
        actionCache.set(hash, action);
        return action;
      }
      if (knownTarget && !transaction) return undefined;
      actionCache.set(hash, null);
      return null;
    })
    // A transient receipt failure is not cached so the delayed retry can try it again.
    .catch(() => undefined)
    .finally(() => actionRequests.delete(hash));

  actionRequests.set(hash, request);
  return request;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

/** Load non-critical row details after the tape itself is already visible. */
export function useTradeTapeDetails(rows: Trade[]): TradeTapeDetails {
  const hashes = useMemo(
    () => [...new Set(
      rows
        .filter((trade) => trade.era === 'vy-current' || trade.era === 'vy-legacy')
        .map((trade) => trade.txHash.toLowerCase())
        .filter((hash) => /^0x[0-9a-f]{64}$/.test(hash)),
    )],
    [rows],
  );
  const [details, setDetails] = useState<TradeTapeDetails>(EMPTY);

  useEffect(() => {
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const enrich = async (pendingHashes: string[]) => {
      const actionRows = await mapLimit(
        pendingHashes,
        8,
        async (hash) => [hash, await loadAction(hash)] as const,
      );
      if (!active) return;

      const found = actionRows.filter(
        (row): row is readonly [string, string] => typeof row[1] === 'string',
      );
      if (found.length) {
        setDetails((previous) => {
          const actions = new Map(previous.actions);
          for (const [hash, action] of found) actions.set(hash, action);
          return { ...previous, actions };
        });
      }

      // Receipts are immutable. Retry only transient failures once the critical page work has
      // finished; successful ordinary swaps are cached as null.
      const failed = actionRows.filter(([, action]) => action === undefined).map(([hash]) => hash);
      if (failed.length && active && retryTimer === undefined) {
        retryTimer = setTimeout(() => void enrich(failed), 30_000);
      }
    };

    // Paint the tape first, then do receipt lookups as non-critical enrichment.
    const startTimer = setTimeout(() => void enrich(hashes), 250);
    return () => {
      active = false;
      clearTimeout(startTimer);
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [hashes]);

  return details;
}
