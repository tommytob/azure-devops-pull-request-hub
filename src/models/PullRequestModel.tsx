import {
  GitPullRequest,
  IdentityRefWithVote,
  GitCommitRef,
  CommentThreadStatus,
  PullRequestStatus,
} from "azure-devops-extension-api/Git";
import * as DevOps from "azure-devops-extension-sdk";
import { IStatusProps, Statuses } from "azure-devops-ui/Status";
import { getClient } from "azure-devops-extension-api";
import { GitRestClient } from "azure-devops-extension-api/Git";
import { WorkItemTrackingRestClient } from "azure-devops-extension-api/WorkItemTracking";
import { hasPullRequestFailure } from "./constants";
import {
  BranchDropDownItem,
  ReviewerVoteOption,
  IStatusIndicatorData,
  PullRequestComment,
  PullRequestPolicy,
} from "../tabs/PulRequestsTabData";
import { WebApiTagDefinition } from "azure-devops-extension-api/Core";
import { USER_SETTINGS_STORE_KEY } from "../common";
import { getEvaluationsPerPullRequest } from "../services/AzureGitServices";
import { AzureGitModels, EvaluationPolicyType } from "./GitModels";
import {
  evaluatePullRequestStatus,
  PullRequestStatusKind,
} from "./PullRequestStatus";
import { GitRepository } from 'azure-devops-extension-api/Git';
import { compare } from "../lib/date";
import { WorkItem } from "azure-devops-extension-api/WorkItemTracking";

/**
 * Kept as an alias so call sites keep their intent. The interface used to
 * widen isDisabled to boolean | undefined, which azure-devops-extension-api 5
 * now declares as a required boolean - so the override no longer compiles and
 * no longer adds anything.
 */
export type GitRepositoryModel = GitRepository;

export class PullRequestModel {
  private baseHostUrl: string = "";
  public title?: string;
  public pullRequestHref?: string;
  public repositoryHref?: string;
  public sourceBranch?: BranchDropDownItem;
  public targetBranch?: BranchDropDownItem;
  public sourceBranchHref?: string;
  public targetBranchHref?: string;
  public myApprovalStatus?: ReviewerVoteOption;
  public currentUser: DevOps.IUserContext = DevOps.getUser();
  public lastCommitId?: string;
  public lastShortCommitId?: string;
  public lastCommitUrl?: string;
  public pullRequestProgressStatus?: IStatusIndicatorData;
  public lastCommitDetails: GitCommitRef | undefined;
  public isAutoCompleteSet: boolean = false;
  public workItemsCount: number = 0;
  public workItems: WorkItem[] = [];
  public comment: PullRequestComment;
  public policies: PullRequestPolicy[] = [];
  public isAllPoliciesOk: boolean = false;
  /**
   * Whether the reviewer policies are satisfied, or undefined when the
   * repository has no reviewer policy at all. Kept apart from
   * isAllPoliciesOk so a pending approval reads as "waiting review" rather
   * than drowning out the other policies.
   */
  public areReviewerPoliciesOk: boolean | undefined = undefined;
  public hasFailures: boolean = false;
  public labels: WebApiTagDefinition[] = [];
  public lastVisit?: Date;
  private loadingData: boolean = false;
  private requiredReviewers: IdentityRefWithVote[] = [];

  constructor(
    public gitPullRequest: GitPullRequest,
    public projectName: string,
    public baseUrl: string,
    public callbackState: (pullRequestModel: PullRequestModel) => void
  ) {
    this.comment = new PullRequestComment();
    this.setupPullRequest();
  }

  public saveLastVisit = (): boolean => {
    try {
      if (this.gitPullRequest.status !== PullRequestStatus.Active) {
        return true;
      }

      this.lastVisit = new Date();
      const storeKey = `${USER_SETTINGS_STORE_KEY}_${this.gitPullRequest.pullRequestId}`;
      localStorage.setItem(storeKey, JSON.stringify(this.lastVisit));

      return true;
    } catch (error) {
      return false;
    }
  };

  public hasNewChanges(): boolean {
    return this.hasCommitChanges() || this.hasCommentChanges() ? true : false;
  }

  public hasCommentChanges(): boolean {
    return this.lastVisit &&
      this.comment.lastUpdatedDate &&
      this.comment.lastUpdatedDate > this.lastVisit
      ? true
      : false;
  }

