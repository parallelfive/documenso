// P5 patch: zod schemas for the /api/v1/admin/* surface (org + user CRUD).
// See parallelfive/documenso P5_PATCHES.md § Patch 1.

import { OrganisationMemberRole, OrganisationType, Role } from '@prisma/client';
import { z } from 'zod';

import { zEmail } from '@documenso/lib/utils/zod';

// ---------- shared ----------

export const ZAdminUnsuccessfulResponseSchema = z.object({
  message: z.string(),
});

// ---------- organisations ----------

export const ZAdminOrganisationResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  type: z.nativeEnum(OrganisationType),
  ownerUserId: z.number(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const ZAdminCreateOrganisationRequestSchema = z.object({
  name: z.string().min(1).max(255),
  ownerEmail: zEmail.describe(
    'Email of the user who will own the new organisation. The user must already exist; create them via POST /api/v1/admin/users first if needed.',
  ),
  url: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe('URL slug for the organisation. Auto-generated from name if omitted.'),
  type: z.nativeEnum(OrganisationType).default(OrganisationType.ORGANISATION),
});

export const ZAdminListOrganisationsQuerySchema = z.object({
  page: z.coerce.number().min(1).optional().default(1),
  perPage: z.coerce.number().min(1).max(100).optional().default(20),
  ownerEmail: zEmail.optional().describe('Filter by owner email.'),
});

export const ZAdminListOrganisationsResponseSchema = z.object({
  organisations: z.array(ZAdminOrganisationResponseSchema),
  totalPages: z.number(),
});

export const ZAdminUpdateOrganisationRequestSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  url: z.string().min(1).max(255).optional(),
});

export const ZAdminDeleteOrganisationResponseSchema = z.object({
  success: z.literal(true),
});

// ---------- organisation members ----------

export const ZAdminAddOrganisationMemberRequestSchema = z.object({
  email: zEmail.describe(
    'Email of the user to add. The user must already exist; create them via POST /api/v1/admin/users first if needed.',
  ),
  role: z.nativeEnum(OrganisationMemberRole).default(OrganisationMemberRole.MEMBER),
});

export const ZAdminOrganisationMemberResponseSchema = z.object({
  id: z.string(),
  userId: z.number(),
  email: z.string(),
  name: z.string().nullable(),
  organisationId: z.string(),
  createdAt: z.date(),
});

export const ZAdminRemoveOrganisationMemberResponseSchema = z.object({
  success: z.literal(true),
});

// ---------- users ----------

export const ZAdminUserResponseSchema = z.object({
  id: z.number(),
  email: z.string(),
  name: z.string().nullable(),
  roles: z.array(z.nativeEnum(Role)),
  disabled: z.boolean(),
  createdAt: z.date(),
});

export const ZAdminCreateUserRequestSchema = z.object({
  email: zEmail,
  name: z.string().min(1).max(255),
  password: z
    .string()
    .min(8)
    .max(128)
    .optional()
    .describe(
      'Initial password. If omitted, a random one is generated; the user must reset via the forgot-password flow before signing in.',
    ),
});

export const ZAdminListUsersQuerySchema = z.object({
  page: z.coerce.number().min(1).optional().default(1),
  perPage: z.coerce.number().min(1).max(100).optional().default(20),
  email: zEmail.optional().describe('Exact email match.'),
});

export const ZAdminListUsersResponseSchema = z.object({
  users: z.array(ZAdminUserResponseSchema),
  totalPages: z.number(),
});

export const ZAdminUpdateUserRequestSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  email: zEmail.optional(),
  disabled: z.boolean().optional(),
});
