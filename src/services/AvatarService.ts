import { getClient } from "azure-devops-extension-api";
import { GraphRestClient } from "azure-devops-extension-api/Graph";
import { AvatarSize } from "azure-devops-extension-api/Profile";

/**
 * Avatar hrefs on identities point at /_apis/GraphProfile/MemberAvatars/...,
 * a legacy UI endpoint that only accepts session cookies. An extension runs in
 * an iframe on a different origin (<publisher>.gallerycdn.vsassets.io), so
 * those cookies are never sent: Azure DevOps answers 302 to _signin, and the
 * browser reports the missing CORS header on that redirect target.
 *
 * The Graph REST API is the supported alternative. It accepts the OAuth token
 * the SDK hands out (covered by the vso.graph scope declared in
 * vss-extension.json) and returns the image as base64 inside JSON, so there is
 * no binary response and no redirect to trip over.
 */
const avatarCache = new Map<string, Promise<string | undefined>>();

/**
 * Resolves an identity's avatar href to a data URL usable as an <img src>, or
 * undefined when the avatar cannot be retrieved so callers fall back to
 * initials.
 *
 * Results are cached per descriptor for the lifetime of the page; the same
 * identity appears on many rows and would otherwise be fetched repeatedly.
 */
export function getAvatarImageUrl(
  avatarHref: string
): Promise<string | undefined> {
  const descriptor = descriptorFromHref(avatarHref);

  if (descriptor === undefined) {
    console.warn(`[avatar] no descriptor in ${avatarHref}`);
    return Promise.resolve(undefined);
  }

  let cached = avatarCache.get(descriptor);

  if (cached === undefined) {
    cached = fetchAvatar(descriptor);
    avatarCache.set(descriptor, cached);
  }

  return cached;
}

/** Drops every cached avatar. Intended for tests. */
export function resetAvatarCache(): void {
  avatarCache.clear();
}

/**
 * The last path segment of an avatar href is the subject descriptor, e.g.
 * .../MemberAvatars/aad.YTQ0YzQ2YmQ...  Deriving it here keeps callers free of
 * the detail and works whether or not the identity carries a descriptor field.
 */
function descriptorFromHref(avatarHref: string): string | undefined {
  const path = avatarHref.split("?")[0];
  const segment = path.substring(path.lastIndexOf("/") + 1);

  return segment.length > 0 ? decodeURIComponent(segment) : undefined;
}

async function fetchAvatar(descriptor: string): Promise<string | undefined> {
  try {
    const avatar = await getClient(GraphRestClient).getAvatar(
      descriptor,
      AvatarSize.Medium
    );

    const base64 = toBase64(avatar.value);

    if (base64 === undefined || base64.length === 0) {
      console.warn(`[avatar] empty avatar for ${descriptor}`);
      return undefined;
    }

    console.info(`[avatar] loaded ${base64.length}b base64 for ${descriptor}`);

    return `data:image/png;base64,${base64}`;
  } catch (error) {
    console.warn(`[avatar] failed for ${descriptor}`, error);
    return undefined;
  }
}

/**
 * Graph types the avatar payload as a byte array, but the REST response
 * carries it as a base64 string. Handle both so a change on either side does
 * not blank out every avatar.
 */
function toBase64(value: number[] | string): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    // Built one byte at a time on purpose: spreading a large array into
    // String.fromCharCode overflows the call stack.
    let binary = "";

    for (const byte of value) {
      binary += String.fromCharCode(byte);
    }

    return window.btoa(binary);
  }

  return undefined;
}