  public hasCommitChanges(): boolean {
    return this.lastVisit &&
      this.gitPullRequest.status === PullRequestStatus.Active &&
      this.lastVisit < this.getLastCommitDate()
      ? true
      : false;
  }

  public loadLastVisit = () => {
    if (this.gitPullRequest.status !== PullRequestStatus.Active) {
      return;
    }

    const storeKey = `${USER_SETTINGS_STORE_KEY}_${this.gitPullRequest.pullRequestId}`;
    const cachedInstance = localStorage.getItem(storeKey);

    if (!cachedInstance || cachedInstance.length === 0) {
      return;
    }

    const cachedLastVisit: Date = JSON.parse(cachedInstance);
    const savedDate = new Date(cachedLastVisit.toString());

    this.lastVisit = savedDate;
  };

  public getLastCommitDate(): Date {
    return this.lastCommitDetails === undefined ||
      this.lastCommitDetails.committer === undefined
      ? this.gitPullRequest.creationDate
      : this.lastCommitDetails!.committer.date!;
  }

  public triggerState() {
    this.pullRequestProgressStatus = this.getStatusIndicatorData(
      this.gitPullRequest.reviewers,
      this.isAllPoliciesOk
    );
    this.callbackState(this);
  }

  public isStillLoading() {
    return this.loadingData;
  }

  private callTriggerState() {
    this.loadingData = false;
    this.triggerState();
  }

  public async setupPullRequest() {
    this.initializeData();
    this.loadingData = true;

    Promise.all(this.getAsyncCallList()).finally(() => {
      this.callTriggerState();
    });
  }

  private getAsyncCallList(): Promise<any>[] {
    const abandoned =
      this.gitPullRequest.status === PullRequestStatus.Abandoned;
    let callList = [];

    if (abandoned === false) {
      callList.push(
        ...[
          this.getPullRequestAdditionalDetailsAsync(),
          this.getPullRequestThreadAsync(),
          this.getPullRequestWorkItemAsync(),
          this.getPullRequestPolicyAsync(),
        ]
      );
    }

    callList.push(this.getLabels());

    return callList;
  }

  private initializeData() {
    this.baseHostUrl = `${this.baseUrl}${this.projectName}`;
    this.title = `${this.gitPullRequest.pullRequestId} - ${this.gitPullRequest.title}`;
    this.sourceBranch = new BranchDropDownItem(
      this.gitPullRequest.repository.name,
      this.gitPullRequest.sourceRefName
    );
    this.targetBranch = new BranchDropDownItem(
      this.gitPullRequest.repository.name,
      this.gitPullRequest.targetRefName
    );
    this.repositoryHref = `${this.baseHostUrl}/_git/${this.gitPullRequest.repository.name}/`;
    this.pullRequestHref = `${this.baseHostUrl}/_git/${this.gitPullRequest.repository.name}/pullrequest/${this.gitPullRequest.pullRequestId}`;
    this.sourceBranchHref = `${this.baseHostUrl}/_git/${this.gitPullRequest.repository.name}?version=GB${this.sourceBranch.branchName}`;
    this.targetBranchHref = `${this.baseHostUrl}/_git/${this.gitPullRequest.repository.name}?version=GB${this.targetBranch.branchName}`;
    this.requiredReviewers = this.gitPullRequest.reviewers
      ? this.gitPullRequest.reviewers.filter(
          (r) => r.isRequired !== undefined && r.isRequired === true
        )
      : [];
    this.myApprovalStatus = this.getCurrentUserVoteStatus(
      this.gitPullRequest.reviewers
    );
    this.pullRequestProgressStatus = this.getStatusIndicatorData(
      this.gitPullRequest.reviewers,
      this.isAllPoliciesOk
    );
    this.lastShortCommitId = this.gitPullRequest.lastMergeSourceCommit.commitId.substr(
      0,
      8
    );
    this.lastCommitUrl = `${this.baseHostUrl}/_git/${this.gitPullRequest.repository.name}/commit/${this.gitPullRequest.lastMergeSourceCommit.commitId}?refName=GB${this.gitPullRequest.sourceRefName}`;
    this.hasFailures = hasPullRequestFailure(this);
    this.loadLastVisit();
  }

