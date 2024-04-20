import { } from "./env";

export enum ChainId {
    berachain = 80085,

}




const beraChains = ["berachain"] as const;
type BeraChain=typeof beraChains[number];
const getberaConfig = (network: BeraChain): { url: string; chainId: number } => {
    return {
        url: `https://artio.rpc.berachain.com/`,
        chainId: ChainId[network],
    };
};


export type RemoteChain = BeraChain;
export const getRemoteNetworkConfig = (network: RemoteChain): { url: string; chainId: number } => {

    if (beraChains.includes(network as BeraChain)) return getberaConfig(network as BeraChain);
    throw Error("Unknown network");
};
