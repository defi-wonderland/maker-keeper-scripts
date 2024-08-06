/**
 *
 * @notice Calculates the next block number in which the keeper is master.
 *
 * @dev It will iterate adding one block each time and calling isMasterFirstBlock function until true.
 *
 * @param blockNumber - Number of block to check.
 * @param blocksInWindow - Amount of blocks a work window has.
 * @param networksAmount - Amount of whitelisted keepers/networks.
 * @param masterPosition - Index of the master in the array of networks.
 *
 * @returns Number representing the next block number in which the keeper is master.
 */
export function calculateNextMainWindow(blockNumber: number, blocksInWindow: number, networksAmount: number, mainPosition: number): number {
  const fullWindow = blocksInWindow * networksAmount;
  const offset = mainPosition * blocksInWindow;
  const timesPassedByActiveNetwork = Math.ceil((blockNumber - offset) / fullWindow);

  return fullWindow * timesPassedByActiveNetwork + offset;
}
