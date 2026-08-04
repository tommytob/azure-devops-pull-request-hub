import { getClient } from "azure-devops-extension-api";
import { getAvatarImageUrl, resetAvatarCache } from "./AvatarService";

// The real modules pull in azure-devops-extension-sdk, which cannot initialise
// outside an extension host.
jest.mock("azure-devops-extension-api", () => ({ getClient: jest.fn() }));
jest.mock("azure-devops-extension-api/Graph", () => ({
  GraphRestClient: class {},
}));
jest.mock("azure-devops-extension-api/Profile", () => ({
  AvatarSize: { Small: 0, Medium: 1, Large: 2 },
}));

const descriptor = "aad.YTQ0YzQ2YmQtM2U1OC03ZDY5LThiMjItMTlkMDU4OTkyODgy";
const avatarHref = `https://dev.azure.com/Transheroes/_apis/GraphProfile/MemberAvatars/${descriptor}`;

let getAvatar: jest.Mock;

beforeEach(() => {
  resetAvatarCache();
  getAvatar = jest.fn();
  (getClient as jest.Mock).mockReset();
  (getClient as jest.Mock).mockReturnValue({ getAvatar });
});

it("asks Graph for the descriptor taken from the avatar href", async () => {
  getAvatar.mockResolvedValue({ value: "aGVsbG8=" });

  const url = await getAvatarImageUrl(avatarHref);

  expect(getAvatar).toHaveBeenCalledWith(descriptor, 1);
  expect(url).toBe("data:image/png;base64,aGVsbG8=");
});

it("ignores a size query string when deriving the descriptor", async () => {
  getAvatar.mockResolvedValue({ value: "aGVsbG8=" });

  await getAvatarImageUrl(`${avatarHref}?size=0`);

  expect(getAvatar).toHaveBeenCalledWith(descriptor, 1);
});

it("encodes a byte array payload, since Graph types the value as byte[]", async () => {
  getAvatar.mockResolvedValue({ value: [104, 105] });

  await expect(getAvatarImageUrl(avatarHref)).resolves.toBe(
    `data:image/png;base64,${btoa("hi")}`
  );
});

it("returns undefined when Graph fails so callers fall back to initials", async () => {
  getAvatar.mockRejectedValue(new Error("VS403463: no access"));

  await expect(getAvatarImageUrl(avatarHref)).resolves.toBeUndefined();
});

it("returns undefined for an empty avatar rather than a broken data url", async () => {
  getAvatar.mockResolvedValue({ value: "" });

  await expect(getAvatarImageUrl(avatarHref)).resolves.toBeUndefined();
});

it("fetches each identity once even when many rows render it", async () => {
  getAvatar.mockResolvedValue({ value: "aGVsbG8=" });

  await Promise.all([
    getAvatarImageUrl(avatarHref),
    getAvatarImageUrl(`${avatarHref}?size=0`),
    getAvatarImageUrl(avatarHref),
  ]);

  expect(getAvatar).toHaveBeenCalledTimes(1);
});
