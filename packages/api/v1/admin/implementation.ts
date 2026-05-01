// P5 patch: handlers for /api/v1/admin/* (org + user CRUD).
//
// Spread into ApiContractV1Implementation in ../implementation.ts.
// Wraps existing lib/server-only/* helpers — no new business logic, just
// a REST surface so biz-buddy can talk to Documenso without per-user
// tokens or direct DB writes.
//
// Auth: every handler is wrapped in adminAuthenticatedMiddleware which
// requires Role.ADMIN on the API token's owner.
//
// See parallelfive/documenso P5_PATCHES.md § Patch 1.

import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';

import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { createOrganisation } from '@documenso/lib/server-only/organisation/create-organisation';
import { createUser } from '@documenso/lib/server-only/user/create-user';
import { getUserByEmail } from '@documenso/lib/server-only/user/get-user-by-email';
import { INTERNAL_CLAIM_ID, internalClaims } from '@documenso/lib/types/subscription';
import { generateDatabaseId } from '@documenso/lib/universal/id';
import { prisma } from '@documenso/prisma';

import { adminAuthenticatedMiddleware } from '../middleware/admin-authenticated';

// Map a Prisma Organisation row → AdminOrganisationResponseSchema shape.
const toOrgResponse = (org: {
  id: string;
  name: string;
  url: string;
  type: string;
  ownerUserId: number;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: org.id,
  name: org.name,
  url: org.url,
  // OrganisationType enum is a string at runtime; cast to satisfy zod nativeEnum.
  type: org.type as 'PERSONAL' | 'ORGANISATION',
  ownerUserId: org.ownerUserId,
  createdAt: org.createdAt,
  updatedAt: org.updatedAt,
});

const toUserResponse = (u: {
  id: number;
  email: string;
  name: string | null;
  roles: string[];
  disabled: boolean;
  createdAt: Date;
}) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  roles: u.roles as ('ADMIN' | 'USER')[],
  disabled: u.disabled,
  createdAt: u.createdAt,
});

