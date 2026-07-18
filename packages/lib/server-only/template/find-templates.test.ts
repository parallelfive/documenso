import { TeamMemberRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { buildFindTemplatesWhere } from './find-templates';

describe('buildFindTemplatesWhere', () => {
  it('binds both count and pagination to the API token team despite owner access', () => {
    const where = buildFindTemplatesWhere({
      userId: 7,
      teamId: 9,
      teamRole: TeamMemberRole.ADMIN,
    });

    expect(where).toMatchObject({
      type: 'TEMPLATE',
      AND: [
        { teamId: 9 },
        {
          OR: [
            {
              visibility: {
                in: expect.any(Array),
              },
            },
            { userId: 7, teamId: 9 },
          ],
        },
        { folderId: null },
      ],
    });
  });
});
