import { describe, expect, it } from 'vitest';

import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';

import { mapApiV1DeleteDocumentError } from './delete-document-error';

describe('mapApiV1DeleteDocumentError', () => {
  it.each([AppErrorCode.NOT_FOUND, AppErrorCode.UNAUTHORIZED])(
    'keeps expected capability denial %s non-enumerating',
    (code) => {
      expect(mapApiV1DeleteDocumentError(new AppError(code))).toEqual({
        status: 404,
        body: { message: 'Document not found' },
      });
    },
  );

  it.each([
    new Error('database unavailable'),
    new AppError(AppErrorCode.UNKNOWN_ERROR),
    { code: 'P2002' },
  ])('maps genuine internal/pre-commit failure to 500', (error) => {
    expect(mapApiV1DeleteDocumentError(error)).toEqual({
      status: 500,
      body: {
        message: 'Error deleting the document. Please try again.',
      },
    });
  });

  it('maps a legal-state cancellation conflict to 409', () => {
    expect(mapApiV1DeleteDocumentError(new AppError(AppErrorCode.CONFLICT))).toEqual({
      status: 409,
      body: {
        message: 'Document can no longer be cancelled',
      },
    });
  });
});