  private getCurrentUserVoteStatus(
    reviewers: IdentityRefWithVote[]
  ): ReviewerVoteOption {
    let voteResult = ReviewerVoteOption.NoVote;
    if (reviewers && reviewers.length > 0) {
      const currentUserReviewer = reviewers.filter(
        (r) => r.id === this.currentUser.id
      );

      if (currentUserReviewer.length > 0) {
        voteResult = currentUserReviewer[0].vote as ReviewerVoteOption;
      }
    }

    return voteResult;
  }

  /**
   * Statuses.Running is deliberately absent here: it renders the same spinner
   * the table shows while a row is still loading, which made a pending policy
   * indistinguishable from an unfinished fetch.
   */
  private static readonly statusPropsByKind: Record<
    PullRequestStatusKind,
    IStatusProps
  > = {
    failed: Statuses.Failed,
    rejected: Statuses.Failed,
    waitingForAuthor: Statuses.Warning,
    draft: Statuses.Queued,
    policiesPending: Statuses.Waiting,
    waitingReview: Statuses.Waiting,
    reviewInProgress: Statuses.Waiting,
    ready: Statuses.Success,
  };

  private getStatusIndicatorData(
    reviewers: IdentityRefWithVote[],
    isAllPoliciesOk: boolean
  ): IStatusIndicatorData {
    const status = evaluatePullRequestStatus({
      isDraft: this.gitPullRequest.isDraft === true,
      hasFailures: this.hasFailures,
      votes: (reviewers || []).map((r) => r.vote),
      requiredVotes: this.requiredReviewers.map((r) => r.vote),
      nonReviewerPoliciesOk: isAllPoliciesOk,
      reviewerPoliciesOk: this.areReviewerPoliciesOk,
    });

    return {
      label: status.label,
      statusProps: {
        ...PullRequestModel.statusPropsByKind[status.kind],
        ariaLabel: status.ariaLabel,
      },
    };
  }

  private async getPullRequestAdditionalDetailsAsync() {
    const gitClient: GitRestClient = getClient(GitRestClient);
    let self = this;

    return gitClient
      .getPullRequest(
        self.gitPullRequest.repository.id,
        self.gitPullRequest.pullRequestId
      )
      .then((value) => {
        self.isAutoCompleteSet = value.autoCompleteSetBy !== undefined;

        if (value.lastMergeCommit === undefined) {
          return;
        }

        self.lastCommitDetails = value.lastMergeCommit;
      })
      .catch((error) => {
        console.log(
          `There was an error calling the Pull Request details (method: getPullRequestAdditionalDetailsAsync).`
        );
        console.log(error);
      });
  }

  private async getPullRequestThreadAsync() {
    const gitClient: GitRestClient = getClient(GitRestClient);
    let self = this;

    await gitClient
      .getThreads(
        self.gitPullRequest.repository.id,
        self.gitPullRequest.pullRequestId
      )
      .then((value) => {
        if (value === undefined) {
          return;
        }

        const threads = value.filter((x) => x.status !== undefined && !x.isDeleted);
        const terminatedThread = threads.filter(
          (x) =>
            x.status === CommentThreadStatus.Closed ||
            x.status === CommentThreadStatus.WontFix ||
            x.status === CommentThreadStatus.Fixed
        );
        const lastUpdatedDate = threads.map(x => x.lastUpdatedDate)
          .reduce((x, y) => compare(x, y) > 0 ? x : y); // Get most recent

        self.comment = new PullRequestComment();
        self.comment.totalcomment = threads.length;
        self.comment.terminatedComment = terminatedThread.length;
        self.comment.lastUpdatedDate = lastUpdatedDate;
      })
      .catch((error) => {
        console.log(
          "There was an error calling the Pull Request threads (method: getPullRequestThreadAsync)."
        );
        console.log(error);
      });
  }

  private async getPullRequestWorkItemAsync() {
    const gitClient: GitRestClient = getClient(GitRestClient);
    let self = this;
    let workItemIds : number[] = [];

    await gitClient
      .getPullRequestWorkItemRefs(
        self.gitPullRequest.repository.id,
        self.gitPullRequest.pullRequestId,
        self.projectName
      )
      .then((value) => {
        self.workItemsCount = value !== undefined ? value.length : 0;
        workItemIds = value.map(v => Number(v.id));
      })
      .catch((error) => {
        console.log("There was an error calling the Pull Request work item (method: getPullRequestWorkItemAsync).");
        console.log(error);
      });

      await this.getWorkItemsAsync(workItemIds);
  }

