# Maker's Keeper Scripts

This repository enables keepers of the Keep3r Network to execute Maker's jobs on Ethereum.

## How to run

1. Clone the repository

```
  git clone https://github.com/makerdao/keeper-scripts
```

2. Install dependencies

```
  yarn install
```

3. Create and complete the `.env` file using `env.example` as an example

4. Fine-tune the constants in `src/constants.ts` to your liking. Read [the docs](https://docs.keep3r.network/keeper-scripts) for a technical in-depth explanation.

5. Try out the scripts

```
  yarn start:upkeep
```

## Run in production

1. Build the typescript into javascript

```
  yarn build
```

2. Run the job directly from javascript (using [PM2](https://github.com/Unitech/pm2) is highly recommended)

```
  node dist/upkeep-job.js
```

## Keeper Requirements

- Must be a valid (activated) Keeper on [Keep3r V2](https://etherscan.io/address/0xeb02addCfD8B773A5FFA6B9d1FE99c566f8c44CC)

## Useful Links

- [Upkeep Job](https://etherscan.io/address/0x5D469E1ef75507b0E0439667ae45e280b9D81B9C)
- [Sequencer](https://etherscan.io/address/0x9566eB72e47E3E20643C0b1dfbEe04Da5c7E4732)
