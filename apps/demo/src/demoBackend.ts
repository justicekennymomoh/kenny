import type { ExecutionContext } from "@recovery/core";
import {
  DEMO_STORAGE_KEYS,
  readDemoRecord,
  updateDemoRecord,
  writeDemoRecord,
} from "./demoStorage";

export interface DemoState {
  employees: string[];
  workspaces: string[];
  figma: string[];
  orders: Record<string, "placed" | "cancelled">;
  bookings: Record<string, string>;
  emails: string[];
  idempotency: Record<string, unknown>;
}

export const emptyDemoState = (): DemoState => ({
  employees: [],
  workspaces: [],
  figma: [],
  orders: {},
  bookings: {},
  emails: [],
  idempotency: {},
});

function normalizeState(value: DemoState | undefined): DemoState {
  if (!value) return emptyDemoState();
  value.employees = Array.isArray(value.employees) ? value.employees : [];
  value.workspaces = Array.isArray(value.workspaces) ? value.workspaces : [];
  value.figma = Array.isArray(value.figma) ? value.figma : [];
  value.orders = value.orders && typeof value.orders === "object" ? value.orders : {};
  value.bookings =
    value.bookings && typeof value.bookings === "object" ? value.bookings : {};
  value.emails = Array.isArray(value.emails) ? value.emails : [];
  value.idempotency =
    value.idempotency && typeof value.idempotency === "object"
      ? value.idempotency
      : {};
  return value;
}

async function load(): Promise<DemoState> {
  return normalizeState(
    await readDemoRecord<DemoState>(DEMO_STORAGE_KEYS.backend),
  );
}

async function save(state: DemoState) {
  await writeDemoRecord(DEMO_STORAGE_KEYS.backend, state);
  window.dispatchEvent(new CustomEvent("demo-backend-changed"));
}

async function mutate<T>(effect: (state: DemoState) => T): Promise<T> {
  const result = await updateDemoRecord(
    DEMO_STORAGE_KEYS.backend,
    emptyDemoState,
    (stored) => effect(normalizeState(stored)),
  );
  window.dispatchEvent(new CustomEvent("demo-backend-changed"));
  return result;
}

async function withIdempotency<T>(
  ctx: ExecutionContext,
  effect: (state: DemoState) => T,
): Promise<T> {
  return mutate((state) => {
    if (Object.prototype.hasOwnProperty.call(state.idempotency, ctx.idempotencyKey)) {
      return state.idempotency[ctx.idempotencyKey] as T;
    }
    const result = effect(state);
    state.idempotency[ctx.idempotencyKey] = structuredClone(result);
    return result;
  });
}

const wait = (ms = 420) => new Promise((resolve) => setTimeout(resolve, ms));

export const demoBackend = {
  state: load,
  async reset() {
    await save(emptyDemoState());
  },

  async createEmployee(args: { name: string }, ctx: ExecutionContext) {
    await wait();
    return withIdempotency(ctx, (state) => {
      if (!state.employees.includes(args.name)) state.employees.push(args.name);
      return { employeeId: `emp_${args.name.toLowerCase()}` };
    });
  },
  async deleteEmployee(args: { name: string }) {
    await mutate((state) => {
      state.employees = state.employees.filter((name) => name !== args.name);
    });
  },

  async createWorkspace(args: { name: string }, ctx: ExecutionContext) {
    await wait();
    return withIdempotency(ctx, (state) => {
      if (!state.workspaces.includes(args.name)) state.workspaces.push(args.name);
      return { workspace: `${args.name.toLowerCase()}@acme.test` };
    });
  },
  async deleteWorkspace(args: { name: string }) {
    await mutate((state) => {
      state.workspaces = state.workspaces.filter((name) => name !== args.name);
    });
  },

  async assignFigma(args: { name: string }, ctx: ExecutionContext) {
    await wait();
    return withIdempotency(ctx, (state) => {
      if (!state.figma.includes(args.name)) state.figma.push(args.name);
      return { licence: `figma_${args.name.toLowerCase()}` };
    });
  },
  async revokeFigma(args: { name: string }) {
    await mutate((state) => {
      state.figma = state.figma.filter((name) => name !== args.name);
    });
  },

  async orderLaptop(args: { name: string }, ctx: ExecutionContext) {
    await wait();
    return withIdempotency(ctx, (state) => {
      const orderId = `ord_${args.name.toLowerCase()}`;
      state.orders[orderId] = "placed";
      return { orderId };
    });
  },
  async cancelLaptop(_args: unknown, result: { orderId: string }) {
    await mutate((state) => {
      state.orders[result.orderId] = "cancelled";
    });
  },

  async bookOrientation(args: { name: string; slot: string }, ctx: ExecutionContext) {
    await wait(650);
    if (args.slot === "Monday") {
      throw new Error("ORIENTATION_FULL: Monday is fully booked");
    }
    return withIdempotency(ctx, (state) => {
      const bookingId = `book_${args.name.toLowerCase()}`;
      state.bookings[bookingId] = args.slot;
      return { bookingId, slot: args.slot };
    });
  },
  async cancelOrientation(_args: unknown, result: { bookingId: string }) {
    await mutate((state) => {
      delete state.bookings[result.bookingId];
    });
  },

  async sendWelcomeEmail(args: { name: string }, ctx: ExecutionContext) {
    await wait();
    return withIdempotency(ctx, (state) => {
      state.emails.push(args.name);
      return { sent: true, recipient: args.name };
    });
  },

  async searchOrientationSlots() {
    await wait(200);
    return { available: ["Tuesday", "Wednesday"] };
  },
};
