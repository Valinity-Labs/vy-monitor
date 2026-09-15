import type { Address, PublicClient } from 'viem';
import { parseAbiItem } from 'viem';
import { scanFullHistory } from './logs';

const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * VY holder count — addresses with a non-zero balance, the number Etherscan's
 * token page shows. The token contract keeps no holder counter (only the
 * OpenZeppelin balance mapping), so this replays every Transfer since genesis.
 *
 * Exact, not an estimate: every balance change in ValinityToken goes through
 * OZ `_transfer`/`_mint`/`_burn`, including the transfer fee (`_collectFee`), and
 * all of them emit Transfer. Mints and burns are Transfers from/to the zero
 * address, which is not a holder.
 */
export async function countHolders(client: PublicClient, vyToken: Address): Promise<number> {
  const logs = await scanFullHistory(client, (fromBlock, toBlock) =>
    client.getLogs({ address: vyToken, event: transferEvent, fromBlock, toBlock }));

  const balances = new Map<string, bigint>();
  for (const { args: { from, to, value } } of logs) {
    if (!from || !to || value === undefined) continue;
    if (from !== ZERO) balances.set(from, (balances.get(from) ?? 0n) - value);
    if (to !== ZERO) balances.set(to, (balances.get(to) ?? 0n) + value);
  }

  let holders = 0;
  for (const b of balances.values()) if (b > 0n) holders++;
  return holders;
}
