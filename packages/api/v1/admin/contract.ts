// P5 patch: ts-rest contract for /api/v1/admin/* (org + user CRUD).
//
// Spread into the main ApiContractV1 in ../contract.ts. Auto-published in
// /api/v1/openapi.json via the existing generateOpenApi() pipeline.
//
// See parallelfive/documenso P5_PATCHES.md § Patch 1.

import { initContract } from '@ts-rest/core';

import {
  ZAdminAddOrganisationMemberRequestSchema,
  ZAdminCreateOrganisationRequestSchema,
  ZAdminCreateUserRequestSchema,
  ZAdminDeleteOrganisationResponseSchema,
  ZAdminListOrganisationsQuerySchema,
  ZAdminListOrganisationsResponseSchema,
  ZAdminListUsersQuerySchema,
  ZAdminListUsersResponseSchema,
  ZAdminOrganisationMemberResponseSchema,
  ZAdminOrganisationResponseSchema,
  ZAdminRemoveOrganisationMemberResponseSchema,
  ZAdminUnsuccessfulResponseSchema,
  ZAdminUpdateOrganisationRequestSchema,
  ZAdminUpdateUserRequestSchema,
  ZAdminUserResponseSchema,
} from './schema';

const c = initContract();

const adminDescription =
  'Parallel Five fork extension. Requires an API token belonging to a user with the global ADMIN role. Not part of the upstream Documenso public API.';

export const AdminContract = {
  // ---------- organisations ----------

  adminCreateOrganisation: {
    method: 'POST' as const,
    path: '/api/v1/admin/organisations',
    body: ZAdminCreateOrganisationRequestSchema,
    responses: {
      200: ZAdminOrganisationResponseSchema,
      401: ZAdminUnsuccessfulResponseSchema,
      404: ZAdminUnsuccessfulResponseSchema,
      409: ZAdminUnsuccessfulResponseSchema,
    },
    summary: 'Create an organisation owned by an arbitrary user',
    description: adminDescription,
  },

  adminListOrganisations: {
    method: 'GET' as const,
    path: '/api/v1/admin/organisations',
    query: ZAdminListOrganisationsQuerySchema,
    responses: {
      200: ZAdminListOrganisationsResponseSchema,
      401: ZAdminUnsuccessfulResponseSchema,
    },
    summary: 'List organisations',
    description: adminDescription,
  },

  adminGetOrganisation: {
    method: 'GET' as const,
    path: '/api/v1/admin/organisations/:organisationId',
    responses: {
      200: ZAdminOrganisationResponseSchema,
      401: ZAdminUnsuccessfulResponseSchema,
      404: ZAdminUnsuccessfulResponseSchema,
    },
    summary: 'Get a single organisation',
    description: adminDescription,
  },

  adminUpdateOrganisation: {
    method: 'PATCH' as const,
    path: '/api/v1/admin/organisations/:organisationId',
    body: ZAdminUpdateOrganisationRequestSchema,
    responses: {
      200: ZAdminOrganisationResponseSchema,
      401: ZAdminUnsuccessfulResponseSchema,
      404: ZAdminUnsuccessfulResponseSchema,
    },
    summary: 'Update an organisation (name and/or url)',
    description: adminDescription,
  },

  adminDeleteOrganisation: {
    method: 'DELETE' as const,
    path: '/api/v1/admin/organisations/:organisationId',
    body: null,
    responses: {
      200: ZAdminDeleteOrganisationResponseSchema,
      401: ZAdminUnsuccessfulResponseSchema,
      404: ZAdminUnsuccessfulResponseSchema,
    },
    summary: 'Delete an organisation',
    description: `${adminDescription} \n\nDeletes the organisation and all dependent teams + envelopes. Use with caution.`,
  },

  // ---------- organisation members ----------

  adminAddOrganisationMember: {
    method: 'POST' as const,
    path: '/api/v1/admin/organisations/:organisationId/members',
    body: ZAdminAddOrganisationMemberRequestSchema,
    responses: {
      200: ZAdminOrganisationMemberResponseSchema,
      401: ZAdminUnsuccessfulResponseSchema,
      404: ZAdminUnsuccessfulResponseSchema,
      409: ZAdminUnsuccessfulResponseSchema,
    },
    summary: 'Add a user to an organisation as a member',
    description: `${adminDescription} \n\nAdds the user directly without going through the invitation flow. The user must already exist.`,
  },

  adminRemoveOrganisationMember: {
    method: 'DELETE' as const,
    path: '/api/v1/admin/organisations/:organisationId/members/:userId',
    body: null,
    responses: {
      200: ZAdminRemoveOrganisationMemberResponseSchema,
      401: ZAdminUnsuccessfulResponseSchema,
      404: ZAdminUnsuccessfulResponseSchema,
    },
    summary: 'Remove a member from an organisation',
    description: adminDescription,
  },

  // ---------- users ----------

  adminCreateUser: {
    method: 'POST' as const,
    path: '/api/v1/admin/users',
    body: ZAdminCreateUserRequestSchema,
    responses: {
      200: ZAdminUserResponseSchema,
      401: ZAdminUnsuccessfulResponseSchema,
      409: ZAdminUnsuccessfulResponseSchema,
    },
    summary: 'Create a user',
    description: `${adminDescription} \n\nMirrors the public sign-up flow but bypasses email verification + signup-disabled checks. The user is created with the default USER role.`,
  },

  adminListUsers: {
    method: 'GET' as const,
    path: '/api/v1/admin/users',
    query: ZAdminListUsersQuerySchema,
    responses: {
      200: ZAdminListUsersResponseSchema,
      401: ZAdminUnsuccessfulResponseSchema,
    },
    summary: 'List users',
    description: adminDescription,
  },

  adminGetUser: {
    method: 'GET' as const,
    path: '/api/v1/admin/users/:userId',
    responses: {
      200: ZAdminUserResponseSchema,
      401: ZAdminUnsuccessfulResponseSchema,
      404: ZAdminUnsuccessfulResponseSchema,
    },
    summary: 'Get a single user',
    description: adminDescription,
  },

  adminUpdateUser: {
    method: 'PATCH' as const,
    path: '/api/v1/admin/users/:userId',
    body: ZAdminUpdateUserRequestSchema,
    responses: {
      200: ZAdminUserResponseSchema,
      401: ZAdminUnsuccessfulResponseSchema,
      404: ZAdminUnsuccessfulResponseSchema,
    },
    summary: 'Update a user',
    description: adminDescription,
  },
};
