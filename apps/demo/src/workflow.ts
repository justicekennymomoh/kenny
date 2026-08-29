import { IndexedDbJournal, Resumable, type StepDef } from "@recovery/core";
import { demoBackend } from "./demoBackend";

export const WORKFLOW_ID = "onboard_maya_v1";

export const baseInputs: Record<string, unknown> = {
  create_employee: { name: "Maya" },
  create_workspace: { name: "Maya" },
  assign_figma: { name: "Maya" },
  order_laptop: { name: "Maya" },
  book_orientation: { name: "Maya", slot: "Monday" },
  send_welcome_email: { name: "Maya" },
};

export const onboardingSteps: StepDef[] = [
  {
    id: "create_employee",
    title: "Create employee account",
    semantics: "REVERSIBLE",
    run: (args, ctx) => demoBackend.createEmployee(args as { name: string }, ctx),
    inverse: (args) => demoBackend.deleteEmployee(args as { name: string }),
  },
  {
    id: "create_workspace",
    title: "Create workspace account",
    semantics: "REVERSIBLE",
    run: (args, ctx) => demoBackend.createWorkspace(args as { name: string }, ctx),
    inverse: (args) => demoBackend.deleteWorkspace(args as { name: string }),
  },
  {
    id: "assign_figma",
    title: "Assign design software licence",
    semantics: "REVERSIBLE",
    run: (args, ctx) => demoBackend.assignFigma(args as { name: string }, ctx),
    inverse: (args) => demoBackend.revokeFigma(args as { name: string }),
  },
  {
    id: "order_laptop",
    title: "Order laptop",
    semantics: "COMPENSATABLE",
    run: (args, ctx) => demoBackend.orderLaptop(args as { name: string }, ctx),
    inverse: (args, result) =>
      demoBackend.cancelLaptop(args, result as { orderId: string }),
  },
  {
    id: "book_orientation",
    title: "Book orientation",
    semantics: "COMPENSATABLE",
    run: (args, ctx) =>
      demoBackend.bookOrientation(args as { name: string; slot: string }, ctx),
    inverse: (args, result) =>
      demoBackend.cancelOrientation(args, result as { bookingId: string }),
  },
  {
    id: "send_welcome_email",
    title: "Send welcome email",
    semantics: "IRREVERSIBLE",
    run: (args, ctx) => demoBackend.sendWelcomeEmail(args as { name: string }, ctx),
  },
];

export const resumable = new Resumable(
  WORKFLOW_ID,
  onboardingSteps,
  new IndexedDbJournal("selective-recovery-demo", "journal-events"),
);
