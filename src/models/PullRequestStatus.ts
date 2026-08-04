import { ReviewerVoteOption } from "./ReviewerVote";

/**
 * The distinct states a pull request row can be in. Kept separate from the
 * azure-devops-ui Statuses objects so the decision is testable on its own and
 * the icon choice stays a presentation concern.
 */
export type PullRequestStatusKind =
  | "failed"
  | "policiesFailed"
  | "rejected"
  | "waitingForAuthor"
  | "draft"
  | "policiesPending"
  | "waitingReview"
  | "reviewInProgress"
  | "ready";

export interface PullRequestStatusResult {
  kind: PullRequestStatusKind;
  label: string;
  ariaLabel: string;
}

export interface PullRequestStatusInput {
  /** Draft pull requests cannot be completed, whatever else is green. */
  isDraft: boolean;
  /** Merge conflicts or a policy rejection on the merge itself. */
  hasFailures: boolean;
  /** Votes of every reviewer on the pull request. */
  votes: number[];
  /** Votes of the reviewers marked as required. */
  requiredVotes: number[];
  /**
   * Whether every enabled, blocking policy that is *not* about reviewers has
   * been approved (or does not apply).
   */
  nonReviewerPoliciesOk: boolean;
  /**
   * Whether any of those policies was rejected or is broken. A failed check is
   * a different thing from one that has not finished, and only one of the two
   * is worth interrupting someone for.
   */
  nonReviewerPoliciesFailed: boolean;
  /**
   * Whether the reviewer policies (minimum approvers, required reviewers) are
   * satisfied. undefined when the repository has no such policy, in which case
   * the reviewer votes decide instead.
   */
  reviewerPoliciesOk: boolean | undefined;
}

const isApproved = (vote: number): boolean =>
  vote === ReviewerVoteOption.Approved ||
  vote === ReviewerVoteOption.ApprovedWithSuggestions;

/**
 * Decides which status a pull request row should show.
 *
 * Order matters: real problems (conflicts, rejections) outrank the draft flag,
 * because a draft with conflicts is still worth spotting. Everything that
 * would read as "this is fine" comes after the draft check.
 */
export function evaluatePullRequestStatus(
  input: PullRequestStatusInput
): PullRequestStatusResult {
  const { votes, requiredVotes } = input;

  if (input.hasFailures) {
    return {
      kind: "failed",
      label: "Pull Request is in failure status.",
      ariaLabel: "Pull Request is in failure status.",
    };
  }

  if (input.nonReviewerPoliciesFailed) {
    return {
      kind: "policiesFailed",
      label: "One or more policies failed",
      ariaLabel: "One or more policies failed",
    };
  }

  if (votes.some((v) => v === ReviewerVoteOption.Rejected)) {
    return {
      kind: "rejected",
      label: "One or more reviewer(s) has rejected.",
      ariaLabel: "One or more reviewer(s) has rejected.",
    };
  }

  if (votes.some((v) => v === ReviewerVoteOption.WaitingForAuthor)) {
    return {
      kind: "waitingForAuthor",
      label: "One or more reviewer(s) is waiting for the author.",
      ariaLabel: "One or more reviewer(s) is waiting for the author.",
    };
  }

  if (input.isDraft) {
    return {
      kind: "draft",
      label: "Draft",
      ariaLabel: "Draft - not ready for completion",
    };
  }

  if (input.nonReviewerPoliciesOk === false) {
    return {
      kind: "policiesPending",
      label: "Some policies are not completed",
      ariaLabel: "Waiting all policies to be completed",
    };
  }

  // With a reviewer policy in place, Azure DevOps already decides whether the
  // approval requirement is met - trust it rather than second-guessing from
  // individual votes.
  if (input.reviewerPoliciesOk === true) {
    return {
      kind: "ready",
      label: "Success",
      ariaLabel: "Ready for completion",
    };
  }

  if (input.reviewerPoliciesOk === false) {
    return {
      kind: "waitingReview",
      label: "Waiting Review of required Reviewers",
      ariaLabel: "Waiting Review of required Reviewers",
    };
  }

  // No reviewer policy exists, so the votes decide. Required reviewers take
  // precedence when there are any; otherwise every reviewer counts.
  const considered = requiredVotes.length > 0 ? requiredVotes : votes;

  // Deliberately not vacuously true: an empty list means nobody has been asked
  // to review, which is not the same as everybody having approved.
  if (considered.length === 0) {
    return {
      kind: "waitingReview",
      label: "Waiting Review",
      ariaLabel: "Waiting Review",
    };
  }

  if (considered.every(isApproved)) {
    return {
      kind: "ready",
      label: "Success",
      ariaLabel: "Ready for completion",
    };
  }

  if (considered.every((v) => v === ReviewerVoteOption.NoVote)) {
    return {
      kind: "waitingReview",
      label: "Waiting Review of required Reviewers",
      ariaLabel: "Waiting Review of required Reviewers",
    };
  }

  return {
    kind: "reviewInProgress",
    label: "Review in progress",
    ariaLabel: "Waiting remaining required Reviewers",
  };
}
