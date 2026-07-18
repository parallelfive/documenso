import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';

export type ApiV1DeleteDocumentErrorResponse =
  | {
      status: 404;
      body: { message: 'Document not found' };
    }
  | {
      status: 409;
      body: { message: 'Document can no longer be cancelled' };
    }
  | {
      status: 500;
      body: { message: 'Error deleting the document. Please try again.' };
    };

/**
 * Exact-team lookup and authorization failures remain non-enumerating 404s.
 * Everything else is an internal/pre-commit failure and must not masquerade as
 * a missing provider document.
 */
export const mapApiV1DeleteDocumentError = (error: unknown): ApiV1DeleteDocumentErrorResponse => {
  if (
    error instanceof AppError &&
    (error.code === AppErrorCode.NOT_FOUND || error.code === AppErrorCode.UNAUTHORIZED)
  ) {
    return {
      status: 404,
      body: {
        message: 'Document not found',
      },
    };
  }

  if (error instanceof AppError && error.code === AppErrorCode.CONFLICT) {
    return {
      status: 409,
      body: {
        message: 'Document can no longer be cancelled',
      },
    };
  }

  return {
    status: 500,
    body: {
      message: 'Error deleting the document. Please try again.',
    },
  };
};
