import {getMainnetSdk} from '@dethcrypto/eth-sdk-client';
import type {BroadcastorProps, UnsubscribeFunction} from '@keep3r-network/keeper-scripting-utils';
import {PrivateBroadcastor, getEnvVariable, BlockListener} from '@keep3r-network/keeper-scripting-utils';
import dotenv from 'dotenv';
import type {BigNumber} from 'ethers';
import {Contract, providers, Wallet} from 'ethers';
import {defaultAbiCoder} from 'ethers/lib/utils';
import {BLOCK_DURATION, FLASHBOTS_RPCS, KEEP3R_NETWORK_TAG, MAKER_JOB_ABI_LIKE, PRIORITY_FEE, TOLERANCE_THRESHOLD} from './utils/contants';
import {calculateNextMasterWindow} from './utils/misc';
import type {Address} from './utils/types';

/*
	First of all it is very important to explain a little bit about how MakerDAO's Upkeep job works. One of the key elements
	to address is that this job can be worked by a list of whitelisted keepers called networks. Each of them is gonna
	have a specific window of time (13 blocks) to work. This is to democratize the process and avoid competition
	between them. The keeper that is allowed to work in the current window is called master.
	This workflow is devided in three vital parts:
	- Upkeep job contract: this is a contract that manages and call the underlying workable jobs contracts. This is the
												 contract we are gonna be calling to work.
	- Sequencer contract: this contract is in charge of managing the window of time for each keeper and ensure that only
												the master is able to call the work function on the Upkeep contract.
	- Workable jobs: These are the underlying jobs that have the logic that needs to be execute.
*/

/* ==============================================================/*
		                      SETUP
/*============================================================== */

// Creates a mapping that keeps track of whether we have sent a bundle to try to work a job.
const jobWorkInProgress: Record<Address, boolean> = {};

/* ==============================================================/*
		                    WATCHED VARIABLES
/*============================================================== */

// Stores the duration of each keeper's window in terms of blocks.
let blocksInWindow: number;
let networksAmount: number;
let keep3rSequencerPosition = 0;
const jobs: Record<Address, UnsubscribeFunction | undefined> = {};

(async () => {
  // Environment variables usage
  const provider = new providers.JsonRpcProvider(getEnvVariable('RPC_HTTP_MAINNET_URI'));
  const txSigner = new Wallet(getEnvVariable('TX_SIGNER_PRIVATE_KEY'), provider);
  const chainId = 1;

  // Instantiates the contracts
  const upkeepJob = getMainnetSdk(txSigner).upkeepJob;
  const sequencer = getMainnetSdk(txSigner).sequencer;

  // Instantiates the broadcastor
  const broadcastor = new PrivateBroadcastor(FLASHBOTS_RPCS, PRIORITY_FEE, 10_000_000, true, chainId);

  // Run the script
  await run(upkeepJob, sequencer, provider, 'work', broadcastor.tryToWork.bind(broadcastor));
})();

/**
 *
 * @notice Fetches the number of blocks the work window has. Also fetches and instantiates every workable job that
 * 			   the Upkeep job manages.
 * 				 Fetches all the needed data to calculate the next workable window's first and last block and
 * 				 how much time is left.
 * 				 Once calculated it sets a timer to start fetching blocks after that timer passes.
 * 				 Will fetch blocks and try to work each  workable job calling tryToWorkJob function for each available job.
 *
 * @dev    We have set and average block time of 12 seconds since we are in PoS and also a toleranceThreshold of 120 seconds
 * 				 to start listening blocks 2 minutes before our work window. This way we can have a tolerance of at least 10 blocks
 * 				 being skipped in the network.
 * 				 This is because we want to be sure that we are going to always start fetching blocks before our window to
 * 				 minimize the risk of starting to fetch in the middle of our own workable window.
 * 				 This function will iterate through every workable job and try to work all of them.
 * 				 Also notice that this is a recursive function that will call itself when the work window and restart logic
 * 				 to be ready for next work window.
 *
 */
