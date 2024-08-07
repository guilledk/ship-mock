import {MockChain} from "./chain.js";
import {ABI, APIClient, FetchProvider} from "@wharfkit/antelope";
import {
    DEFAULT_ABI,
    generateInOrderBlockHashes,
    generateRandomHashes,
    getNextBlockTime,
    getRandomPort,
    randomHash, sleep
} from "./utils.js";
import {ShipSocket} from "./shipSocket.js";
import {HTTPAPISocket} from "./httpApiSocket.js";
import fs from "fs";
import {logger} from "./logging.js";
import {ActionDescriptor} from "./types.js";

import fetch from 'node-fetch'


export function getRPCClient(endpoint: string) {
    return new APIClient({
        provider: new FetchProvider(endpoint, {fetch})
    });
}

export interface ChainDescriptor {
    shipPort?: number;
    httpPort?: number;

    abi?: ABI;
    chainId?: string;
    startTime?: string;

    startBlock: number;
    endBlock: number;

    asapMode?: boolean;

    blockGenStrat?: string;
    blocks?: string[][];

    txs?: {[key: number]: ActionDescriptor[]};

    jumps?: [number, number][];
    pauses?: [number, number][];
}

export interface NewChainInfo {
    chainId: string;
    shipPort: number;
    httpPort: number;
    startTime: string;
    abi: ABI;
    blockGenStrat?: string;
    blocks: string[][];
    asapMode: boolean;
}

export interface ChainRuntime {
    chain: MockChain;
    network: {
        isUp: boolean;
        shipSocket: ShipSocket;
        httpSocket: HTTPAPISocket;
    };
}

export interface ChainMap {
    [key: string]: ChainDescriptor
}

export interface ControllerConfig {
    controlPort: number;

    chains?: ChainMap;
}

export const loadControllerConfigFromFile = (filePath: string): ControllerConfig | null => {
    try {
        const jsonString = fs.readFileSync(filePath, 'utf-8');
        const jsonData = JSON.parse(jsonString);

        if (!jsonData.controlPort) {
            throw new Error('Invalid config format, missing controlPort key');
        }

        return jsonData as ControllerConfig;
    } catch (error) {
        throw new Error('Error loading or parsing JSON file:', error);
    }
};

export class Controller {

    config: ControllerConfig;

    private chains: {[key: string]: ChainRuntime};

    private _isStopping: boolean = false;

    constructor(config: ControllerConfig) {
        this.config = config;
        this.chains = {};
    }

    log(level: string, message: string) {
        logger[level](`controller: ${message}`);
    }

    chainNetworkUp(chainId: string) {
        const runtime = this.getRuntime(chainId);
        runtime.network.shipSocket.listen();
        runtime.network.httpSocket.listen();
        runtime.network.isUp = true;
    }

    async chainNetworkDown(chainId: string) {
        const runtime = this.getRuntime(chainId);
        await runtime.network.shipSocket.close();
        await runtime.network.httpSocket.close();
        runtime.network.isUp = false;
    }

    async initializeChain(desc: ChainDescriptor) {
        if (desc.chainId in this.chains)
            throw new Error("Chain ID already in use.")

        const infoObj: NewChainInfo = {
            chainId: desc.chainId ?? randomHash(),
            shipPort: desc.shipPort ?? (await getRandomPort()),
            httpPort: desc.httpPort ?? (await getRandomPort()),
            startTime: desc.startTime ?? getNextBlockTime().toISOString(),
            abi: desc.abi ?? DEFAULT_ABI,
            blocks: [],
            asapMode: desc.asapMode ?? false
        };
        const pauseHandler = async (time: number) => {
            await this.chainNetworkDown(infoObj.chainId);
            await sleep(time * 1000);
            this.chainNetworkUp(infoObj.chainId);
        };
        const chain = new MockChain(
            infoObj.chainId,
            infoObj.startTime,
            desc.startBlock, desc.endBlock,
            infoObj.abi,
            pauseHandler.bind(this),
            infoObj.asapMode
        );

        await chain.initializeMockingModule('eosio.token');
        await chain.initializeMockingModule('telos.evm');

        const rangeSize = desc.endBlock - desc.startBlock + 1;
        let jumpsSize = 0;
        if (desc.jumps) {
            chain.setJumps(desc.jumps, 0);
            jumpsSize = desc.jumps.length;
        }

        if (desc.pauses)
            chain.setPauses(desc.pauses);

        if (desc.blocks)
            infoObj.blocks = desc.blocks;

        else if (desc.blockGenStrat) {
            if (desc.blockGenStrat == 'random')
                infoObj.blocks = generateRandomHashes(rangeSize, jumpsSize + 1);

            else if (desc.blockGenStrat == 'inorder')
                infoObj.blocks = generateInOrderBlockHashes(rangeSize, jumpsSize + 1);

            infoObj.blockGenStrat = desc.blockGenStrat;
        }

        for(let i = 0; i < infoObj.blocks.length; i++)
            chain.setBlockHistory(infoObj.blocks[i], i);

        if (desc.txs)
            chain.setTransactions(desc.txs);

        const shipSocket = new ShipSocket(chain, infoObj.shipPort);
        const httpSocket = new HTTPAPISocket(chain, infoObj.httpPort);

        this.chains[infoObj.chainId] = {chain, network: {isUp: false, shipSocket, httpSocket}};

        // this.chainNetworkUp(desc.chainId);

        const displayInfo = {
            ...infoObj,
            abi: 'omited',
            blocks: {
                jumpsSize: infoObj.blocks.length,
                length: infoObj.blocks[0].length
            }
        }

        this.log('info', `initialized chain: ${JSON.stringify(displayInfo, null, 4)}`);

        return infoObj;
    }

    getRuntime(chainId: string): ChainRuntime {
        if (!(chainId in this.chains))
            throw new Error(`Chain ID: ${chainId} not found`);
        return this.chains[chainId];
    }

    async destroyChain(chainId: string) {
        const runtime = this.getRuntime(chainId);
        await runtime.chain.fullStop();
        await this.chainNetworkDown(chainId);
        delete this.chains[chainId];
    }

    isStopping(): boolean {
        return this._isStopping;
    }

    async fullStop() {
        const tasks = [];
        for (const chainId in this.chains)
            tasks.push(this.destroyChain(chainId));
        await Promise.all(tasks);
    }

    getRPC(chainId: string) {
        return getRPCClient(`http://127.0.0.1:${this.getRuntime(chainId).network.httpSocket.getPort()}`)
    }
}