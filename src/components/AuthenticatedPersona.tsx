import * as React from "react";
import { VssPersona } from "azure-devops-ui/VssPersona";
import { getAvatarImageUrl } from "../services/AvatarService";

type VssPersonaProps = React.ComponentProps<typeof VssPersona>;

interface IAuthenticatedPersonaProps
  extends Omit<VssPersonaProps, "imageUrl"> {
  /** Avatar href from the Git API, e.g. identity._links.avatar.href. */
  avatarHref?: string;
}

/**
 * VssPersona that fetches the avatar through the authenticated Azure DevOps
 * API rather than letting the browser load it as a cross-site <img>.
 *
 * Until the avatar resolves - and permanently if it cannot be retrieved -
 * imageUrl stays undefined and VssPersona falls back to the identity initials,
 * which is why callers should always pass displayName.
 */
export const AuthenticatedPersona: React.FunctionComponent<IAuthenticatedPersonaProps> =
  ({ avatarHref, ...personaProps }) => {
    const [imageUrl, setImageUrl] = React.useState<string | undefined>(
      undefined
    );

    React.useEffect(() => {
      if (avatarHref === undefined) {
        setImageUrl(undefined);
        return;
      }

      let active = true;

      getAvatarImageUrl(avatarHref).then((url) => {
        if (active) {
          setImageUrl(url);
        }
      });

      return () => {
        active = false;
      };
    }, [avatarHref]);

    return <VssPersona {...personaProps} imageUrl={imageUrl} />;
  };
