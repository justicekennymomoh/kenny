import { useCallback, useEffect, useMemo, useState } from "react";
import type { RecoveryPlan, Scoreboard, StepSnapshot } from "@recovery/core";
import { demoBackend, emptyDemoState, type DemoState } from "./demoBackend";
import { clearDemoState } from "./demoStorage";
import {
  getProposal,
  setProposal,
  type OrientationSlot,
  type RecoveryProposal,
} from "./proposals";
import {
  approvalMatchesCurrentProposal,
  buildRecoveryContract,
  type ApplicationRecoveryContract,
} from "./recoveryContract";
import { baseInputs, onboardingSteps, resumable } from "./workflow";
import {
  createDemoTools,
  registerDemoTools,
  serializeDemoMutation,
} from "./webmcp";
import "./styles.css";

const emptyScore: Scoreboard = {
  completed: 0,
  failuresRecovered: 0,
  actionsPreserved: 0,
  duplicatesPrevented: 0,
  recoveryActionsRun: 0,
  irreversibleActionsGated: 0,
};

const emptyContract: ApplicationRecoveryContract = {
  steps: [],
  resumePoint: null,
  failure: null,
  validApprovalExists: false,
  canResume: false,
};

const capabilityDefinitions = [
  { tool: "get_onboarding_state", label: "Inspect state" },
  { tool: "get_recovery_plan", label: "Inspect recovery plan" },
  { tool: "search_orientation_slots", label: "Search alternatives" },
  { tool: "propose_recovery", label: "Propose recovery" },
  { tool: "resume_onboarding", label: "Resume after authorization" },
] as const;

const compactStepTitles: Record<string, string> = {
  create_employee: "Employee account",
  create_workspace: "Workspace",
  assign_figma: "Design software licence",
  order_laptop: "Laptop order",
  book_orientation: "Book orientation",
  send_welcome_email: "Welcome email",
};

type VisualStepState =
  | "not-started"
  | "running"
  | "done"
  | "failed"
  | "preserved"
  | "blocked";

function semanticLabel(value: StepSnapshot["semantics"]) {
  return value.toLowerCase().replace("_", " ");
}

function visualStepState(
  step: StepSnapshot,
  plan: RecoveryPlan | null,
  complete: boolean,
): VisualStepState {
  if (!complete && plan?.preserve.includes(step.id)) return "preserved";
  if (!complete && plan?.blocked.some((item) => item.step === step.id)) return "blocked";
  if (step.status === "running") return "running";
  if (step.status === "done") return "done";
  if (step.status === "failed") return "failed";
  return "not-started";
}

function statePresentation(state: VisualStepState) {
  return {
    "not-started": { icon: "○", label: "Not started" },
    running: { icon: "●", label: "Running" },
    done: { icon: "✓", label: "Done" },
    failed: { icon: "!", label: "Failed" },
    preserved: { icon: "✓", label: "Preserved" },
    blocked: { icon: "■", label: "Blocked" },
  }[state];
}

