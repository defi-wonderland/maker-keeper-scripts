import {getMainnetSdk} from '@dethcrypto/eth-sdk-client';
import type {TransactionRequest, Block} from '@ethersproject/abstract-provider';
import type {UnsubscribeFunction} from '@keep3r-network/keeper-scripting-utils';
import {
  getMainnetGasType2Parameters,
  sendAndRetryUntilNotWorkable,
  populateTransactions,
  createBundlesWithSameTxs,
  Flashbots,
  BlockListener,
  makeid,
} from '@keep3r-network/keeper-scripting-utils';
import dotenv from 'dotenv';
import type {Contract, BigNumber, Overrides} from 'ethers';
import {providers, Wallet, ethers} from 'ethers';
import {defaultAbiCoder} from 'ethers/lib/utils';
import {
  BLOCK_DURATION,
  BURST_SIZE,
  CHAIN_ID,
  FLASHBOTS_RPC,
  FUTURE_BLOCKS,
  KEEP3R_NETWORK_TAG,
  MAKER_JOB_ABI_LIKE,
  PRIORITY_FEE,
  TOLERANCE_THRESHOLD,
} from './utils/contants';
import {calculateNextMasterWindow, getEnvVariable} from './utils/misc';
import type {Address} from './utils/types';

dotenv.config();

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

// environment variables usage
const provider = new providers.JsonRpcProvider(getEnvVariable('RPC_HTTPS_URI'));
const txSigner = new Wallet(getEnvVariable('TX_SIGNER_PRIVATE_KEY'), provider);
const bundleSigner = new Wallet(getEnvVariable('BUNDLE_SIGNER_PRIVATE_KEY'), provider);

const blockListener = new BlockListener(provider);

// Instantiates the contracts
const upkeepJob = getMainnetSdk(txSigner).upkeepJob;
const sequencer = getMainnetSdk(txSigner).sequencer;

// Creates a mapping that keeps track of whether we have sent a bundle to try to work a job.
const jobWorkInProgress: Record<Address, boolean> = {};

/* ==============================================================/*
		                    WATCHED VARIABLES
/*============================================================== */

// Stores the duration of each keeper's window in terms of blocks.
let blocksInWindow: number;
let networksAmount: number;
let keep3rSequencerPosition: number;
const jobs: Record<Address, UnsubscribeFunction | undefined> = {};

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
async function run(flashbots: Flashbots) {
  console.log('START runUpkeepJob()');

  if (keep3rSequencerPosition === -1) {
    console.error(`The keep3r network is not whitelisted in the sequencer`);
    return;
  }

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

  // When time elapses, create a subscription and start listening to upcoming blocks.
  setTimeout(() => {
    const unsubscribe = blockListener.stream(async (block) => {
      // If the current block is previous to the window start block, the script will stop and wait for the next block.
      if (block.number < windowStart) {
        console.debug('Still not in window. Current Block:', block.number);
        return;
      }

      // If the current block is bigger than the last work window block,  the script will finish this subscription and will call
      // the runUpkeepJob function again to start the calculations for the next workable window.
      if (block.number >= windowEnd) {
        console.debug('Window finished!');
        unsubscribe();
        await run(flashbots);
        return;
      }

      // If inside of the work window, the script will iterate through each job and try to work it using the tryToWorkJob method.
      const jobWorkPromises = Object.keys(jobs).map(async (jobAddress) => {
        const job = new ethers.Contract(jobAddress, MAKER_JOB_ABI_LIKE, txSigner);
        return tryToWorkJob(job, block, flashbots);
      });
      await Promise.all(jobWorkPromises);
    });
  }, time);
}

/**
 *
 * @notice Attempts to work a workable job.
 *
 * @dev  Workable jobs have two different parameters to establish whether they're workable or not:
 * 			 - If the keeper trying to work is the master of the current work window.
 * 			 - A trigger which depends on external metrics and logic inside each job contract that can't be
 * 				 accurately predicted.
 * 			 For this reason, this function is only called when we know we are inside a work window.
 * 			 But because this also depends on external metrics that are unpredictable, once inside the work window,
 *       the function will always use and call the workable function of the job to check if job is actually workable.
 *       If it is, it will send the transaction to try to work it. Otherwise, it will not continue with it execution.
 *
 * @param job - Instance of a job contract that will be worked.
 * @param block - Current block data.
 *
 */
