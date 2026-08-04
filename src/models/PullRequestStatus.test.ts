import { evaluatePullRequestStatus } from "./PullRequestStatus";

const APPROVED = 10;
const APPROVED_WITH_SUGGESTIONS = 5;
const NO_VOTE = 0;
const WAITING_FOR_AUTHOR = -5;
const REJECTED = -10;

const base = {
  isDraft: false,
  hasFailures: false,
  votes: [] as number[],
  requiredVotes: [] as number[],
  nonReviewerPoliciesOk: true,
  nonReviewerPoliciesFailed: false,
  reviewerPoliciesOk: undefined as boolean | undefined,
};

describe("draft pull requests", () => {
  it("never reads as ready, however green everything else is", () => {
    const status = evaluatePullRequestStatus({
      ...base,
      isDraft: true,
      votes: [APPROVED, APPROVED],
      requiredVotes: [APPROVED],
      reviewerPoliciesOk: true,
    });

    expect(status.kind).toBe("draft");
  });

  it("still surfaces merge conflicts, which matter before completion", () => {
    const status = evaluatePullRequestStatus({
      ...base,
      isDraft: true,
      hasFailures: true,
    });

    expect(status.kind).toBe("failed");
  });
});

describe("reviewer policies", () => {
  it("waits on review when the minimum-approvers policy is pending, even with every check green", () => {
    const status = evaluatePullRequestStatus({
      ...base,
      votes: [NO_VOTE, NO_VOTE],
      nonReviewerPoliciesOk: true,
      reviewerPoliciesOk: false,
    });

    expect(status.kind).toBe("waitingReview");
  });

  it("is ready once Azure DevOps reports the reviewer policy satisfied", () => {
    const status = evaluatePullRequestStatus({
      ...base,
      votes: [APPROVED, NO_VOTE],
      reviewerPoliciesOk: true,
    });

    expect(status.kind).toBe("ready");
  });
});

describe("without any reviewer policy", () => {
  it("does not call an unreviewed pull request ready just because nobody is required", () => {
    const status = evaluatePullRequestStatus({
      ...base,
      votes: [],
      requiredVotes: [],
      reviewerPoliciesOk: undefined,
    });

    expect(status.kind).toBe("waitingReview");
  });

  it("is ready when every reviewer approved", () => {
    const status = evaluatePullRequestStatus({
      ...base,
      votes: [APPROVED, APPROVED_WITH_SUGGESTIONS],
      reviewerPoliciesOk: undefined,
    });

    expect(status.kind).toBe("ready");
  });

  it("prefers the required reviewers over the optional ones", () => {
    const status = evaluatePullRequestStatus({
      ...base,
      votes: [APPROVED, NO_VOTE],
      requiredVotes: [APPROVED],
      reviewerPoliciesOk: undefined,
    });

    expect(status.kind).toBe("ready");
  });

  it("reports review in progress when some but not all have voted", () => {
    const status = evaluatePullRequestStatus({
      ...base,
      votes: [APPROVED, NO_VOTE],
      reviewerPoliciesOk: undefined,
    });

    expect(status.kind).toBe("reviewInProgress");
  });

  it("waits on review when nobody has voted yet", () => {
    const status = evaluatePullRequestStatus({
      ...base,
      votes: [NO_VOTE, NO_VOTE],
      reviewerPoliciesOk: undefined,
    });

    expect(status.kind).toBe("waitingReview");
  });
});

describe("problems outrank everything", () => {
  it("reports a rejection", () => {
    const status = evaluatePullRequestStatus({
      ...base,
      votes: [APPROVED, REJECTED],
      reviewerPoliciesOk: true,
    });

    expect(status.kind).toBe("rejected");
  });

  it("reports a reviewer waiting for the author", () => {
    const status = evaluatePullRequestStatus({
      ...base,
      votes: [APPROVED, WAITING_FOR_AUTHOR],
      reviewerPoliciesOk: true,
    });

    expect(status.kind).toBe("waitingForAuthor");
  });

  it("reports a failed check as a failure, not as something still running", () => {
    const status = evaluatePullRequestStatus({
      ...base,
      votes: [NO_VOTE, NO_VOTE],
      nonReviewerPoliciesOk: false,
      nonReviewerPoliciesFailed: true,
      reviewerPoliciesOk: false,
    });

    expect(status.kind).toBe("policiesFailed");
  });

  it("outranks a draft, so a draft with a failing check stays visible", () => {
    const status = evaluatePullRequestStatus({
      ...base,
      isDraft: true,
      nonReviewerPoliciesOk: false,
      nonReviewerPoliciesFailed: true,
    });

    expect(status.kind).toBe("policiesFailed");
  });

  it("reports pending non-reviewer policies", () => {
    const status = evaluatePullRequestStatus({
      ...base,
      votes: [APPROVED],
      nonReviewerPoliciesOk: false,
      reviewerPoliciesOk: true,
    });

    expect(status.kind).toBe("policiesPending");
  });
});