export default function App() {
  const [steps, setSteps] = useState<StepSnapshot[]>([]);
  const [plan, setPlan] = useState<RecoveryPlan | null>(null);
  const [score, setScore] = useState<Scoreboard>(emptyScore);
  const [backend, setBackend] = useState<DemoState>(() => emptyDemoState());
  const [proposal, setProposalState] = useState<RecoveryProposal | null>(null);
  const [contract, setContract] =
    useState<ApplicationRecoveryContract>(emptyContract);
  const [webmcp, setWebmcp] = useState<{ available: boolean; registered: string[] }>({
    available: false,
    registered: [],
  });
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState(
    "Ready. Ask your agent to start Maya’s Monday onboarding.",
  );

  const refresh = useCallback(async () => {
    const [nextSteps, nextPlan, nextScore, nextBackend, nextProposal] =
      await Promise.all([
        resumable.snapshot(),
        resumable.getRecoveryPlan(),
        resumable.scoreboard(),
        demoBackend.state(),
        getProposal(),
      ]);
    const validApproval = await approvalMatchesCurrentProposal(nextProposal);
    setSteps(nextSteps);
    setPlan(nextPlan);
    setContract(buildRecoveryContract(nextSteps, nextPlan, validApproval));
    setScore(nextScore);
    setBackend(nextBackend);
    setProposalState(nextProposal);
    setReady(true);
  }, []);

  useEffect(() => {
    void refresh().catch((error) => setMessage(`Persistence error: ${String(error)}`));
    const unsubscribe = resumable.subscribe(() => void refresh());
    const externalRefresh = () => void refresh();
    window.addEventListener("demo-backend-changed", externalRefresh);
    window.addEventListener("recovery-proposal-changed", externalRefresh);
    return () => {
      unsubscribe();
      window.removeEventListener("demo-backend-changed", externalRefresh);
      window.removeEventListener("recovery-proposal-changed", externalRefresh);
    };
  }, [refresh]);

  useEffect(() => {
    const owner = new AbortController();
    let dispose: () => void = () => owner.abort();
    void registerDemoTools(owner.signal)
      .then((result) => {
        dispose = result.dispose;
        if (owner.signal.aborted) return result.dispose();
        setWebmcp({ available: result.available, registered: result.registered });
      })
      .catch((error) => {
        if (owner.signal.aborted) return;
        setWebmcp({ available: false, registered: [] });
        setMessage(`WebMCP registration error: ${String(error)}`);
      });
    return () => {
      owner.abort();
      dispose();
    };
  }, []);

  const runFailureScenario = () => serializeDemoMutation(async () => {
    setBusy(true);
    setMessage("Agent workflow running…");
    try {
      await resumable.run(baseInputs);
      setMessage("Workflow completed.");
    } catch {
      setMessage("Monday is full. Valid completed work has been preserved.");
    } finally {
      setBusy(false);
      await refresh();
    }
  });

  const createProposal = (slot: OrientationSlot = "Tuesday") => serializeDemoMutation(async () => {
    if (!(await resumable.getRecoveryPlan())) {
      setMessage("There is no failed step to recover yet.");
      return;
    }
    await setProposal({
      id: `proposal_${globalThis.crypto.randomUUID()}`,
      slot,
      status: "pending",
    });
    setMessage(`Agent proposed ${slot}. Human approval is required to continue.`);
  });

  const approveProposal = (expectedProposalId: string) => serializeDemoMutation(async () => {
    const current = await getProposal();
    if (
      !current ||
      current.id !== expectedProposalId ||
      current.status !== "pending"
    ) {
      setMessage("Approval blocked: the visible proposal is stale. Review the current proposal.");
      await refresh();
      return;
    }
    const approvalId = await resumable.grantApproval(
      ["send_welcome_email"],
      `Human approved recovery to ${current.slot} and the final welcome email`,
      current.id,
    );
    await setProposal({ ...current, status: "approved", approvalId });
    setMessage("Recovery approved. The agent can now resume the workflow.");
  });

  const resume = (expectedProposalId: string) => serializeDemoMutation(async () => {
    const current = await getProposal();
    const approvalValid = await approvalMatchesCurrentProposal(current);
    if (
      !current ||
      current.id !== expectedProposalId ||
      current.status !== "approved" ||
      !current.approvalId ||
      !approvalValid
    ) {
      setMessage("Resume blocked: approval is missing, stale, or does not match the current proposal.");
      await refresh();
      return;
    }
    setBusy(true);
    setMessage("Resuming from the failed orientation step…");
    try {
      await resumable.resumeFrom(
        "book_orientation",
        { ...baseInputs, book_orientation: { name: "Maya", slot: current.slot } },
        { approvalId: current.approvalId },
      );
      setMessage("Recovered. Maya’s onboarding completed without repeating valid work.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      await refresh();
    }
  });

  const reset = () => serializeDemoMutation(async () => {
    setBusy(true);
    try {
      await resumable.reset();
      await clearDemoState();
      window.dispatchEvent(new CustomEvent("demo-backend-changed"));
      window.dispatchEvent(new CustomEvent("recovery-proposal-changed"));
      setMessage("Reset complete. Ask your agent to start Maya’s Monday onboarding.");
      await refresh();
    } catch (error) {
      setMessage(`Reset failed: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  });

  const orderCount = useMemo(
    () => Object.values(backend.orders).filter((status) => status === "placed").length,
    [backend.orders],
  );
  const completedActionsRepeated = useMemo(
    () => steps.reduce(
      (total, step) => total + Math.max(
        0,
        step.attempts - 1 - (step.hadFailure ? 1 : 0),
      ),
      0,
    ),
    [steps],
  );
  const booking = Object.values(backend.bookings)[0] ?? "—";
  const workflowComplete = steps.length > 0 && steps.every((step) => step.status === "done");
  const workflowStatus = workflowComplete
    ? "complete"
    : steps.some((step) => step.status === "failed") ? "paused" : "idle";
  const activityMessage = workflowComplete
    ? "Recovered. Maya’s onboarding completed without repeating valid work."
    : message;
  const declaredToolNames = useMemo(
    () => createDemoTools().map((tool) => tool.name),
    [],
  );
  const toolBoundary = webmcp.available ? webmcp.registered : declaredToolNames;
  const webmcpAgentMode =
    webmcp.available &&
    webmcp.registered.length === declaredToolNames.length &&
    declaredToolNames.every((name) => webmcp.registered.includes(name));
  const agentCapabilities = capabilityDefinitions.filter(({ tool }) =>
    toolBoundary.includes(tool),
  );
  const approvalTools = toolBoundary.filter((name) => name.includes("approve"));

  return (
    <main
      className="shell"
      data-testid="demo-root"
      data-ready={ready ? "true" : "false"}
      data-workflow-status={workflowStatus}
      aria-busy={busy}
    >
      <header className="topbar">
        <div className="project-label">
          <span className="project-mark" aria-hidden="true">K</span>
          <div><strong>Kenny</strong><span>Selective recovery with WebMCP</span></div>
        </div>
        <div className="topbar-actions">
          <div
            className={`mcp-status ${webmcpAgentMode ? "live" : "offline"}`}
            data-testid="webmcp-status"
            aria-label={webmcpAgentMode
              ? `WebMCP, ${webmcp.registered.length} tools connected`
              : "WebMCP unavailable, manual demo mode"}
          >
            <strong>WebMCP</strong>
            <span><i className="status-dot" aria-hidden="true" />{webmcpAgentMode
              ? `${webmcp.registered.length} tools connected`
              : "Unavailable — manual demo mode"}</span>
          </div>
          <button className="button quiet" onClick={reset} disabled={busy || !ready} aria-label="Reset demo to its initial state">
            Reset demo
          </button>
        </div>
      </header>

      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">SELECTIVE RECOVERY, MADE VISIBLE</p>
        <h1 id="page-title">Preserve the good work. Recover the broken part.</h1>
        <div className="demo-brief">
          <div><span>Agent request</span><strong>“Onboard Maya, our new designer, for Monday.”</strong></div>
          <div className="demo-controls">
            <span className="mode-label">{webmcpAgentMode ? "Agent-driven path active" : "Manual demo control"}</span>
            {webmcpAgentMode ? (
              <details className="manual-test-controls hero-manual-controls">
                <summary>Manual test controls</summary>
                <div className="manual-control-body">
                  <button className="button quiet" onClick={runFailureScenario} disabled={busy || !ready || workflowStatus !== "idle"}>
                    Run failure scenario
                  </button>
                </div>
              </details>
            ) : (
              <button className="button primary" onClick={runFailureScenario} disabled={busy || !ready || workflowStatus !== "idle"}>
                Run failure scenario
              </button>
            )}
          </div>
        </div>
      </section>

      <div className="activity-message" role="status" aria-live="polite">
        <span className={`activity-pulse ${busy ? "active" : ""}`} aria-hidden="true" />{activityMessage}
      </div>

      <div className="layout">
        <section className="panel timeline-panel" aria-labelledby="workflow-title">
          <div className="panel-heading">
            <div><span className="eyebrow">LIVE WORKFLOW</span><h2 id="workflow-title">Maya’s onboarding</h2></div>
            <span className={`workflow-state ${workflowStatus}`}>
              {workflowStatus === "complete" ? "Recovered" : workflowStatus === "paused" ? "Paused safely" : "Ready"}
            </span>
          </div>

          <ol className="steps">
            {onboardingSteps.map((definition, index) => {
              const step = steps.find((item) => item.id === definition.id) ?? {
                id: definition.id,
                title: definition.title,
                semantics: definition.semantics,
                status: "not_started" as const,
                attempts: 0,
                hadFailure: false,
              };
              const visualState = visualStepState(step, plan, workflowComplete);
              const presentation = statePresentation(visualState);
              return (
                <li
                  className={`step ${visualState}`}
                  key={step.id}
                  data-testid={`step-${step.id}`}
                  data-status={step.status}
                  data-visual-status={visualState}
                >
                  <div className="step-rail" aria-hidden="true"><span className="step-icon">{presentation.icon}</span></div>
                  <div className="step-main">
                    <div className="step-title-row">
                      <div className="step-name"><span className="step-number">0{index + 1}</span><strong>{step.title}</strong></div>
                      <span className={`semantic ${step.semantics.toLowerCase()}`}>{semanticLabel(step.semantics)}</span>
                    </div>
                    <div className="step-meta">
                      <span className={`state-label ${visualState}`}>{presentation.label}</span>
                      {step.attempts > 0 && <span>{step.attempts} attempt{step.attempts === 1 ? "" : "s"}</span>}
                    </div>
                    {visualState === "failed" && (
                      <div className="failure-detail"><strong>Monday orientation is fully booked.</strong><code>ORIENTATION_FULL</code></div>
                    )}
                    {visualState === "blocked" && <p className="blocked-detail">Held until a human approves recovery.</p>}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>

        <aside className="right-column">
          <section className={`panel recovery-panel ${workflowComplete ? "recovered" : ""}`} aria-labelledby="recovery-title">
            <span className="eyebrow">RECOVERY</span>
            {workflowComplete ? (
              <div className="recovered-state">
                <div className="recovered-icon" aria-hidden="true">✓</div>
                <div><h2 id="recovery-title">Recovered</h2><p>The workflow resumed at orientation and completed.</p></div>
                <div className="outcome-list">
                  <div><strong>4</strong><span>valid actions preserved</span></div>
                  <div><strong>1</strong><span>failed step replaced</span></div>
                  <div><strong>0</strong><span>completed actions repeated</span></div>
                </div>
              </div>
            ) : !plan ? (
              <div className="empty-state">
                <div className="empty-icon" aria-hidden="true">○</div>
                <div><h2 id="recovery-title">No recovery needed.</h2><p>If one step fails, valid completed actions will stay intact.</p></div>
              </div>
            ) : (
              <div className="recovery-story">
                <h2 id="recovery-title"><strong>{plan.preserve.length}</strong> completed actions are still valid.</h2>

                <section className="recovery-group preserve-group" aria-label="Actions to preserve">
                  <div className="group-heading"><span>Preserve</span><strong>{plan.preserve.length} untouched</strong></div>
                  <div className="preserve-list">
                    {plan.preserve.map((stepId) => <div key={stepId}><span aria-hidden="true">✓</span>{compactStepTitles[stepId]}</div>)}
                  </div>
                </section>

                <section className="recovery-group recover-group" aria-label="Action to recover">
                  <div className="group-heading"><span>Recover</span></div>
                  <div className="recover-route">
                    <div><strong>Book orientation</strong><span>Replace failed input</span></div>
                    <div className="slot-change" aria-label="Change orientation from Monday to Tuesday">
                      <span>Monday</span><b aria-hidden="true">→</b><strong>{proposal?.slot ?? "Tuesday"}</strong>
                    </div>
                  </div>
                </section>

                <section className="recovery-group blocked-group" aria-label="Blocked action">
                  <div className="group-heading"><span>Blocked</span></div>
                  <div className="blocked-row">
                    <span className="lock-icon" aria-hidden="true">■</span>
                    <div><strong>Welcome email</strong><span>Requires human approval</span></div>
                  </div>
                </section>

                {!proposal && (
                  <div className="proposal-action">
                    {webmcpAgentMode ? (
                      <>
                        <p>Ask the connected agent to propose a recovery slot.</p>
                        <details className="manual-test-controls recovery-manual-controls">
                          <summary>Manual test controls</summary>
                          <div className="manual-control-body">
                            <button className="button quiet full" onClick={() => void createProposal("Tuesday")}>Propose Tuesday recovery</button>
                          </div>
                        </details>
                      </>
                    ) : (
                      <>
                        <button className="button secondary full" onClick={() => void createProposal("Tuesday")}>Propose Tuesday recovery</button>
                        <span>Manual demo control</span>
                      </>
                    )}
                  </div>
                )}

                {proposal?.status === "pending" && (
                  <div className="approval-card">
                    <div className="approval-heading">
                      <span className="decision-icon" aria-hidden="true">!</span>
                      <div><span className="approval-label">Human decision required</span><strong>Approve the safe recovery plan?</strong></div>
                    </div>
                    <p>Preserve four completed actions, use {proposal.slot}, then release the welcome email.</p>
                    <button className="button approve full" onClick={() => void approveProposal(proposal.id)}>Approve recovery</button>
                  </div>
                )}

                {proposal?.status === "approved" && (
                  <div className="approved-card" role="status">
                    <div className="approved-mark" aria-hidden="true">✓</div>
                    {webmcpAgentMode ? (
                      <div className="agent-resume-state">
                        <p>Recovery approved. Waiting for the agent to resume the workflow.</p>
                        <details className="manual-test-controls recovery-manual-controls">
                          <summary>Manual test controls</summary>
                          <div className="manual-control-body">
                            <button className="button quiet full" onClick={() => void resume(proposal.id)} disabled={busy}>Resume safely</button>
                          </div>
                        </details>
                      </div>
                    ) : (
                      <div className="manual-resume">
                        <strong>Recovery approved</strong><span>Resume from orientation when ready.</span>
                        <button className="button primary full" onClick={() => void resume(proposal.id)} disabled={busy}>Resume safely</button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="panel proof-panel" aria-labelledby="proof-title">
            <div className="proof-heading">
              <div><span className="eyebrow">PROOF</span><h2 id="proof-title">Side effects</h2></div>
              {workflowComplete && <span className="verified-badge">Verified</span>}
            </div>
            <dl className="proof-list">
              <div><dt>Employee accounts</dt><dd data-testid="employees-count">{backend.employees.length}</dd></div>
              <div><dt>Workspaces</dt><dd data-testid="workspaces-count">{backend.workspaces.length}</dd></div>
              <div><dt>Design software licences</dt><dd data-testid="figma-count">{backend.figma.length}</dd></div>
              <div><dt>Laptop orders</dt><dd data-testid="laptops-count">{orderCount}</dd></div>
              <div><dt>Welcome emails</dt><dd data-testid="emails-count">{backend.emails.length}</dd></div>
              <div className="orientation-proof"><dt>Orientation</dt><dd data-testid="orientation-value">{booking}</dd></div>
            </dl>
            <div className="proof-summary" aria-label="Recovery summary">
              <span><strong>{score.actionsPreserved}</strong> valid actions preserved</span>
              {plan && !workflowComplete ? (
                <span>Recovery pending</span>
              ) : workflowComplete ? (
                <span><strong>{score.failuresRecovered}</strong> failed action recovered</span>
              ) : (
                <span>Recovery not started</span>
              )}
              <span><strong>{completedActionsRepeated}</strong> completed actions repeated</span>
            </div>
          </section>
        </aside>
      </div>

      <details className="panel contract-inspector" data-testid="recovery-contract-inspector">
        <summary>
          <span><span className="eyebrow">TECHNICAL INSPECTOR</span><strong>Recovery contract</strong></span>
          <span className="inspector-summary">
            {contract.resumePoint ? `Resume: ${contract.resumePoint}` : "No active resume point"}
          </span>
        </summary>

        <div className="inspector-content">
          <div className="contract-overview">
            <div><span>Current failure</span><strong>{contract.failure?.step ?? "None"}</strong></div>
            <div><span>Valid approval</span><strong>{contract.validApprovalExists ? "Yes" : "No"}</strong></div>
            <div><span>Agent can resume</span><strong>{contract.canResume ? "Yes" : "No"}</strong></div>
            <div><span>Resume point</span><strong>{contract.resumePoint ?? "None"}</strong></div>
          </div>

          <div className="contract-table" role="table" aria-label="Application-declared recovery contract">
            <div className="contract-row contract-header" role="row">
              <span role="columnheader">Step</span>
              <span role="columnheader">Semantics</span>
              <span role="columnheader">Status</span>
              <span role="columnheader">Disposition</span>
              <span role="columnheader">Human approval</span>
            </div>
            {contract.steps.map((item) => (
              <div
                className="contract-row"
                role="row"
                key={item.step}
                data-testid={`contract-step-${item.step}`}
                data-disposition={item.disposition ?? "NONE"}
              >
                <span role="cell" className="contract-step-name" data-label="Step">
                  <strong>{item.title}</strong>
                  <code>{item.step}</code>
                  {item.step === contract.resumePoint && <em>Resume point</em>}
                </span>
                <span role="cell" data-label="Semantics">{item.semantics}</span>
                <span role="cell" data-label="Status">{item.status}</span>
                <span role="cell" data-label="Disposition" className={`disposition ${item.disposition?.toLowerCase() ?? "none"}`}>{item.disposition ?? "—"}</span>
                <span role="cell" data-label="Human approval">{item.requiresHumanApproval ? "Required" : "No"}</span>
              </div>
            ))}
          </div>

          <div className="capability-boundary">
            <div>
              <span className="eyebrow">AGENT CAPABILITIES</span>
              <ul>{agentCapabilities.map(({ tool, label }) => <li key={tool}>{label}<code>{tool}</code></li>)}</ul>
            </div>
            <div className="human-boundary">
              <span className="eyebrow">HUMAN-ONLY CAPABILITY</span>
              <strong>Approve recovery</strong>
              <p className="approval-boundary-note">{approvalTools.length === 0
                ? "No WebMCP approval tool exists."
                : `Unexpected approval tools: ${approvalTools.join(", ")}`}</p>
              <small>{toolBoundary.length} {webmcp.available ? "registered" : "declared"} WebMCP tools</small>
            </div>
          </div>
        </div>
      </details>
    </main>
  );
}
