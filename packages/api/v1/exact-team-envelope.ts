import { EnvelopeType, Prisma } from '@prisma/client';

import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { getEnvelopeWhereInput } from '@documenso/lib/server-only/envelope/get-envelope-by-id';
import type { EnvelopeIdOptions } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';

export const exactTeamApiEnvelopeSelect = Prisma.validator<Prisma.EnvelopeSelect>()({
  id: true,
  teamId: true,
  secondaryId: true,
});

export type ExactTeamApiEnvelope = Prisma.EnvelopeGetPayload<{
  select: typeof exactTeamApiEnvelopeSelect;
}>;

export interface GetExactTeamApiEnvelopeDependencies {
  getWhere: typeof getEnvelopeWhereInput;
  findEnvelope: (
    where: Prisma.EnvelopeWhereInput,
    select: typeof exactTeamApiEnvelopeSelect,
  ) => Promise<ExactTeamApiEnvelope | null>;
}

const defaultDependencies: GetExactTeamApiEnvelopeDependencies = {
  getWhere: getEnvelopeWhereInput,
  findEnvelope: async (where, select) =>
    await prisma.envelope.findFirst({
      where,
      select,
    }),
};

const isValidApiEnvelopeId = (id: EnvelopeIdOptions) => {
  if (id.type === 'envelopeId') {
    return id.id.length > 0;
  }

  return Number.isSafeInteger(id.id) && id.id > 0;
};

/**
 * API v1 tokens are bound to one team. The shared envelope authorization
 * intentionally supports broader product access (owner, selected team, and
 * team-email access), so API v1 must add the token's exact team to the database
 * predicate before any endpoint-specific data or capability is materialized.
 */
export const getExactTeamApiEnvelope = async (
  {
    id,
    type,
    userId,
    teamId,
  }: {
    id: EnvelopeIdOptions;
    type: EnvelopeType;
    userId: number;
    teamId: number;
  },
  dependencies: GetExactTeamApiEnvelopeDependencies = defaultDependencies,
): Promise<ExactTeamApiEnvelope | null> => {
  if (!isValidApiEnvelopeId(id)) {
    return null;
  }

  const { envelopeWhereInput } = await dependencies.getWhere({
    id,
    type,
    userId,
    teamId,
  });

  const envelope = await dependencies.findEnvelope(
    {
      AND: [envelopeWhereInput, { teamId, type }],
    },
    exactTeamApiEnvelopeSelect,
  );

  if (!envelope || envelope.teamId !== teamId) {
    return null;
  }

  return envelope;
};

export const getExactTeamApiDocument = async (
  documentId: number,
  userId: number,
  teamId: number,
  dependencies?: GetExactTeamApiEnvelopeDependencies,
) =>
  await getExactTeamApiEnvelope(
    {
      id: {
        type: 'documentId',
        id: documentId,
      },
      type: EnvelopeType.DOCUMENT,
      userId,
      teamId,
    },
    dependencies,
  );

export const getExactTeamApiTemplate = async (
  templateId: number,
  userId: number,
  teamId: number,
  dependencies?: GetExactTeamApiEnvelopeDependencies,
) =>
  await getExactTeamApiEnvelope(
    {
      id: {
        type: 'templateId',
        id: templateId,
      },
      type: EnvelopeType.TEMPLATE,
      userId,
      teamId,
    },
    dependencies,
  );

type ExactTeamApiEnvelopeLookup =
  | {
      status: 200;
      envelope: ExactTeamApiEnvelope;
    }
  | {
      status: 404 | 500;
      body: {
        message: string;
      };
    };

const lookupExactTeamApiEnvelope = async (
  lookup: () => Promise<ExactTeamApiEnvelope | null>,
  resource: 'Document' | 'Template',
): Promise<ExactTeamApiEnvelopeLookup> => {
  try {
    const envelope = await lookup();

    return envelope
      ? { status: 200, envelope }
      : { status: 404, body: { message: `${resource} not found` } };
  } catch (error) {
    if (
      error instanceof AppError &&
      (error.code === AppErrorCode.NOT_FOUND || error.code === AppErrorCode.UNAUTHORIZED)
    ) {
      return { status: 404, body: { message: `${resource} not found` } };
    }

    return {
      status: 500,
      body: {
        message: `Error authorizing the ${resource.toLowerCase()}. Please try again.`,
      },
    };
  }
};

export const lookupExactTeamApiDocument = async (
  documentId: number,
  userId: number,
  teamId: number,
  dependencies?: GetExactTeamApiEnvelopeDependencies,
) =>
  await lookupExactTeamApiEnvelope(
    async () => await getExactTeamApiDocument(documentId, userId, teamId, dependencies),
    'Document',
  );

export const lookupExactTeamApiTemplate = async (
  templateId: number,
  userId: number,
  teamId: number,
  dependencies?: GetExactTeamApiEnvelopeDependencies,
) =>
  await lookupExactTeamApiEnvelope(
    async () => await getExactTeamApiTemplate(templateId, userId, teamId, dependencies),
    'Template',
  );
