/** Server-owned credential runtime; the external MCP transport remains issue #9. */
import { OwnerSessions, type OwnerSessionsHandle } from './ownerSessions.ts';
import { GrantService } from './grantService.ts';
import { OWNER_ID_PATTERN } from './config.ts';
import type { FactoryMatch } from './match.ts';
import { McpGateway } from './mcp/McpGateway.ts';
import { openDatabase, closeDatabase } from './persistence/database.ts';
import { migrate } from './persistence/migrations.ts';
import { createRepositories } from './persistence/repos/index.ts';
import type { MatchStore } from './persistence/matchStore.ts';

export interface McpRuntime {
  readonly sessions: OwnerSessionsHandle;
  readonly grants: GrantService;
  readonly gateway: McpGateway;
  close(): void;
}

export function createMcpRuntime(options: {
  readonly ownerId: string;
  readonly ownerSecret: string;
  readonly match: FactoryMatch;
  readonly store?: MatchStore;
  readonly now?: () => number;
}): McpRuntime {
  if (!OWNER_ID_PATTERN.test(options.ownerId)) {
    throw new Error('MCP ownerId must be 1-64 ASCII letters, digits, underscores or dashes.');
  }
  const now = options.now ?? Date.now;
  const sessions = OwnerSessions({ ownerId: options.ownerId, ownerSecret: options.ownerSecret, now });
  const database = options.store?.database ?? openDatabase(':memory:');
  const ownsDatabase = options.store === undefined;
  try {
    if (ownsDatabase) migrate(database);
    const repositories = createRepositories(database);
    const company = options.match.getServerCompany();
    if (!repositories.companies.load(company.companyId)) repositories.saveCompanyState(company);
    const grants = new GrantService({ repositories, ownerId: options.ownerId,
      matchId: options.match.matchId, companyId: company.companyId,
      allowedLineIds: company.lines.map(line => line.lineId), now: () => new Date(now()) });
    let closed = false;
    const gateway = new McpGateway(options.match.engine, {
      matchId: options.match.matchId, companyPlayers: { [company.companyId]: options.ownerId },
    }, {
      now,
      resolveGrant: token => closed ? undefined : grants.resolve(token),
      submitCommand: command => options.match.submitMcpCommand(command),
    });
    return { sessions, grants, gateway, close: () => {
      if (closed) return;
      closed = true;
      if (ownsDatabase) closeDatabase(database);
    } };
  } catch (error) {
    if (ownsDatabase) closeDatabase(database);
    throw error;
  }
}
