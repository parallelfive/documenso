// P5 patch: admin-only middleware for the /api/v1/admin/* surface.
//
// Layers on top of the existing authenticatedMiddleware so we re-use API
// token resolution, but additionally requires that the API token's owner
// has the global Role.ADMIN. Used by the parallelfive/documenso fork's
// admin REST endpoints (org + user CRUD) so biz-buddy can provision
// orgs / mirror users via a single platform-scoped admin token rather
// than per-user tokens.
//
// See parallelfive/documenso P5_PATCHES.md § Patch 1.

import { Role, type Team, type User } from '@prisma/client';
import type { TsRestRequest } from '@ts-rest/serverless';
import type { Logger } from 'pino';

import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { getApiTokenByToken } from '@documenso/lib/server-only/public-api/get-api-token-by-token';
import type { BaseApiLog, RootApiLog } from '@documenso/lib/types/api-logs';
import type { ApiRequestMetadata } from '@documenso/lib/universal/extract-request-metadata';
import { extractRequestMetadata } from '@documenso/lib/universal/extract-request-metadata';
import { nanoid } from '@documenso/lib/universal/id';
import { logger } from '@documenso/lib/utils/logger';
import { prisma } from '@documenso/prisma';

type B = {
  request: TsRestRequest;
  responseHeaders: Headers;
};

export const adminAuthenticatedMiddleware = <
  T extends {
    headers: {
      authorization: string;
    };
  },
  R extends {
    status: number;
    body: unknown;
  },
>(
  handler: (
    args: T & { req: TsRestRequest },
    user: Pick<User, 'id' | 'email' | 'name' | 'disabled' | 'roles'>,
    team: Team,
    options: { metadata: ApiRequestMetadata; logger: Logger },
  ) => Promise<R>,
) => {
  return async (args: T, { request }: B) => {
    const requestMetadata = extractRequestMetadata(request);

    const apiLogger = logger.child({
      ipAddress: requestMetadata.ipAddress,
      userAgent: requestMetadata.userAgent,
      requestId: nanoid(),
    } satisfies RootApiLog);

    const infoToLog: BaseApiLog = {
      auth: 'api',
      source: 'apiV1',
      path: request.url,
    };

    try {
      const { authorization } = args.headers;

      const [token] = (authorization || '').split('Bearer ').filter((s) => s.length > 0);

      if (!token) {
        throw new AppError(AppErrorCode.UNAUTHORIZED, {
          message: 'API token was not provided',
        });
      }

      const apiToken = await getApiTokenByToken({ token });

      if (apiToken.user.disabled) {
        throw new AppError(AppErrorCode.UNAUTHORIZED, {
          message: 'User is disabled',
        });
      }

      // Upstream's getApiTokenByToken doesn't include `roles` in its user
      // select, so we re-fetch it here. Keeping this in the middleware keeps
      // the patch self-contained (no upstream-file modification).
      const userWithRoles = await prisma.user.findUniqueOrThrow({
        where: { id: apiToken.user.id },
        select: { id: true, email: true, name: true, disabled: true, roles: true },
      });

      if (!userWithRoles.roles.includes(Role.ADMIN)) {
        apiLogger.warn({
          ...infoToLog,
          userId: apiToken.user.id,
          apiTokenId: apiToken.id,
          msg: 'admin endpoint access denied — user is not ADMIN',
        });

        throw new AppError(AppErrorCode.UNAUTHORIZED, {
          message: 'Admin role required',
        });
      }

      apiLogger.info({
        ...infoToLog,
        userId: apiToken.user.id,
        apiTokenId: apiToken.id,
      } satisfies BaseApiLog);

      const metadata: ApiRequestMetadata = {
        requestMetadata,
        source: 'apiV1',
        auth: 'api',
        auditUser: {
          id: apiToken.team ? null : apiToken.user.id,
          email: apiToken.team ? null : apiToken.user.email,
          name: apiToken.team?.name ?? apiToken.user.name,
        },
      };

      return await handler(
        {
          ...args,
          req: request,
        },
        userWithRoles,
        apiToken.team,
        { metadata, logger: apiLogger },
      );
    } catch (err) {
      apiLogger.info(infoToLog);

      let message = 'Unauthorized';

      if (err instanceof AppError) {
        message = err.message;
      }

      return {
        status: 401,
        body: {
          message,
        },
      } as const;
    }
  };
};
