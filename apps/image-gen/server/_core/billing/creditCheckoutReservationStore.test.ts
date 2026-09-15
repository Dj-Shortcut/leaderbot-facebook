import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  billingExecutionControls,
  billingSchedulerTenants,
} from "../../../drizzle/schema";

const { database } = vi.hoisted(() => ({ database: vi.fn() }));
vi.mock("../../db", () => ({ getDatabaseOrThrow: database }));

import { readCreditCheckoutAuthorization } from "./creditCheckoutReservationStore";
import {
  CreditCheckoutReservationError,
  reserveMessengerCreditCheckout,
} from "./creditCheckoutReservationService";

type AuthorizationRow = {
  commercialEnabled: boolean;
  authorizationEpoch: number;
  outboxEnabled: boolean;
  executionEpoch: number;
};
const enabled: AuthorizationRow = {
  commercialEnabled: true,
  authorizationEpoch: 2,
  outboxEnabled: true,
  executionEpoch: 2,
};

function harness(rows: AuthorizationRow[]) {
  const query = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  database.mockResolvedValue(query);
  return query;
}

beforeEach(() => vi.clearAllMocks());

describe("checkout reservation authorization store/service boundary", () => {
  it("joins only the same workspace/mode outbox and returns a frozen positive epoch", async () => {
    const query = harness([enabled]);
    const result = await readCreditCheckoutAuthorization({
      workspaceId: 42,
      mode: "test",
    });
    expect(result).toEqual({ authorizationEpoch: 2 });
    expect(Object.isFrozen(result)).toBe(true);
    expect(query.from).toHaveBeenCalledWith(billingExecutionControls);
    expect(query.innerJoin.mock.calls[0][0]).toBe(billingSchedulerTenants);
    const dialect = new MySqlDialect();
    expect(dialect.sqlToQuery(query.innerJoin.mock.calls[0][1])).toMatchObject({
      sql: "(`billing_scheduler_tenants`.`workspace_id` = `billing_execution_controls`.`workspace_id` and `billing_scheduler_tenants`.`mode` = `billing_execution_controls`.`mode` and `billing_scheduler_tenants`.`kind` = ?)",
      params: ["outbox"],
    });
    expect(dialect.sqlToQuery(query.where.mock.calls[0][0])).toMatchObject({
      sql: "(`billing_execution_controls`.`workspace_id` = ? and `billing_execution_controls`.`mode` = ?)",
      params: [42, "test"],
    });
    expect(query.limit).toHaveBeenCalledWith(2);
  });

  it.each([
    ["missing outbox", []],
    ["disabled outbox", [{ ...enabled, outboxEnabled: false }]],
    ["stale outbox epoch", [{ ...enabled, executionEpoch: 1 }]],
    ["future outbox epoch", [{ ...enabled, executionEpoch: 3 }]],
    ["disabled commercial control", [{ ...enabled, commercialEnabled: false }]],
    ["ambiguous rows", [enabled, enabled]],
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN].map(epoch => [
      `invalid matching epoch ${epoch}`,
      [{ ...enabled, authorizationEpoch: epoch, executionEpoch: epoch }],
    ]),
  ] as [string, AuthorizationRow[]][])(
    "rejects %s before wallet access or CTA reservation",
    async (_label, rows) => {
      harness(rows);
      const readWalletIdentity = vi.fn();
      const reserve = vi.fn();
      const withKeyring = vi.fn();
      const input = {
        workspaceId: 42,
        channelConnectionId: 8,
        bindingEpoch: 1,
        privacyEpoch: 1,
        userKey: `u2.k1.${"b".repeat(64)}`,
        requestId: "second-user",
      };
      await expect(
        reserveMessengerCreditCheckout(input, {
          config: () => ({
            checkoutEnabled: true,
            paidCreditsEnabled: true,
            workspaceId: 42,
            mode: "test",
            paidImageProviderMaxCostUsd: 1,
            testPilotScope: null,
          }),
          readAuthorization: readCreditCheckoutAuthorization,
          readWalletIdentity,
          reserve,
          withKeyring,
          now: () => new Date(),
          appBaseUrl: () => new URL("https://app.leaderbot.live"),
        })
      ).rejects.toBeInstanceOf(CreditCheckoutReservationError);
      expect(readWalletIdentity).not.toHaveBeenCalled();
      expect(withKeyring).not.toHaveBeenCalled();
      expect(reserve).not.toHaveBeenCalled();
    }
  );
});
