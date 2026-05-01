// P5 patch: handler bodies for /api/v1/admin/* (org + user CRUD).
//
// These are pure async helpers — no middleware wrapping. The wrapping
// happens inline in ../implementation.ts so ts-rest's contract-driven
// type inference flows through (otherwise the wrapper's generic T solves
// to the bare middleware constraint and args.body/query/params type-error).
//
// Auth: every helper is invoked from inside adminAuthenticatedMiddleware
// so by the time control reaches a helper the caller is already verified
// as Role.ADMIN. Helpers do not re-check.
//
// See parallelfive/documenso P5_PATCHES.md § Patch 1.

import {
  OrganisationMemberRole,
  OrganisationType,
  Prisma,
  Role,
} from '@prisma/client';
import { randomBytes } from 'crypto';
import type { z } from 'zod';

import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { createOrganisation } from '@documenso/lib/server-only/organisation/create-organisation';
import { createUser } from '@documenso/lib/server-only/user/create-user';
import { getUserByEmail } from '@documenso/lib/server-only/user/get-user-by-email';
import { INTERNAL_CLAIM_ID, internalClaims } from '@documenso/lib/types/subscription';
import { generateDatabaseId } from '@documenso/lib/universal/id';
import { prisma } from '@documenso/prisma';

import type {
  ZAdminAddOrganisationMemberRequestSchema,
  ZAdminCreateOrganisationRequestSchema,
  ZAdminCreateUserRequestSchema,
  ZAdminListOrganisationsQuerySchema,
  ZAdminListUsersQuerySchema,
  ZAdminUpdateOrganisationRequestSchema,
  ZAdminUpdateUserRequestSchema,
} from './schema';

// Map a Prisma Organisation row → AdminOrganisationResponseSchema shape.
const toOrgResponse = (org: {
  id: string;
  name: string;
  url: string;
  type: OrganisationType;
  ownerUserId: number;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: org.id,
  name: org.name,
  url: org.url,
  type: org.type,
  ownerUserId: org.ownerUserId,
  createdAt: org.createdAt,
  updatedAt: org.updatedAt,
});

const toUserResponse = (u: {
  id: number;
  email: string;
  name: string | null;
  roles: Role[];
  disabled: boolean;
  createdAt: Date;
}) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  roles: u.roles,
  disabled: u.disabled,
  createdAt: u.createdAt,
});

type CreateOrgInput = z.infer<typeof ZAdminCreateOrganisationRequestSchema>;
type ListOrgsInput = z.infer<typeof ZAdminListOrganisationsQuerySchema>;
type UpdateOrgInput = z.infer<typeof ZAdminUpdateOrganisationRequestSchema>;
type AddMemberInput = z.infer<typeof ZAdminAddOrganisationMemberRequestSchema>;
type CreateUserInput = z.infer<typeof ZAdminCreateUserRequestSchema>;
type ListUsersInput = z.infer<typeof ZAdminListUsersQuerySchema>;
type UpdateUserInput = z.infer<typeof ZAdminUpdateUserRequestSchema>;

// ---------- organisations ----------

export const handleAdminCreateOrganisation = async (input: CreateOrgInput) => {
  const { name, ownerEmail, url, type } = input;

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
  // org for the response payload.
  const created = await prisma.organisation.findFirstOrThrow({
    where: { ownerUserId: owner.id, name },
    orderBy: { createdAt: 'desc' },
  });

  return { status: 200 as const, body: toOrgResponse(created) };
};

export const handleAdminListOrganisations = async (input: ListOrgsInput) => {
  const { page, perPage, ownerEmail } = input;

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
};

export const handleAdminGetOrganisation = async (organisationId: string) => {
  const org = await prisma.organisation.findUnique({ where: { id: organisationId } });
  if (!org) {
    return { status: 404 as const, body: { message: 'Organisation not found' } };
  }
  return { status: 200 as const, body: toOrgResponse(org) };
};

export const handleAdminUpdateOrganisation = async (
  organisationId: string,
  input: UpdateOrgInput,
) => {
  const { name, url } = input;

  const existing = await prisma.organisation.findUnique({ where: { id: organisationId } });
  if (!existing) {
    return { status: 404 as const, body: { message: 'Organisation not found' } };
  }

  const updated = await prisma.organisation.update({
    where: { id: organisationId },
    data: { ...(name !== undefined && { name }), ...(url !== undefined && { url }) },
  });

  return { status: 200 as const, body: toOrgResponse(updated) };
};

export const handleAdminDeleteOrganisation = async (organisationId: string) => {
  const existing = await prisma.organisation.findUnique({ where: { id: organisationId } });
  if (!existing) {
    return { status: 404 as const, body: { message: 'Organisation not found' } };
  }

  await prisma.organisation.delete({ where: { id: organisationId } });

  return { status: 200 as const, body: { success: true as const } };
};

// ---------- organisation members ----------

export const handleAdminAddOrganisationMember = async (
  organisationId: string,
  input: AddMemberInput,
) => {
  const { email, role } = input;

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
};

export const handleAdminRemoveOrganisationMember = async (
  organisationId: string,
  userIdRaw: string,
) => {
  const member = await prisma.organisationMember.findFirst({
    where: { organisationId, userId: Number(userIdRaw) },
  });
  if (!member) {
    return { status: 404 as const, body: { message: 'Member not found' } };
  }

  await prisma.organisationMember.delete({ where: { id: member.id } });

  return { status: 200 as const, body: { success: true as const } };
};

// ---------- users ----------

export const handleAdminCreateUser = async (input: CreateUserInput) => {
  const { email, name, password } = input;

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
};

export const handleAdminListUsers = async (input: ListUsersInput) => {
  const { page, perPage, email } = input;

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
};

export const handleAdminGetUser = async (userIdRaw: string) => {
  const user = await prisma.user.findUnique({ where: { id: Number(userIdRaw) } });
  if (!user) {
    return { status: 404 as const, body: { message: 'User not found' } };
  }
  return { status: 200 as const, body: toUserResponse(user) };
};

export const handleAdminUpdateUser = async (userIdRaw: string, input: UpdateUserInput) => {
  const { name, email, disabled } = input;

  const existing = await prisma.user.findUnique({ where: { id: Number(userIdRaw) } });
  if (!existing) {
    return { status: 404 as const, body: { message: 'User not found' } };
  }

  const updated = await prisma.user.update({
    where: { id: Number(userIdRaw) },
    data: {
      ...(name !== undefined && { name }),
      ...(email !== undefined && { email: email.toLowerCase() }),
      ...(disabled !== undefined && { disabled }),
    },
  });

  return { status: 200 as const, body: toUserResponse(updated) };
};

// Silence unused-imports lint where applicable.
export type _Unused = OrganisationMemberRole;
