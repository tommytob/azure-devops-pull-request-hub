import { EvaluationPolicyType } from "./GitModels";

/**
 * The little a policy summary needs from an evaluation, so this can be reasoned
 * about and tested without the rest of the Git API.
 */
export interface PolicyEvaluationLike {
  status?: string;
  configuration: {
    isEnabled: boolean;
    isBlocking: boolean;
    type: { id: string };
  };
}

export interface PolicySummary {
  /** Every blocking policy that is not about reviewers is satisfied. */
  isAllPoliciesOk: boolean;
  /** One of them was rejected or is broken, which is a failure rather than a wait. */
  arePoliciesRejected: boolean;
  /**
   * Whether the reviewer policies are satisfied, or undefined when the
   * repository configures none - which is not the same as configuring one that
   * is unmet.
   */
  areReviewerPoliciesOk: boolean | undefined;
}

/** Reviewer state is shown by the Reviewers column, so these are summarised apart. */
const isReviewerPolicy = (evaluation: PolicyEvaluationLike): boolean =>
  evaluation.configuration.type.id === EvaluationPolicyType.MinimumReviewers ||
  evaluation.configuration.type.id === EvaluationPolicyType.RequiredReviewers;

/**
 * "Require a merge strategy" judges which merge will be used, and that is only
 * known at completion - so it reports rejected for the entire life of a pull
 * request. Counting it makes every row look broken, and it is why every row used
 * to show a spinner: the old check demanded approval from every blocking policy,
 * which this one never gives.
 */
const isDecidedAtCompletion = (evaluation: PolicyEvaluationLike): boolean =>
  evaluation.configuration.type.id === EvaluationPolicyType.MergeStrategy;

/** notApplicable counts as satisfied - a policy that does not apply should not hold a pull request. */
const isSatisfied = (evaluation: PolicyEvaluationLike): boolean =>
  evaluation.status === "approved" || evaluation.status === "notApplicable";

const hasFailed = (evaluation: PolicyEvaluationLike): boolean =>
  evaluation.status === "rejected" || evaluation.status === "broken";

export function isCountedPolicy(evaluation: PolicyEvaluationLike): boolean {
  return (
    evaluation.configuration.isEnabled === true &&
    evaluation.configuration.isBlocking === true &&
    isDecidedAtCompletion(evaluation) === false
  );
}

export function summarisePolicies(
  evaluations: PolicyEvaluationLike[]
): PolicySummary {
  const counted = evaluations.filter(isCountedPolicy);
  const reviewerPolicies = counted.filter(isReviewerPolicy);
  const otherPolicies = counted.filter(
    (evaluation) => isReviewerPolicy(evaluation) === false
  );

  return {
    isAllPoliciesOk: otherPolicies.every(isSatisfied),
    arePoliciesRejected: otherPolicies.some(hasFailed),
    areReviewerPoliciesOk:
      reviewerPolicies.length === 0
        ? undefined
        : reviewerPolicies.every(isSatisfied),
  };
}
