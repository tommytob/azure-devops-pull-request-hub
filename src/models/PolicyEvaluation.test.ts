import { EvaluationPolicyType } from "./GitModels";
import {
  isCountedPolicy,
  PolicyEvaluationLike,
  summarisePolicies,
} from "./PolicyEvaluation";

const MERGE_STRATEGY = "fa4e907d-c16b-4a4c-9dfa-4916e5d171ab";

function evaluation(
  typeId: string,
  status: string,
  overrides: Partial<PolicyEvaluationLike["configuration"]> = {}
): PolicyEvaluationLike {
  return {
    status,
    configuration: {
      isEnabled: true,
      isBlocking: true,
      type: { id: typeId },
      ...overrides,
    },
  };
}

it("guards against the merge strategy id drifting from the real one", () => {
  // Recorded from a live evaluation. It differs from MinimumReviewers in four
  // characters, so a typo would silently reintroduce the bug this file exists for.
  expect(EvaluationPolicyType.MergeStrategy).toBe(MERGE_STRATEGY);
  expect(EvaluationPolicyType.MinimumReviewers).toBe(
    "fa4e907d-c16b-4a4c-9dfa-4906e5d171dd"
  );
});

describe("require a merge strategy", () => {
  it("is not counted, since it reports rejected until the pull request completes", () => {
    expect(isCountedPolicy(evaluation(MERGE_STRATEGY, "rejected"))).toBe(false);
  });

  it("does not make an otherwise healthy pull request look failed", () => {
    // Exactly the shape observed on pull request 2705: everything green except
    // the approvals, plus two rejected merge strategy evaluations.
    const summary = summarisePolicies([
      evaluation(EvaluationPolicyType.WorkItemLinking, "approved"),
      evaluation(EvaluationPolicyType.CommentRequirements, "approved"),
      evaluation(MERGE_STRATEGY, "rejected"),
      evaluation(MERGE_STRATEGY, "rejected"),
      evaluation(EvaluationPolicyType.Build, "approved"),
      evaluation(EvaluationPolicyType.MinimumReviewers, "queued"),
      evaluation(EvaluationPolicyType.RequiredReviewers, "queued", {
        isBlocking: false,
      }),
    ]);

    expect(summary.arePoliciesRejected).toBe(false);
    expect(summary.isAllPoliciesOk).toBe(true);
    expect(summary.areReviewerPoliciesOk).toBe(false);
  });
});

describe("what counts", () => {
  it("ignores policies that are disabled or not blocking", () => {
    expect(
      isCountedPolicy(
        evaluation(EvaluationPolicyType.Build, "rejected", { isEnabled: false })
      )
    ).toBe(false);
    expect(
      isCountedPolicy(
        evaluation(EvaluationPolicyType.Build, "rejected", { isBlocking: false })
      )
    ).toBe(false);
  });

  it("counts an enabled, blocking build policy", () => {
    expect(isCountedPolicy(evaluation(EvaluationPolicyType.Build, "queued"))).toBe(
      true
    );
  });
});

describe("summary", () => {
  it("reports a rejected build as a failure", () => {
    const summary = summarisePolicies([
      evaluation(EvaluationPolicyType.Build, "rejected"),
    ]);

    expect(summary.arePoliciesRejected).toBe(true);
    expect(summary.isAllPoliciesOk).toBe(false);
  });

  it("treats notApplicable as satisfied rather than pending forever", () => {
    const summary = summarisePolicies([
      evaluation(EvaluationPolicyType.WorkItemLinking, "notApplicable"),
    ]);

    expect(summary.isAllPoliciesOk).toBe(true);
    expect(summary.arePoliciesRejected).toBe(false);
  });

  it("separates a queued build from a rejected one", () => {
    const summary = summarisePolicies([
      evaluation(EvaluationPolicyType.Build, "queued"),
    ]);

    expect(summary.isAllPoliciesOk).toBe(false);
    expect(summary.arePoliciesRejected).toBe(false);
  });

  it("reports no reviewer policy as undefined, not as unmet", () => {
    const summary = summarisePolicies([
      evaluation(EvaluationPolicyType.Build, "approved"),
    ]);

    expect(summary.areReviewerPoliciesOk).toBeUndefined();
  });

  it("is satisfied when every reviewer policy is approved", () => {
    const summary = summarisePolicies([
      evaluation(EvaluationPolicyType.MinimumReviewers, "approved"),
      evaluation(EvaluationPolicyType.RequiredReviewers, "approved"),
    ]);

    expect(summary.areReviewerPoliciesOk).toBe(true);
  });

  it("says everything is fine when there are no policies at all", () => {
    const summary = summarisePolicies([]);

    expect(summary.isAllPoliciesOk).toBe(true);
    expect(summary.arePoliciesRejected).toBe(false);
    expect(summary.areReviewerPoliciesOk).toBeUndefined();
  });
});
