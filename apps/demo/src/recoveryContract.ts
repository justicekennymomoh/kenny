import type {
  RecoveryPlan,
  RecoverySemantics,
  StepSnapshot,
  StepStatus,
} from "@recovery/core";
import type { RecoveryProposal } from "./proposals";
import { resumable } from "./workflow";

export type RecoveryDisposition = "PRESERVE" | "RECOVER" | "BLOCKED";

export interface RecoveryContractStep {
  step: string;
  title: string;
  semantics: RecoverySemantics;
  status: StepStatus;
  disposition?: RecoveryDisposition;
  allowedRecovery?: ["REPLACE_INPUT"];
  requiresHumanApproval: boolean;
  reason?: string;
}

export interface ApplicationRecoveryContract {
  steps: RecoveryContractStep[];
  resumePoint: string | null;
  failure: { step: string; error: string } | null;
  validApprovalExists: boolean;
  canResume: boolean;
}

const PRESERVE_REASON =
  "Completed side effect is still valid and does not need replay.";
const RECOVER_REASON =
  "Original Monday input is unavailable; successful upstream work remains valid.";
const BLOCKED_REASON =
  "Irreversible action cannot execute until the current recovery proposal is human-approved.";

export async function approvalMatchesCurrentProposal(
  proposal: RecoveryProposal | null,
): Promise<boolean> {
  if (!proposal || proposal.status !== "approved" || !proposal.approvalId) return false;

  const plan = await resumable.getRecoveryPlan();
  if (
    !plan ||
    plan.failedStep !== "book_orientation" ||
    plan.resumePoint !== "book_orientation"
  ) {
    return false;
  }

  const events = await resumable.timeline();
  return events.some((event) => {
    if (event.type !== "APPROVAL_GRANTED") return false;
    const stepIds = event.data?.stepIds;
    return (
      event.data?.approvalId === proposal.approvalId &&
      event.data?.proposalId === proposal.id &&
      Array.isArray(stepIds) &&
      stepIds.includes("send_welcome_email")
    );
  });
}

export function buildRecoveryContract(
  snapshots: StepSnapshot[],
  plan: RecoveryPlan | null,
  validApprovalExists: boolean,
): ApplicationRecoveryContract {
  const preserve = new Set(plan?.preserve ?? []);
  const blocked = new Set(plan?.blocked.map((item) => item.step) ?? []);
  const failed = snapshots.find((step) => step.status === "failed");

  const steps = snapshots.map((snapshot): RecoveryContractStep => {
    const base: RecoveryContractStep = {
      step: snapshot.id,
      title: snapshot.title,
      semantics: snapshot.semantics,
      status: snapshot.status,
      requiresHumanApproval: snapshot.semantics === "IRREVERSIBLE",
    };

    if (!plan) return base;
    if (preserve.has(snapshot.id)) {
      return { ...base, disposition: "PRESERVE", reason: PRESERVE_REASON };
    }
    if (snapshot.id === plan.failedStep) {
      return {
        ...base,
        disposition: "RECOVER",
        allowedRecovery: ["REPLACE_INPUT"],
        reason: RECOVER_REASON,
      };
    }
    if (blocked.has(snapshot.id)) {
      return { ...base, disposition: "BLOCKED", reason: BLOCKED_REASON };
    }
    return base;
  });

  return {
    steps,
    resumePoint: plan?.resumePoint ?? null,
    failure: failed
      ? { step: failed.id, error: failed.error ?? "UNKNOWN_FAILURE" }
      : null,
    validApprovalExists,
    canResume: plan !== null && validApprovalExists,
  };
}
