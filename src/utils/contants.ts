import {formatBytes32String} from 'ethers/lib/utils';

// Ethereum Mainnet
export const CHAIN_ID = 1;

// Size of our batch of bundles
export const BURST_SIZE = 3;

// Blocks into the future to send our first batch of bundles
export const FUTURE_BLOCKS = 0;

// Priority fee to use
export const PRIORITY_FEE = 2.1;

// Gas limit to use
export const GAS_LIMIT = 10_000_000;

// Flashbots RPCs.
export const FLASHBOTS_RPCS = ['https://rpc.titanbuilder.xyz/', 'https://rpc.beaverbuild.org/'];

// Set the keeper name identifier to use in the sequencer and upkeep job contracts. This is used by the contract
// to identify a specific keeper. This is stored in bytes32 in the contracts.
export const KEEP3R_NETWORK_TAG = formatBytes32String('KEEP3R');

// Pseudo workable job interface with only needed method we will use in the script.
export const MAKER_JOB_ABI_LIKE = ['function workable(bytes32 network) view returns (bool canWork, bytes memory args)'];

// Average duration of a block in ethereum mainnet in seconds
export const BLOCK_DURATION = 12 * 1000; // 12 seconds since PoS.

// Amount of blocks to subtract from missing blocks time to ensure to always be listening before the window starts.
// In this case it will be 2 minutes before window starts which gives us a tolerance of 10 skipped blocks by the network.
export const TOLERANCE_THRESHOLD = 5 * BLOCK_DURATION;
