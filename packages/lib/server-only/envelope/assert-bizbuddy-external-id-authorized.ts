import { isBizBuddyExternalId, isValidBizBuddyExternalId } from '../../constants/app';
import { AppError, AppErrorCode } from '../../errors/app-error';

/**
 * The `bizbuddy:` namespace is a capability boundary, not general metadata.
 * Only the dedicated API V1 document-creation path may mint it.
 */
export const assertBizBuddyExternalIdAuthorized = ({
  externalId,
  allowReservedNamespace = false,
}: {
  externalId: string | null | undefined;
  allowReservedNamespace?: boolean;
}) => {
  if (!isBizBuddyExternalId(externalId)) {
    return;
  }

  if (!allowReservedNamespace) {
    throw new AppError(AppErrorCode.CONFLICT, {
      message: 'The Biz Buddy correlation namespace is reserved',
    });
  }

  if (!isValidBizBuddyExternalId(externalId)) {
    throw new AppError(AppErrorCode.INVALID_BODY, {
      message: 'Biz Buddy external IDs must use the canonical bizbuddy:<UUID> format',
    });
  }
};
