import { EnvelopeType, Prisma } from '@prisma/client';

import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { prisma } from '@documenso/prisma';

import {
  type ExactTeamApiEnvelope,
  getExactTeamApiDocument as getExactTeamApiDocumentGuard,
} from './exact-team-envelope';

const apiDocumentInclude = Prisma.validator<Prisma.EnvelopeInclude>()({
  documentMeta: {
    select: {
      signingOrder: true,
    },
  },
  recipients: {
    orderBy: {
      id: 'asc',
    },
  },
  fields: {
    include: {
      signature: true,
      recipient: {
        select: {
          name: true,
          email: true,
          signingStatus: true,
        },
      },
    },
    orderBy: {
      id: 'asc',
    },
  },
});

export type ApiDocumentEnvelope = Prisma.EnvelopeGetPayload<{
  include: typeof apiDocumentInclude;
}>;

export interface GetExactTeamDocumentDependencies {
  guardDocument: (
    documentId: number,
    userId: number,
    teamId: number,
  ) => Promise<ExactTeamApiEnvelope | null>;
  findEnvelope: (id: string, teamId: number) => Promise<ApiDocumentEnvelope | null>;
}

const defaultDependencies: GetExactTeamDocumentDependencies = {
  guardDocument: getExactTeamApiDocumentGuard,
  findEnvelope: async (id, teamId) =>
    await prisma.envelope.findFirst({
      where: {
        id,
        teamId,
        type: EnvelopeType.DOCUMENT,
      },
      include: apiDocumentInclude,
    }),
};

/**
 * Fetch the full document representation only after the capability-minimal
 * exact-team API guard succeeds.
 */
export const getExactTeamApiDocument = async (
  {
    documentId,
    userId,
    teamId,
  }: {
    documentId: number;
    userId: number;
    teamId: number;
  },
  dependencies: GetExactTeamDocumentDependencies = defaultDependencies,
) => {
  try {
    const guardedEnvelope = await dependencies.guardDocument(documentId, userId, teamId);
    if (!guardedEnvelope) {
      return {
        status: 404 as const,
        body: { message: 'Document not found' },
      };
    }

    const envelope = await dependencies.findEnvelope(guardedEnvelope.id, teamId);

    if (!envelope || envelope.teamId !== teamId) {
      return {
        status: 404 as const,
        body: { message: 'Document not found' },
      };
    }

    return {
      status: 200 as const,
      envelope,
    };
  } catch (error) {
    if (
      error instanceof AppError &&
      (error.code === AppErrorCode.NOT_FOUND || error.code === AppErrorCode.UNAUTHORIZED)
    ) {
      return {
        status: 404 as const,
        body: { message: 'Document not found' },
      };
    }

    return {
      status: 500 as const,
      body: { message: 'Error retrieving the document. Please try again.' },
    };
  }
};
