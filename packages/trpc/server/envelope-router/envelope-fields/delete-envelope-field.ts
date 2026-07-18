import { ZGenericSuccessResponse } from '../../schema';
import { authenticatedProcedure } from '../../trpc';
import { deleteEnvelopeField } from './delete-envelope-field-handler';
import {
  ZDeleteEnvelopeFieldRequestSchema,
  ZDeleteEnvelopeFieldResponseSchema,
  deleteEnvelopeFieldMeta,
} from './delete-envelope-field.types';

export const deleteEnvelopeFieldRoute = authenticatedProcedure
  .meta(deleteEnvelopeFieldMeta)
  .input(ZDeleteEnvelopeFieldRequestSchema)
  .output(ZDeleteEnvelopeFieldResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { user, teamId, metadata } = ctx;
    const { fieldId } = input;

    ctx.logger.info({
      input: {
        fieldId,
      },
    });

    await deleteEnvelopeField({
      fieldId,
      userId: user.id,
      teamId,
      requestMetadata: metadata,
    });

    return ZGenericSuccessResponse;
  });
