import {
  DEMO_STORAGE_KEYS,
  readDemoRecord,
  writeDemoRecord,
} from "./demoStorage";

export interface RecoveryProposal {
  id: string;
  slot: OrientationSlot;
  status: "pending" | "approved";
  approvalId?: string;
}

export type OrientationSlot = "Tuesday" | "Wednesday";

export function isOrientationSlot(value: unknown): value is OrientationSlot {
  return value === "Tuesday" || value === "Wednesday";
}

function isProposal(value: unknown): value is RecoveryProposal {
  if (!value || typeof value !== "object") return false;
  const proposal = value as Partial<RecoveryProposal>;
  return (
    typeof proposal.id === "string" &&
    isOrientationSlot(proposal.slot) &&
    (proposal.status === "pending" || proposal.status === "approved") &&
    (proposal.approvalId === undefined || typeof proposal.approvalId === "string")
  );
}

export async function getProposal(): Promise<RecoveryProposal | null> {
  const value = await readDemoRecord<unknown>(DEMO_STORAGE_KEYS.proposal);
  return isProposal(value) ? value : null;
}

export async function setProposal(proposal: RecoveryProposal | null) {
  await writeDemoRecord(DEMO_STORAGE_KEYS.proposal, proposal);
  window.dispatchEvent(new CustomEvent("recovery-proposal-changed"));
}
