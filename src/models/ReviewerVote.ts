/**
 * Reviewer vote values as Azure DevOps reports them.
 *
 * Deliberately in a module of its own, free of UI and SDK imports, so logic
 * that only needs the vote values can be reasoned about - and tested - without
 * pulling in azure-devops-ui or the extension host.
 */
export enum ReviewerVoteOption {
  Approved = 10,
  ApprovedWithSuggestions = 5,
  Rejected = -10,
  WaitingForAuthor = -5,
  NoVote = 0,
}
