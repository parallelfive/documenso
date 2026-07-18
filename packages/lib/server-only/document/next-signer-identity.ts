import { isBizBuddyExternalId } from '../../constants/app';

export type NextSignerIdentity = {
  email: string;
  name: string;
};

export const getNextSignerIdentityOverride = ({
  externalId,
  allowDictateNextSigner,
  nextSigner,
}: {
  externalId: string | null | undefined;
  allowDictateNextSigner: boolean | null | undefined;
  nextSigner: NextSignerIdentity | undefined;
}): NextSignerIdentity | null => {
  if (!nextSigner || !allowDictateNextSigner || isBizBuddyExternalId(externalId)) {
    return null;
  }

  return {
    name: nextSigner.name,
    email: nextSigner.email,
  };
};