async function run(
  upkeepJob: Contract,
  sequencer: Contract,
  provider: providers.JsonRpcProvider,
  workMethod: string,
  broadcastMethod: (props: BroadcastorProps) => Promise<void>,
) {
  console.log('START runUpkeepJob()');

  if (keep3rSequencerPosition === -1) {
    console.error(`The keep3r network is not whitelisted in the sequencer`);
    return;
  }

  await fetchBlocksInWindowAndSubscribeToChanges(sequencer, provider);
  await fetchJobsAndSubscribeToChanges(sequencer, provider);
  await fetchNetworksAndSubscribeToChanges(sequencer, provider);

  // Fetches current block number
  const currentBlock = await provider.getBlock('latest');

  // Calculates the first block of our next work window
  const windowStart = calculateNextMasterWindow(currentBlock.number, blocksInWindow, networksAmount, keep3rSequencerPosition);

  // Calculates the last block of our next work window
  const windowEnd = windowStart + blocksInWindow;

  // Amount of blocks missing until our next work window
  const remainderBlocks = windowStart - currentBlock.number;

  // Amount of seconds to wait before fetching new blocks
  const time = remainderBlocks * BLOCK_DURATION - TOLERANCE_THRESHOLD;
  // Const time = 1000;

  if (time > 0) {
    console.log(`Next master window will start at block ${windowStart} and will end at ${windowEnd}`);
    console.log(`Sleeping for ${time / 1000} seconds, until getting closer to the master window`);
  } else {
    console.log(`Next master window already started at block ${windowStart} and will end at ${windowEnd}`);
  }

  const blockListener = new BlockListener(provider);

  // When time elapses, create a subscription and start listening to upcoming blocks.
  blockListener.stream(async (block) => {
    // If the current block is previous to the window start block, the script will stop and wait for the next block.
    if (block.number < windowStart) {
      console.debug('Still not in window. Current Block:', block.number);
      return;
    }

    // If inside of the work window, the script will iterate through each job and try to work it using the tryToWorkJob method.
    const jobWorkPromises = Object.keys(jobs).map(async (jobAddress) => {
      const job = new Contract(jobAddress, MAKER_JOB_ABI_LIKE, provider);
      const [workable, args] = await job.workable(KEEP3R_NETWORK_TAG);
      if (workable) {
        await broadcastMethod({jobContract: upkeepJob, workMethod, workArguments: [jobAddress, args], block});
      }
    });

    await Promise.all(jobWorkPromises);
  });
}

/**
 * @notice Keeps amount of blocks in a window variable updated
 * @dev It will start by fetching the amount of blocks in a window and then keep it updated by reacting to events
 */
async function fetchBlocksInWindowAndSubscribeToChanges(sequencer: Contract, provider: providers.JsonRpcProvider) {
  // Fetches the number of blocks the work windows has
  blocksInWindow = (await sequencer.totalWindowSize()).toNumber();

  provider.on(sequencer.filters.AddNetwork(), (eventData) => {
    const window = defaultAbiCoder.decode(['bytes32', 'uint256'], eventData.data)[1] as BigNumber;
    blocksInWindow = window.toNumber();
  });
}

/**
 * @notice Keeps list of jobs constantly updated
 * @dev It will start by fetching the list of job addresses and then keep it updated by reacting to events
 */
async function fetchJobsAndSubscribeToChanges(sequencer: Contract, provider: providers.JsonRpcProvider) {
  // Amount of workable jobs
  const jobAmount: number = (await sequencer.numJobs()).toNumber();

  // Array of promises to fetch every workable job address
  const jobAddressPromises: Array<Promise<string>> = [];
  for (let index = 0; index < jobAmount; index++) {
    const jobAddress = await sequencer.jobAt(index);
    jobAddressPromises.push(jobAddress);
  }

  // Fetches every workable job address
  const jobAddresses: Address[] = await Promise.all(jobAddressPromises);

  // Store job addresses in a shared object
  for (const jobAddress of jobAddresses) jobs[jobAddress] = undefined;

  provider.on(sequencer.filters.AddJob(), (eventData) => {
    const jobAddress = defaultAbiCoder.decode(['address'], eventData.data)[0] as string;
    jobs[jobAddress] = undefined;
  });

  provider.on(sequencer.filters.RemoveJob(), (eventData) => {
    const jobAddress = defaultAbiCoder.decode(['address'], eventData.data)[0] as string;
    // If it exists, call the unsubscribe function of the job
    if (jobs[jobAddress]) jobs[jobAddress]!();
    // Remove the job from the list of available jobs
    delete jobs[jobAddress];
  });
}

/**
 * @notice Keeps the number of networks and the index of keep3r network constantly updated
 * @dev It will start by fetching the data once and then keep it updated by reacting to events
 */
async function fetchNetworksAndSubscribeToChanges(sequencer: Contract, provider: providers.JsonRpcProvider) {
  await fetchAndUpdateNetworksData(sequencer, provider);
  provider.on(sequencer.filters.AddNetwork(), async () => fetchAndUpdateNetworksData(sequencer, provider));
  provider.on(sequencer.filters.RemoveNetwork(), async () => fetchAndUpdateNetworksData(sequencer, provider));
}

async function fetchAndUpdateNetworksData(sequencer: Contract, provider: providers.JsonRpcProvider) {
  const numberNetworks = await sequencer.numNetworks();
  networksAmount = numberNetworks.toNumber();

  for (let index = 0; index < networksAmount; index++) {
    const network = await sequencer.networkAt(index);
    if (network === KEEP3R_NETWORK_TAG) {
      keep3rSequencerPosition = index;
      return;
    }
  }

  keep3rSequencerPosition = -1;
}
