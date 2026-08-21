import type { VercelRequest, VercelResponse } from "@vercel/node";
import { type Address, type Hex } from "viem";
import {
  INTENT_REGISTRY_ABI,
  computeIntentId,
  hashOutcome,
  hashPolicy,
  parseIntent,
  retimeDraft,
  submitDomain,
  SUBMIT_TYPES,
} from "@intentos/sdk";
import { readBody, send } from "./_lib/json.js";
import { catalog, loadLiveDeployment, operatorClient, reader } from "./_lib/runtime.js";

export const config = { maxDuration: 60 };

const RECURRING_ABI = [
  {
    type: "function",
    name: "dueIds",
    stateMutability: "view",
    inputs: [{ name: "limit", type: "uint256" }],
    outputs: [{ name: "ids", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "jobAt",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "owner", type: "address" },
          { name: "everySeconds", type: "uint64" },
          { name: "maxRuns", type: "uint32" },
          { name: "runs", type: "uint32" },
          { name: "nextRunAt", type: "uint64" },
          { name: "active", type: "bool" },
          { name: "prompt", type: "string" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "createFor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "everySeconds", type: "uint64" },
      { name: "maxRuns", type: "uint32" },
      { name: "prompt", type: "string" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function",
    name: "markRun",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "jobsOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256[]" }],
  },
] as const;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  try {
    if (req.method === "GET") {
      const owner = String(req.query.owner ?? "");
      const client = reader();
      const deployment = loadLiveDeployment();
      const recurring = deployment.contracts.recurringRegistry as Address | undefined;
      if (!recurring) return send(res, 200, { jobs: [], due: [] });
      if (owner.startsWith("0x") && owner.length === 42) {
        const ids = (await client.publicClient.readContract({
          address: recurring,
          abi: RECURRING_ABI,
          functionName: "jobsOf",
          args: [owner as Address],
        })) as bigint[];
        const jobs = await Promise.all(ids.map((id) => readJob(client, recurring, id)));
        return send(res, 200, { owner, jobs });
      }
      const due = (await client.publicClient.readContract({
        address: recurring,
        abi: RECURRING_ABI,
        functionName: "dueIds",
        args: [20n],
      })) as bigint[];
      return send(res, 200, { due: due.map((d) => Number(d)) });
    }

    if (req.method !== "POST") return send(res, 405, { error: "GET or POST" });
    const body = (readBody(req) ?? {}) as {
      action?: string;
      owner?: Address;
      everySeconds?: number;
      maxRuns?: number;
      prompt?: string;
    };
    const action = body.action ?? "tick";
    const coordinator = operatorClient("COORDINATOR_PRIVATE_KEY");
    const deployment = loadLiveDeployment();
    const recurring = deployment.contracts.recurringRegistry as Address | undefined;
    if (!recurring) return send(res, 400, { error: "no recurring registry on this deployment" });

    if (action === "create") {
      if (!body.owner || !body.prompt) return send(res, 400, { error: "owner and prompt required" });
      const everySeconds = Math.max(60, Number(body.everySeconds ?? 604_800));
      const maxRuns = Number(body.maxRuns ?? 0);
      const hash = await coordinator.write(recurring, RECURRING_ABI as any, "createFor", [
        body.owner,
        BigInt(everySeconds),
        maxRuns,
        body.prompt,
      ]);
      return send(res, 200, { ok: true, hash, everySeconds, maxRuns });
    }

    const due = (await coordinator.publicClient.readContract({
      address: recurring,
      abi: RECURRING_ABI,
      functionName: "dueIds",
      args: [8n],
    })) as bigint[];
    const ran: { id: number; intentId?: Hex; hash?: Hex; error?: string }[] = [];
    for (const id of due) {
      try {
        const job = await readJob(coordinator, recurring, id);
        const submitted = await declareFromJob(job.owner, job.prompt);
        await coordinator.write(recurring, RECURRING_ABI as any, "markRun", [id]);
        ran.push({ id: Number(id), intentId: submitted.intentId, hash: submitted.hash });
      } catch (error) {
        ran.push({ id: Number(id), error: (error as Error).message });
      }
    }
    send(res, 200, { ok: true, ran });
  } catch (error) {
    send(res, 500, { error: (error as Error).message });
  }
}

async function readJob(client: ReturnType<typeof reader>, recurring: Address, id: bigint) {
  const job = (await client.publicClient.readContract({
    address: recurring,
    abi: RECURRING_ABI,
    functionName: "jobAt",
    args: [id],
  })) as {
    owner: Address;
    everySeconds: bigint;
    maxRuns: number;
    runs: number;
    nextRunAt: bigint;
    active: boolean;
    prompt: string;
  };
  return { ...job, id: Number(id) };
}

async function declareFromJob(owner: Address, prompt: string) {
  const deployment = loadLiveDeployment();
  const client = operatorClient("COORDINATOR_PRIVATE_KEY");
  const parsed = await parseIntent(prompt, {
    catalog: catalog(),
    recipient: owner,
    now: await client.chainNow(),
    auctionSeconds: 30,
    ttlSeconds: 180,
  });
  const draft = retimeDraft(parsed.draft, {
    now: (await client.chainNow()) + 8,
    auctionSeconds: 30,
    ttlSeconds: 180,
  });
  draft.outcome.recipient = owner;
  const outcomeHash = hashOutcome(draft.outcome);
  const policyHash = hashPolicy(draft.policy);
  const registry = deployment.contracts.intentRegistry!;
  const nonce = (await client.publicClient.readContract({
    address: registry,
    abi: INTENT_REGISTRY_ABI,
    functionName: "nonces",
    args: [owner],
  })) as bigint;
  const integrator = "0x0000000000000000000000000000000000000000" as Address;
  const metadataURI = (draft.metadata.prompt ?? prompt).slice(0, 500);
  const signature = await client.walletClient!.signTypedData({
    account: client.account!,
    domain: submitDomain(deployment.chainId, registry),
    types: SUBMIT_TYPES,
    primaryType: "Submit",
    message: {
      owner,
      kind: draft.outcome.kind,
      outcomeHash,
      policyHash,
      salt: draft.salt,
      auctionEndsAt: draft.auctionEndsAt,
      deadline: draft.deadline,
      legCount: draft.outcome.legs.length,
      integrator,
      metadataURI,
      nonce,
    },
  });
  const hash = await client.write(registry, INTENT_REGISTRY_ABI, "submitFor", [
    owner,
    draft.salt,
    draft.outcome.kind,
    outcomeHash,
    policyHash,
    draft.outcome.legs.length,
    draft.auctionEndsAt,
    draft.deadline,
    integrator,
    metadataURI,
    signature,
  ]);
  const intentId = computeIntentId({
    chainId: deployment.chainId,
    registry,
    owner,
    outcomeHash,
    policyHash,
    salt: draft.salt,
    auctionEndsAt: draft.auctionEndsAt,
    deadline: draft.deadline,
  });
  return { intentId, hash, draft };
}
