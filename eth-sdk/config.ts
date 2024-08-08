import {defineConfig} from '@dethcrypto/eth-sdk';

export default defineConfig({
  contracts: {
    mainnet: {
      upkeepJob: '0x5D469E1ef75507b0E0439667ae45e280b9D81B9C',
      sequencer: '0x238b4E35dAed6100C6162fAE4510261f88996EC9',
    },
  },
});
