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
import { EvaluationPolicyType } from "./GitModels";
import { isCountedPolicy, summarisePolicies } from "./PolicyEvaluation";
import {
  evaluatePullRequestStatus,
  PullRequestStatusKind,
} from "./PullRequestStatus";
import { GitRepository } from 'azure-devops-extension-api/Git';
import { mostRecent } from "../lib/date";
import { createLimiter } from "../lib/limitConcurrency";
import { CacheBucket, readCache, writeCache } from "../services/PullRequestCache";
import { WorkItem } from "azure-devops-extension-api/WorkItemTracking";

/**
 * Kept as an alias so call sites keep their intent. The interface used to
 * widen isDisabled to boolean | undefined, which azure-devops-extension-api 5
 * now declares as a required boolean - so the override no longer compiles and
 * no longer adds anything.
 */
export type GitRepositoryModel = GitRepository;

/**
 * Shared by every model on purpose: the tab builds one model per pull request in
 * a single loop, and each fires five requests, so without a shared ceiling a few
 * hundred pull requests put over a thousand fetches in flight at once. Azure
 * DevOps then answers ERR_FAILED and the catches swallow it, leaving rows
 * without labels or work items.
 *
 * 16 is a compromise: low enough that the requests actually complete, high
 * enough that loading does not crawl. Raise it if loading feels slow and the
 * console stays clean; lower it if ERR_FAILED comes back.
 */
const requestLimiter = createLimiter(16);

/**
 * Cached shapes hold only what the UI reads, and dates as milliseconds.
 * JSON turns a Date into a string, and a revived string compared against a Date
 * does not throw - it quietly gives the wrong answer, which is how
 * hasCommentChanges would start lying.
 */
interface DetailsCache {
  isAutoCompleteSet: boolean;
  committerDateMs?: number;
}

interface ThreadsCache {
  totalcomment: number;
  terminatedComment: number;
  lastUpdatedDateMs?: number;
}

interface WorkItemsCache {
  workItemsCount: number;
  /** Only id, type and title are rendered, so a full WorkItem is not stored. */
  workItems: Array<{ id: number; fields: { [field: string]: any } }>;
}

interface LabelsCache {
  labels: WebApiTagDefinition[];
}