export const adminImplementation = {
  // ---------- organisations ----------

  adminCreateOrganisation: adminAuthenticatedMiddleware(async (args) => {
    const { name, ownerEmail, url, type } = args.body;

    let owner;
    try {
      owner = await getUserByEmail({ email: ownerEmail });
    } catch {
      return {
        status: 404 as const,
        body: { message: `User with email ${ownerEmail} not found` },
      };
    }

    try {
      await createOrganisation({
        userId: owner.id,
        name,
        url,
        type,
        claim: internalClaims[INTERNAL_CLAIM_ID.FREE],
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return {
          status: 409 as const,
          body: { message: 'Organisation with this URL already exists' },
        };
      }
      throw err;
    }

    // createOrganisation returns void in upstream — re-fetch the just-created
    // org for the response. Sort by createdAt desc + ownerUserId match.
    const created = await prisma.organisation.findFirstOrThrow({
      where: { ownerUserId: owner.id, name },
      orderBy: { createdAt: 'desc' },
    });

    return { status: 200 as const, body: toOrgResponse(created) };
  }),

  adminListOrganisations: adminAuthenticatedMiddleware(async (args) => {
    const { page, perPage, ownerEmail } = args.query;

    const where: Prisma.OrganisationWhereInput = ownerEmail
      ? { owner: { email: ownerEmail.toLowerCase() } }
      : {};

    const [rows, total] = await Promise.all([
      prisma.organisation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      prisma.organisation.count({ where }),
    ]);

    return {
      status: 200 as const,
      body: {
        organisations: rows.map(toOrgResponse),
        totalPages: Math.max(1, Math.ceil(total / perPage)),
      },
    };
  }),

  adminGetOrganisation: adminAuthenticatedMiddleware(async (args) => {
    const { organisationId } = args.params;

    const org = await prisma.organisation.findUnique({ where: { id: organisationId } });
    if (!org) {
      return { status: 404 as const, body: { message: 'Organisation not found' } };
    }

    return { status: 200 as const, body: toOrgResponse(org) };
  }),

  adminUpdateOrganisation: adminAuthenticatedMiddleware(async (args) => {
    const { organisationId } = args.params;
    const { name, url } = args.body;

    const existing = await prisma.organisation.findUnique({ where: { id: organisationId } });
    if (!existing) {
      return { status: 404 as const, body: { message: 'Organisation not found' } };
    }

    const updated = await prisma.organisation.update({
      where: { id: organisationId },
      data: { ...(name !== undefined && { name }), ...(url !== undefined && { url }) },
    });

    return { status: 200 as const, body: toOrgResponse(updated) };
  }),

  adminDeleteOrganisation: adminAuthenticatedMiddleware(async (args) => {
    const { organisationId } = args.params;

    const existing = await prisma.organisation.findUnique({ where: { id: organisationId } });
    if (!existing) {
      return { status: 404 as const, body: { message: 'Organisation not found' } };
    }

    await prisma.organisation.delete({ where: { id: organisationId } });

    return { status: 200 as const, body: { success: true as const } };
  }),

  // ---------- organisation members ----------

  adminAddOrganisationMember: adminAuthenticatedMiddleware(async (args) => {
    const { organisationId } = args.params;
    const { email, role } = args.body;

    const org = await prisma.organisation.findUnique({
      where: { id: organisationId },
      include: { groups: true },
    });
    if (!org) {
      return { status: 404 as const, body: { message: 'Organisation not found' } };
    }

    let user;
    try {
      user = await getUserByEmail({ email });
    } catch {
      return {
        status: 404 as const,
        body: { message: `User with email ${email} not found` },
      };
    }

    // OrganisationMember rows are indirected through OrganisationGroupMember →
    // OrganisationGroup. Each org has 3 internal groups (ADMIN/MANAGER/MEMBER)
    // populated by createOrganisation. Pick the group matching the requested role.
    const targetGroup = org.groups.find((g) => g.organisationRole === role);
    if (!targetGroup) {
      throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
        message: `Internal group for role ${role} not found on organisation`,
      });
    }

    let member;
    try {
      member = await prisma.organisationMember.create({
        data: {
          id: generateDatabaseId('member'),
          userId: user.id,
          organisationId: org.id,
          organisationGroupMembers: {
            create: { id: generateDatabaseId('group_member'), groupId: targetGroup.id },
          },
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return {
          status: 409 as const,
          body: { message: 'User is already a member of this organisation' },
        };
      }
      throw err;
    }

    return {
      status: 200 as const,
      body: {
        id: member.id,
        userId: user.id,
        email: user.email,
        name: user.name,
        organisationId: org.id,
        createdAt: member.createdAt,
      },
    };
  }),

  adminRemoveOrganisationMember: adminAuthenticatedMiddleware(async (args) => {
    const { organisationId, userId } = args.params;

    const member = await prisma.organisationMember.findFirst({
      where: { organisationId, userId: Number(userId) },
    });
    if (!member) {
      return { status: 404 as const, body: { message: 'Member not found' } };
    }

    await prisma.organisationMember.delete({ where: { id: member.id } });

    return { status: 200 as const, body: { success: true as const } };
  }),

  // ---------- users ----------

  adminCreateUser: adminAuthenticatedMiddleware(async (args) => {
    const { email, name, password } = args.body;

    // If no password provided, generate a random one. The user will need
    // to use the forgot-password flow to set their own before signing in.
    const finalPassword = password ?? randomBytes(24).toString('hex');

    let user;
    try {
      user = await createUser({ email, name, password: finalPassword });
    } catch (err) {
      if (err instanceof AppError && err.code === AppErrorCode.ALREADY_EXISTS) {
        return {
          status: 409 as const,
          body: { message: 'User with this email already exists' },
        };
      }
      throw err;
    }

    return { status: 200 as const, body: toUserResponse(user) };
  }),

  adminListUsers: adminAuthenticatedMiddleware(async (args) => {
    const { page, perPage, email } = args.query;

    const where: Prisma.UserWhereInput = email ? { email: email.toLowerCase() } : {};

    const [rows, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      prisma.user.count({ where }),
    ]);

    return {
      status: 200 as const,
      body: {
        users: rows.map(toUserResponse),
        totalPages: Math.max(1, Math.ceil(total / perPage)),
      },
    };
  }),

  adminGetUser: adminAuthenticatedMiddleware(async (args) => {
    const { userId } = args.params;

    const user = await prisma.user.findUnique({ where: { id: Number(userId) } });
    if (!user) {
      return { status: 404 as const, body: { message: 'User not found' } };
    }

    return { status: 200 as const, body: toUserResponse(user) };
  }),

  adminUpdateUser: adminAuthenticatedMiddleware(async (args) => {
    const { userId } = args.params;
    const { name, email, disabled } = args.body;

    const existing = await prisma.user.findUnique({ where: { id: Number(userId) } });
    if (!existing) {
      return { status: 404 as const, body: { message: 'User not found' } };
    }

    const updated = await prisma.user.update({
      where: { id: Number(userId) },
      data: {
        ...(name !== undefined && { name }),
        ...(email !== undefined && { email: email.toLowerCase() }),
        ...(disabled !== undefined && { disabled }),
      },
    });

    return { status: 200 as const, body: toUserResponse(updated) };
  }),
};
