import type { Address, Hex } from "viem";

/** EIP-712 domain for IntentRegistry.submitFor. Must match the Solidity EIP712("IntentOS","1") ctor. */
export function submitDomain(chainId: number, registry: Address) {
  return {
    name: "IntentOS",
    version: "1",
    chainId,
    verifyingContract: registry,
  } as const;
}

export const SUBMIT_TYPES = {
  Submit: [
    { name: "owner", type: "address" },
    { name: "kind", type: "uint8" },
    { name: "outcomeHash", type: "bytes32" },
    { name: "policyHash", type: "bytes32" },
    { name: "salt", type: "bytes32" },
    { name: "auctionEndsAt", type: "uint64" },
    { name: "deadline", type: "uint64" },
    { name: "legCount", type: "uint16" },
    { name: "integrator", type: "address" },
    { name: "metadataURI", type: "string" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export interface SubmitMessage {
  owner: Address;
  kind: number;
  outcomeHash: Hex;
  policyHash: Hex;
  salt: Hex;
  auctionEndsAt: bigint | string | number;
  deadline: bigint | string | number;
  legCount: number;
  integrator: Address;
  metadataURI: string;
  nonce: bigint | string | number;
}

export const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;