interface PoliciesCache {
  policies: PullRequestPolicy[];
  isAllPoliciesOk: boolean;
  areReviewerPoliciesOk: boolean | undefined;
  arePoliciesRejected: boolean;
}

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
  /** Whether a blocking, non-reviewer policy was rejected or is broken. */
  public arePoliciesRejected: boolean = false;
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

  /**
   * What the cache is keyed against besides the pull request id. A push changes
   * this and invalidates every bucket at once, which is the only change signal
   * Azure DevOps gives us for free.
   */
  private get cacheToken(): string {
    return this.gitPullRequest.lastMergeSourceCommit.commitId;
  }

  private cacheRead<T>(bucket: CacheBucket): T | undefined {
    return readCache<T>(
      bucket,
      this.gitPullRequest.pullRequestId,
      this.cacheToken
    );
  }

  private cacheWrite<T>(bucket: CacheBucket, payload: T): void {
    writeCache<T>(
      bucket,
      this.gitPullRequest.pullRequestId,
      this.cacheToken,
      payload
    );
  }

  private callTriggerState() {
    this.loadingData = false;
    this.triggerState();
  }

  public async setupPullRequest() {
    this.initializeData();
    this.loadingData = true;

    Promise.all(
      this.getAsyncCallList().map((call) => requestLimiter(call))
    ).finally(() => {
      this.callTriggerState();
    });
  }

  /**
   * Returns functions rather than promises: calling the methods here would fire
   * every request the moment a model is constructed, which is exactly what the
   * limiter exists to prevent.
   */
  private getAsyncCallList(): Array<() => Promise<any>> {
    const abandoned =
      this.gitPullRequest.status === PullRequestStatus.Abandoned;
    let callList: Array<() => Promise<any>> = [];

    if (abandoned === false) {
      callList.push(
        ...[
          () => this.getPullRequestAdditionalDetailsAsync(),
          () => this.getPullRequestThreadAsync(),
          () => this.getPullRequestWorkItemAsync(),
          () => this.getPullRequestPolicyAsync(),
        ]
      );
    }

    callList.push(() => this.getLabels());

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
    policiesFailed: Statuses.Failed,
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
      nonReviewerPoliciesFailed: this.arePoliciesRejected,
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
    const cached = this.cacheRead<DetailsCache>("details");

    if (cached !== undefined) {
      this.isAutoCompleteSet = cached.isAutoCompleteSet;
      // Only committer.date is ever read off this, so a minimal stand-in is
      // enough - see getLastCommitDate.
      this.lastCommitDetails =
        cached.committerDateMs === undefined
          ? undefined
          : ({
              committer: { date: new Date(cached.committerDateMs) },
            } as GitCommitRef);

      return;
    }

    const gitClient: GitRestClient = getClient(GitRestClient);
    let self = this;

    return gitClient
      .getPullRequest(
        self.gitPullRequest.repository.id,
        self.gitPullRequest.pullRequestId
      )
      .then((value) => {
        self.isAutoCompleteSet = value.autoCompleteSetBy !== undefined;
        self.lastCommitDetails = value.lastMergeCommit;

        const committerDate = self.lastCommitDetails?.committer?.date;

        self.cacheWrite<DetailsCache>("details", {
          isAutoCompleteSet: self.isAutoCompleteSet,
          committerDateMs:
            committerDate === undefined
              ? undefined
              : new Date(committerDate).getTime(),
        });
      })
      .catch((error) => {
        console.log(
          `There was an error calling the Pull Request details (method: getPullRequestAdditionalDetailsAsync).`
        );
        console.log(error);
      });
  }

  private async getPullRequestThreadAsync() {
    const cached = this.cacheRead<ThreadsCache>("threads");

    if (cached !== undefined) {
      this.comment = new PullRequestComment();
      this.comment.totalcomment = cached.totalcomment;
      this.comment.terminatedComment = cached.terminatedComment;
      this.comment.lastUpdatedDate =
        cached.lastUpdatedDateMs === undefined
          ? undefined
          : new Date(cached.lastUpdatedDateMs);

      return;
    }

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
        const lastUpdatedDate = mostRecent(
          threads.map((x) => x.lastUpdatedDate)
        );

        self.comment = new PullRequestComment();
        self.comment.totalcomment = threads.length;
        self.comment.terminatedComment = terminatedThread.length;
        self.comment.lastUpdatedDate = lastUpdatedDate;

        self.cacheWrite<ThreadsCache>("threads", {
          totalcomment: self.comment.totalcomment,
          terminatedComment: self.comment.terminatedComment,
          lastUpdatedDateMs:
            lastUpdatedDate === undefined
              ? undefined
              : new Date(lastUpdatedDate).getTime(),
        });
      })
      .catch((error) => {
        console.log(
          "There was an error handling the Pull Request threads (method: getPullRequestThreadAsync). Note this covers processing the response as well as the call itself."
        );
        console.log(error);
      });
  }

  private async getPullRequestWorkItemAsync() {
    const cached = this.cacheRead<WorkItemsCache>("workItems");

    if (cached !== undefined) {
      this.workItemsCount = cached.workItemsCount;
      this.workItems = cached.workItems as WorkItem[];

      return;
    }

    const gitClient: GitRestClient = getClient(GitRestClient);
    let self = this;
    let workItemIds : number[] = [];
    let refsLoaded = false;

    await gitClient
      .getPullRequestWorkItemRefs(
        self.gitPullRequest.repository.id,
        self.gitPullRequest.pullRequestId,
        self.projectName
      )
      .then((value) => {
        self.workItemsCount = value !== undefined ? value.length : 0;
        workItemIds = value.map(v => Number(v.id));
        refsLoaded = true;
      })
      .catch((error) => {
        console.log("There was an error calling the Pull Request work item (method: getPullRequestWorkItemAsync).");
        console.log(error);
      });

    const itemsLoaded = await this.getWorkItemsAsync(workItemIds);

    // Only cache when both calls came back. Storing a count of zero from a
    // failed request would read as "no work items" for the next quarter hour.
    if (refsLoaded && itemsLoaded) {
      self.cacheWrite<WorkItemsCache>("workItems", {
        workItemsCount: self.workItemsCount,
        workItems: self.workItems.map((workItem) => ({
          id: workItem.id,
          fields: {
            "System.WorkItemType": workItem.fields["System.WorkItemType"],
            "System.Title": workItem.fields["System.Title"],
          },
        })),
      });
    }
  }

  /** Returns whether the work items were retrieved, so the caller knows if the result is cacheable. */
  private async getWorkItemsAsync(workItemIds : number[]): Promise<boolean> {
    if (workItemIds.length === 0) {
      return true;
    }

    const gitClient: WorkItemTrackingRestClient = getClient(WorkItemTrackingRestClient);
    let self = this;
    let loaded = false;

    await gitClient
      .getWorkItems(workItemIds, self.projectName)
      .then((value) => {
        self.workItems = value.sort(m => m.id);
        loaded = true;
      })
      .catch((error) => {
        console.log("There was an error calling the Work Item (method: getWorkItemsAsync).");
        console.log(error);
      });

    return loaded;
  }

  private async getPullRequestPolicyAsync() {
    const cached = this.cacheRead<PoliciesCache>("policies");

    if (cached !== undefined) {
      this.policies = cached.policies;
      this.isAllPoliciesOk = cached.isAllPoliciesOk;
      this.areReviewerPoliciesOk = cached.areReviewerPoliciesOk;
      this.arePoliciesRejected = cached.arePoliciesRejected;

      return;
    }

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

    const summary = summarisePolicies(policies);

    self.isAllPoliciesOk = summary.isAllPoliciesOk;
    self.arePoliciesRejected = summary.arePoliciesRejected;
    self.areReviewerPoliciesOk = summary.areReviewerPoliciesOk;

    // The same set the summary counts, so the tooltip does not list a policy
    // that can only ever read as unapproved.
    policies
      .filter(isCountedPolicy)
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
            // No context means the build has not run yet, so there is no
            // definition name to show.
            pullRequestPolicy.displayName =
              p.context === undefined
                ? p.configuration.type.displayName
                : `${p.configuration.type.displayName} - ${p.context.buildDefinitionName}`;
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

    // This method has no catch, so reaching here means every step succeeded.
    self.cacheWrite<PoliciesCache>("policies", {
      policies: self.policies,
      isAllPoliciesOk: self.isAllPoliciesOk,
      areReviewerPoliciesOk: self.areReviewerPoliciesOk,
      arePoliciesRejected: self.arePoliciesRejected,
    });
  }

  private async getLabels() {
    const cached = this.cacheRead<LabelsCache>("labels");

    if (cached !== undefined) {
      this.labels = cached.labels;

      return;
    }

    const gitClient: GitRestClient = getClient(GitRestClient);
    let self = this;

    await gitClient
      .getPullRequestLabels(
        self.gitPullRequest.repository.id,
        this.gitPullRequest.pullRequestId
      )
      .then((data) => {
        self.labels = data;
        self.cacheWrite<LabelsCache>("labels", { labels: data });
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