  private async getWorkItemsAsync(workItemIds : number[]) {
    if (workItemIds.length === 0) {
      return;
    }

    const gitClient: WorkItemTrackingRestClient = getClient(WorkItemTrackingRestClient);
    let self = this;

    await gitClient
      .getWorkItems(workItemIds, self.projectName)
      .then((value) => {
        self.workItems = value.sort(m => m.id);
      })
      .catch((error) => {
        console.log("There was an error calling the Work Item (method: getWorkItemsAsync).");
        console.log(error);
      });
  }

  private async getPullRequestPolicyAsync() {
    let self = this;

    ///** Work in Progress :-) */
    // const details = await getPullRequestOverallStatus(
    //   this.baseHostUrl,
    //   DevOps.getHost().name,
    //   this.gitPullRequest.repository.project,
    //   this.gitPullRequest.repository,
    //   this
    // );

    const policies = await getEvaluationsPerPullRequest(
      this.baseHostUrl,
      this.gitPullRequest.repository.project,
      this.gitPullRequest.pullRequestId
    );

    const blockingPolicies = policies.filter(
      (i) =>
        i.configuration.isEnabled === true && i.configuration.isBlocking === true
    );

    const isReviewerPolicy = (i: AzureGitModels.Value): boolean =>
      i.configuration.type.id === EvaluationPolicyType.MinimumReviewers ||
      i.configuration.type.id === EvaluationPolicyType.RequiredReviewers;

    const reviewerPolicies = blockingPolicies.filter(isReviewerPolicy);

    self.isAllPoliciesOk = blockingPolicies
      .filter((i) => isReviewerPolicy(i) === false)
      .every((i) => i.status === "approved");

    // undefined means "no reviewer policy configured", which is different from
    // "configured and not satisfied" - the status logic treats them apart.
    self.areReviewerPoliciesOk =
      reviewerPolicies.length === 0
        ? undefined
        : reviewerPolicies.every((i) => i.status === "approved");

    policies
      .filter(
        (p) =>
          p.configuration.isEnabled === true &&
          p.configuration.isBlocking === true
      )
      .forEach((p) => {
        const pullRequestPolicy = new PullRequestPolicy();
        pullRequestPolicy.id = p.evaluationId;
        pullRequestPolicy.displayName = `${p.configuration.type.displayName}`;
        pullRequestPolicy.isApproved = p.status === "approved";

        switch (p.configuration.type.id) {
          case EvaluationPolicyType.MinimumReviewers: {
            pullRequestPolicy.displayName = `${p.configuration.settings.minimumApproverCount} ${p.configuration.type.displayName}`;
            break;
          }
          case EvaluationPolicyType.Build: {
            pullRequestPolicy.displayName = `${p.configuration.type.displayName} - ${p.context.buildDefinitionName}`;
            break;
          }
          case EvaluationPolicyType.RequiredReviewers: {
            const requiredReviewerName = this.gitPullRequest.reviewers.filter(
              (r) =>
                p.configuration.settings.requiredReviewerIds.findIndex(
                  (r2) => r2 === r.id
                ) >= 0
            );
            pullRequestPolicy.displayName = `${
              p.configuration.type.displayName
            } - ${
              requiredReviewerName && requiredReviewerName.length > 0
                ? requiredReviewerName[0].displayName
                : "Not found"
            }`;
            break;
          }
        }

        self.policies.push(pullRequestPolicy);
        return p;
      });
  }

  private async getLabels() {
    const gitClient: GitRestClient = getClient(GitRestClient);
    let self = this;

    await gitClient
      .getPullRequestLabels(
        self.gitPullRequest.repository.id,
        this.gitPullRequest.pullRequestId
      )
      .then((data) => {
        self.labels = data;
      })
      .catch((error) => {
        console.log(
          "There was an error calling the builds (method: processPolicyBuildAsync)."
        );
        console.log(error);
      });
  }

  public static getModels(
    pullRequestList: GitPullRequest[] | undefined,
    baseUrl: string,
    callbackState: (pullRequestModel: PullRequestModel) => void
  ): PullRequestModel[] {
    const modelList: PullRequestModel[] = [];

    pullRequestList!.forEach((pr) => {
      modelList.push(
        new PullRequestModel(pr, pr.repository.project.name, baseUrl, callbackState)
      );

      return pr;
    });

    return modelList;
  }
}