async function tryToWorkJob(job: Contract, block: Block, flashbots: Flashbots) {
  // Check if job is trying to be worked already.
  if (jobWorkInProgress[job.address]) {
    console.log('Work in progress for job:', job.address);
    return;
  }

  // Calls job contract to check if it's actually workable. Receives a boolean and also the args that must be sent
  // to the work function of the Upkeep contract.
  const [isWorkable, args]: [boolean, string] = await job.workable(KEEP3R_NETWORK_TAG);

  // If the job is not workable for any reason, the execution of the function is stopped.
  if (!isWorkable) {
    console.log(`Job ${job.address} is not workable`);
    return;
  }

  console.log('Job is workable:', job.address);

  // Sets the job as in progress since at this point it means that the job is not being worked and is workable.
  jobWorkInProgress[job.address] = true;

  try {
    // Get the signer's (keeper) current nonce
    const currentNonce = await provider.getTransactionCount(txSigner.address);

    /*
        We are going to send this through Flashbots, which means we will be sending multiple bundles to different
        blocks inside a batch. Here we are calculating which will be the last block of our batch of bundles.
        This information is needed to calculate what will the maximum possible base fee be in that block, so we can
        calculate the maxFeePerGas parameter for all our transactions.
        For example: we are in block 100 and we send to 100, 101, 102. We would like to know what is the maximum possible
        base fee at block 102 to make sure we don't populate our transactions with a very low maxFeePerGas, as this would
        cause our transaction to not be mined until the max base fee lowers.
    */
    const blocksAhead = FUTURE_BLOCKS + BURST_SIZE;

    // Fetch the priorityFeeInGwei and maxFeePerGas parameters from the getMainnetGasType2Parameters function
    // NOTE: this just returns our priorityFee in GWEI, it doesn't calculate it, so if we pass a priority fee of 10 wei
    //       this will return a priority fee of 10 GWEI. We need to pass it so that it properly calculated the maxFeePerGas
    const {priorityFeeInGwei, maxFeePerGas} = getMainnetGasType2Parameters({
      block,
      blocksAhead,
      priorityFeeInWei: PRIORITY_FEE,
    });

    // We declare what options we would like our transaction to have
    const options: Overrides = {
      gasLimit: 5_000_000,
      nonce: currentNonce,
      maxFeePerGas,
      maxPriorityFeePerGas: priorityFeeInGwei,
      type: 2,
    };

    // We calculate the first block that the first bundle in our batch will target.
    // Example, if future blocks is 2, and we are in block 100, it will send a bundle to blocks 102, 103, 104 (assuming a burst size of 3)
    // and 102 would be the firstBlockOfBatch
    const firstBlockOfBatch = block.number + FUTURE_BLOCKS;

    // We populate the transactions we will use in our bundles. Notice we are calling the upkeepJob's work function
    // with the args that the job.workable function gaves us.
    const txs: TransactionRequest[] = await populateTransactions({
      chainId: CHAIN_ID,
      contract: upkeepJob,
      functionArgs: [[job.address, args]],
      functionName: 'work',
      options,
    });

    /*
      We create our batch of bundles. In this case this will be a batch of two bundles that will contain the same transaction.
    */
    const bundles = createBundlesWithSameTxs({
      unsignedTxs: txs,
      burstSize: BURST_SIZE,
      firstBlockOfBatch,
    });

    /*
      We send our batch of bundles and recreate new ones until we work it or our work window finishes.
      It's also worth noting that for ease of debugging we are passing the job address as static id, and a random 5 digit id to identify each batch.
      Each batch would look something like this in the console: JOB_ADDRESS#12345
    */
    const result = await sendAndRetryUntilNotWorkable({
      txs,
      provider,
      priorityFeeInWei: PRIORITY_FEE,
      signer: txSigner,
      bundles,
      newBurstSize: BURST_SIZE,
      flashbots,
      isWorkableCheck: () => job.workable(KEEP3R_NETWORK_TAG),
      staticDebugId: job.address,
      dynamicDebugId: makeid(5),
    });

    // If the bundle was included, we console log the success
    if (result) console.log('===== Tx SUCCESS =====', job.address);
  } catch (error: unknown) {
    console.error(error);
  } finally {
    // We also need to set the job as not in progress anymore.
    jobWorkInProgress[job.address] = false;
  }
}

/**
 * @notice Keeps amount of blocks in a window variable updated
 * @dev It will start by fetching the amount of blocks in a window and then keep it updated by reacting to events
 */
async function fetchBlocksInWindowAndSubscribeToChanges() {
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
async function fetchJobsAndSubscribeToChanges() {
  // Amount of workable jobs
  const jobAmount: number = (await sequencer.numJobs()).toNumber();

  // Array of promises to fetch every workable job address
  const jobAddressPromises: Array<Promise<string>> = [];
  for (let index = 0; index < jobAmount; index++) {
    jobAddressPromises.push(sequencer.jobAt(index));
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
async function fetchNetworksAndSubscribeToChanges() {
  await fetchAndUpdateNetworksData();
  provider.on(sequencer.filters.AddNetwork(), async () => fetchAndUpdateNetworksData());
  provider.on(sequencer.filters.RemoveNetwork(), async () => fetchAndUpdateNetworksData());
}

async function fetchAndUpdateNetworksData() {
  networksAmount = (await sequencer.numNetworks()).toNumber();

  for (let index = 0; index < networksAmount; index++) {
    const network = await sequencer.networkAt(index);
    if (network === KEEP3R_NETWORK_TAG) {
      keep3rSequencerPosition = index;
      return;
    }
  }

  keep3rSequencerPosition = -1;
}

(async () => {
  const flashbots = await Flashbots.init(txSigner, bundleSigner, provider, [FLASHBOTS_RPC], true, CHAIN_ID);

  await fetchBlocksInWindowAndSubscribeToChanges();
  await fetchJobsAndSubscribeToChanges();
  await fetchNetworksAndSubscribeToChanges();

  await run(flashbots);

  setInterval(() => {}, 2 ** 31 - 1); // Avoid the terminal from self closing
})();
